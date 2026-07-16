import { ok } from "../src/core/result";
import { BackgroundJobRegistry, type TaskOwner } from "../src/tasks/background-jobs";
import { TaskAccess } from "../src/tasks/task-access";
import type { TaskRecord } from "../src/tasks/types";
import {
  GatedTaskPersistence,
  MemoryTaskPersistence,
  deferred,
  managerHarness,
  request
} from "./fixtures/task-manager-harness";

const LIMITS = { enabled: true, maxActive: 4, maxChildrenPerRoot: 16, defaultTimeoutMs: 30_000, maxInlineResultChars: 12_000 } as const;

function owner(id: string): TaskOwner { return Object.freeze({ parentSessionId: id, rootSessionId: id }); }

async function flushMicrotasks(): Promise<void> { for (let index = 0; index < 20; index += 1) await Promise.resolve(); }

class TrackingPersistence extends MemoryTaskPersistence {
  listCalls = 0;

  override async list() {
    this.listCalls += 1;
    return super.list();
  }
}

class SnapshotGatedPersistence extends MemoryTaskPersistence {
  private gate: Readonly<{ entered: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> }> | undefined;

  blockNextList(): { readonly entered: Promise<void>; readonly release: () => void } {
    const entered = deferred<void>();
    const release = deferred<void>();
    this.gate = { entered, release };
    return { entered: entered.promise, release: () => release.resolve(undefined) };
  }

  override async list() {
    const snapshot = await super.list();
    const gate = this.gate;
    this.gate = undefined;
    if (gate) {
      gate.entered.resolve(undefined);
      await gate.release.promise;
    }
    return snapshot;
  }
}

describe("background lifecycle rejection regressions", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps shutdown pending until an admission-gated start is cancelled and settled", async () => {
    // Given
    const persistence = new GatedTaskPersistence();
    const gate = persistence.blockNextList();
    let runnerCalls = 0;
    const { manager } = await managerHarness({
      taskStore: persistence,
      createRunner: () => ({
        run: async (_agent, _prompt, sessionId) => {
          runnerCalls += 1;
          return ok({ sessionId, response: "must not run", toolExecutions: [] });
        }
      })
    });
    const starting = manager.startBackground(request("root-shutdown-admission", "gated"));
    await gate.entered;

    // When
    let shutdownSettled = false;
    const shuttingDown = manager.shutdown().then(result => {
      shutdownSettled = true;
      return result;
    });
    await flushMicrotasks();
    const settledBeforeRelease = shutdownSettled;
    gate.release();
    const [started, shutdown] = await Promise.all([starting, shuttingDown]);

    // Then
    expect(settledBeforeRelease).toBe(false);
    expect(shutdown).toEqual({ ok: true, value: undefined });
    expect(started).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    expect(runnerCalls).toBe(0);
    expect(persistence.snapshot().every(record => !["queued", "running", "blocked"].includes(record.status))).toBe(true);
  });

  it("keeps root cancellation pending until an admission-gated start is cancelled and settled", async () => {
    // Given
    const persistence = new GatedTaskPersistence();
    const gate = persistence.blockNextList();
    let runnerCalls = 0;
    const { manager } = await managerHarness({
      taskStore: persistence,
      createRunner: () => ({
        run: async (_agent, _prompt, sessionId) => {
          runnerCalls += 1;
          return ok({ sessionId, response: "escaped", toolExecutions: [] });
        }
      })
    });
    const starting = manager.startBackground(request("root-cancel-admission", "gated"));
    await gate.entered;

    // When
    let cancellationSettled = false;
    const cancelling = manager.cancelRoot("root-cancel-admission").then(result => {
      cancellationSettled = true;
      return result;
    });
    await flushMicrotasks();
    const settledBeforeRelease = cancellationSettled;
    gate.release();
    const [started] = await Promise.all([starting, cancelling]);
    if (started.ok) await manager.waitForTasks(owner("root-cancel-admission"), [started.value.taskId]);

    // Then
    expect(settledBeforeRelease).toBe(false);
    expect(runnerCalls).toBe(0);
    expect(persistence.snapshot().every(record => !["queued", "running", "blocked", "succeeded"].includes(record.status))).toBe(true);
  });

  it("serializes inherited write ownership before admitting a continuation", async () => {
    // Given
    const persistence = new TrackingPersistence();
    const firstGate = deferred<void>();
    const firstEntered = deferred<void>();
    const calls: Array<{ readonly prompt: string; readonly ownership: readonly string[] }> = [];
    let active = 0;
    let maximumActive = 0;
    const { manager } = await managerHarness({
      taskStore: persistence,
      limits: LIMITS,
      createRunner: context => ({
        run: async (_agent, prompt, sessionId) => {
          calls.push({ prompt, ownership: context.ownership ?? [] });
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          if (prompt === "first") {
            firstEntered.resolve(undefined);
            await firstGate.promise;
          }
          active -= 1;
          return ok({ sessionId, response: prompt, toolExecutions: [] });
        }
      })
    });
    const first = await manager.startBackground(request("root-write-continuation", "first", {
      writePaths: ["src/write-continuation.ts"]
    }));
    if (!first.ok) throw first.error;
    await firstEntered.promise;
    const listCallsBeforeContinuation = persistence.listCalls;

    // When
    const continued = await manager.continueBackground({
      ...owner("root-write-continuation"),
      childSessionId: first.value.childSessionId,
      taskUserContent: "second"
    });
    await flushMicrotasks();
    const listCallsBeforeRelease = persistence.listCalls;
    if (!continued.ok) throw continued.error;
    firstGate.resolve(undefined);
    const results = await manager.waitForTasks(owner("root-write-continuation"), [first.value.taskId, continued.value.taskId]);

    // Then
    expect(listCallsBeforeRelease).toBe(listCallsBeforeContinuation);
    expect(results).toMatchObject({ ok: true, value: [{ status: "succeeded" }, { status: "succeeded" }] });
    expect(calls.map(call => call.prompt)).toEqual(["first", "second"]);
    expect(calls[1]?.ownership).toEqual(calls[0]?.ownership);
    expect(maximumActive).toBe(1);
  });

  it("preserves one absolute timeout while a continuation waits for its turn", async () => {
    // Given
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
    const firstGate = deferred<void>();
    const firstEntered = deferred<void>();
    let runnerCalls = 0;
    const { manager } = await managerHarness({
      limits: LIMITS,
      createRunner: () => ({
        run: async (_agent, prompt, sessionId) => {
          runnerCalls += 1;
          if (prompt === "first") {
            firstEntered.resolve(undefined);
            await firstGate.promise;
          }
          return ok({ sessionId, response: prompt, toolExecutions: [] });
        }
      })
    });
    const first = await manager.startBackground(request("root-continuation-deadline", "first", {
      writePaths: []
    }));
    if (!first.ok) throw first.error;
    await firstEntered.promise;
    const continued = await manager.continueBackground({
      ...owner("root-continuation-deadline"),
      childSessionId: first.value.childSessionId,
      taskUserContent: "timed",
      timeoutMs: 100
    });
    if (!continued.ok) throw continued.error;
    const waiting = manager.waitForTasks(owner("root-continuation-deadline"), [continued.value.taskId]);

    // When
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(101);
    firstGate.resolve(undefined);
    const timed = await waiting;
    await manager.waitForTasks(owner("root-continuation-deadline"), [first.value.taskId]);

    // Then
    expect(timed).toMatchObject({ ok: true, value: [{ status: "timed_out", error: { code: "TASK_ERROR" } }] });
    expect(runnerCalls).toBe(1);
  });

  it("evicts terminal active state and purges its profile when the root is revoked", async () => {
    // Given
    const signals: AbortSignal[] = [];
    const { manager } = await managerHarness({
      createRunner: context => ({
        run: async (_agent, prompt, sessionId) => {
          if (context.signal) signals.push(context.signal);
          return ok({ sessionId, response: prompt, toolExecutions: [] });
        }
      })
    });
    const first = await manager.startBackground(request("root-terminal-eviction", "first"));
    if (!first.ok) throw first.error;
    await manager.waitForTasks(owner("root-terminal-eviction"), [first.value.taskId]);

    // When
    const cancelled = await manager.cancelRoot("root-terminal-eviction");
    const continued = await manager.continueBackground({
      ...owner("root-terminal-eviction"),
      childSessionId: first.value.childSessionId,
      taskUserContent: "continued"
    });

    // Then
    expect(cancelled).toEqual({ ok: true, value: [] });
    expect(signals[0]?.aborted).toBe(false);
    expect(continued).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
  });

  it("rereads durable terminal state when an active job is evicted after wait snapshots ownership", async () => {
    // Given
    const persistence = new SnapshotGatedPersistence();
    const access = new TaskAccess(persistence, new BackgroundJobRegistry());
    const timestamp = "2026-07-15T00:00:00.000Z";
    const running: TaskRecord = {
      id: "task-123e4567-e89b-42d3-a456-426614174099",
      childSessionId: "child-wait-eviction",
      parentSessionId: "root-wait-eviction",
      rootSessionId: "root-wait-eviction",
      target: { class: "helper", id: "explore" },
      attempt: 1,
      depth: 1,
      mode: "background",
      model: "mock",
      effectivePolicyHash: "a".repeat(64),
      skillReceipts: [],
      ownedPaths: [],
      timestamps: { createdAt: timestamp, updatedAt: timestamp, startedAt: timestamp },
      status: "running"
    };
    await persistence.write(running);
    const gate = persistence.blockNextList();
    const waiting = access.wait(owner("root-wait-eviction"), [running.id]);
    await gate.entered;

    // When
    await persistence.write({
      ...running,
      status: "succeeded",
      timestamps: { ...running.timestamps, updatedAt: timestamp, completedAt: timestamp },
      resultMetadata: { summary: "durable", outputChars: 7, truncated: false },
      artifactPointer: "sessions/child-wait-eviction.jsonl"
    });
    gate.release();
    const result = await waiting;

    // Then
    expect(result).toMatchObject({ ok: true, value: [{ status: "succeeded", text: "durable" }] });
  });
});
