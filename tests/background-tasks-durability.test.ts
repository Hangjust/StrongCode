import { StrongCodeError } from "../src/core/errors";
import { err, ok, type Result } from "../src/core/result";
import type { AgentRunResult } from "../src/core/types";
import type { ToolInvocationContext } from "../src/runtime/context";
import type { TaskPersistence } from "../src/tasks/admission";
import type { TaskOwner } from "../src/tasks/background-jobs";
import type { ContinuationTaskRequest } from "../src/tasks/task-manager";
import { deferred, managerHarness, MemoryTaskPersistence, request } from "./fixtures/task-manager-harness";

function owner(id: string): TaskOwner { return Object.freeze({ parentSessionId: id, rootSessionId: id }); }

async function flushMicrotasks(): Promise<void> { for (let index = 0; index < 20; index += 1) await Promise.resolve(); }

function activeTimeouts(): number { return process.getActiveResourcesInfo().filter(resource => resource === "Timeout").length; }

class BlockingRuns {
  readonly prompts: string[] = [];
  readonly entered = deferred<void>();
  private readonly releaseGate = deferred<void>();

  createRunner = (context: ToolInvocationContext) => ({
    run: async (_agent: object, prompt: string, sessionId: string): Promise<Result<AgentRunResult>> => {
      this.prompts.push(prompt);
      if (this.prompts.length > 1) return ok({ sessionId, response: prompt, toolExecutions: [] });
      this.entered.resolve(undefined);
      return new Promise(resolve => {
        this.releaseGate.promise.then(() => resolve(ok({ sessionId, response: prompt, toolExecutions: [] })));
        context.signal?.addEventListener("abort", () => resolve(err(new StrongCodeError("CANCELLED", "stopped"))), { once: true });
      });
    }
  });

  release(): void { this.releaseGate.resolve(undefined); }
}


describe("background continuation durability", () => {
  afterEach(() => vi.useRealTimers());

  it("publishes a continuation handle only after its durable blocked record", async () => {
    // Given
    const runs = new BlockingRuns();
    const persistence = new MemoryTaskPersistence();
    const { manager } = await managerHarness({ taskStore: persistence, createRunner: runs.createRunner });
    const first = await manager.startBackground(request("root-blocked", "first"));
    if (!first.ok) throw first.error;
    await runs.entered.promise;

    // When
    const continued = await manager.continueBackground({ ...owner("root-blocked"), childSessionId: first.value.childSessionId, taskUserContent: "second" });

    // Then
    if (!continued.ok) throw continued.error;
    expect(await manager.getTaskStatus(owner("root-blocked"), continued.value.taskId)).toMatchObject({ ok: true, value: { status: "blocked", attempt: 2 } });
    runs.release();
    await manager.waitForTasks(owner("root-blocked"), [first.value.taskId, continued.value.taskId]);
  });

  it("persists queued cancellation as a retrievable cancelled result", async () => {
    // Given
    const runs = new BlockingRuns();
    const { manager } = await managerHarness({ createRunner: runs.createRunner });
    const first = await manager.startBackground(request("root-cancel-durable", "first"));
    if (!first.ok) throw first.error;
    await runs.entered.promise;
    const continued = await manager.continueBackground({ ...owner("root-cancel-durable"), childSessionId: first.value.childSessionId, taskUserContent: "second" });
    if (!continued.ok) throw continued.error;

    // When
    const cancelled = await manager.cancelTask(owner("root-cancel-durable"), continued.value.taskId);
    const durable = await manager.getTaskResult(owner("root-cancel-durable"), continued.value.taskId);

    // Then
    expect(cancelled).toMatchObject({ ok: true, value: { status: "cancelled" } });
    expect(durable).toMatchObject({ ok: true, value: { status: "cancelled" } });
    runs.release();
    await manager.waitForTasks(owner("root-cancel-durable"), [first.value.taskId]);
  });

  it("persists a queued continuation timeout from its original absolute deadline", async () => {
    // Given
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
    const runs = new BlockingRuns();
    const { manager } = await managerHarness({ createRunner: runs.createRunner });
    const first = await manager.startBackground(request("root-timeout-durable", "first"));
    if (!first.ok) throw first.error;
    await runs.entered.promise;
    const continued = await manager.continueBackground({ ...owner("root-timeout-durable"), childSessionId: first.value.childSessionId, taskUserContent: "second", timeoutMs: 100 });
    if (!continued.ok) throw continued.error;

    // When
    await vi.advanceTimersByTimeAsync(101);
    const durable = await manager.getTaskResult(owner("root-timeout-durable"), continued.value.taskId);

    // Then
    expect(durable).toMatchObject({ ok: true, value: { status: "timed_out" } });
    expect(runs.prompts).toEqual(["first"]);
    runs.release();
    await manager.waitForTasks(owner("root-timeout-durable"), [first.value.taskId]);
  });

  it("removes a cancelled middle FIFO entry and lets the third turn proceed", async () => {
    // Given
    const runs = new BlockingRuns();
    const { manager } = await managerHarness({ createRunner: runs.createRunner });
    const first = await manager.startBackground(request("root-middle-fifo", "first"));
    if (!first.ok) throw first.error;
    await runs.entered.promise;
    const second = await manager.continueBackground({ ...owner("root-middle-fifo"), childSessionId: first.value.childSessionId, taskUserContent: "second" });
    const third = await manager.continueBackground({ ...owner("root-middle-fifo"), childSessionId: first.value.childSessionId, taskUserContent: "third" });
    if (!second.ok) throw second.error;
    if (!third.ok) throw third.error;

    // When
    const cancelled = await manager.cancelTask(owner("root-middle-fifo"), second.value.taskId);
    runs.release();
    const completed = await manager.waitForTasks(owner("root-middle-fifo"), [first.value.taskId, third.value.taskId]);

    // Then
    expect(cancelled).toMatchObject({ ok: true, value: { status: "cancelled" } });
    expect(completed).toMatchObject({ ok: true, value: [{ status: "succeeded" }, { status: "succeeded" }] });
    expect(runs.prompts).toEqual(["first", "third"]);
  });

  it("atomically revokes a root, purges profiles, and leaves another root usable", async () => {
    // Given
    const runs = new BlockingRuns();
    const { manager } = await managerHarness({ createRunner: runs.createRunner });
    const first = await manager.startBackground(request("root-revoked", "first"));
    if (!first.ok) throw first.error;
    await runs.entered.promise;
    const blocked = await manager.continueBackground({ ...owner("root-revoked"), childSessionId: first.value.childSessionId, taskUserContent: "blocked" });
    if (!blocked.ok) throw blocked.error;

    // When
    const cancelled = await manager.cancelRoot("root-revoked");
    const restarted = await manager.startBackground(request("root-revoked", "restarted"));
    const resumed = await manager.continueBackground({ ...owner("root-revoked"), childSessionId: first.value.childSessionId, taskUserContent: "resumed" });
    const other = await manager.startBackground(request("root-other", "other"));
    if (restarted.ok) await manager.waitForTasks(owner("root-revoked"), [restarted.value.taskId]);
    if (resumed.ok) await manager.waitForTasks(owner("root-revoked"), [resumed.value.taskId]);
    if (!other.ok) throw other.error;

    // Then
    expect(cancelled).toMatchObject({ ok: true, value: [{ status: "cancelled" }, { status: "cancelled" }] });
    expect(restarted).toMatchObject({ ok: false });
    expect(resumed).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    expect(await manager.waitForTasks(owner("root-other"), [other.value.taskId])).toMatchObject({ ok: true, value: [{ status: "succeeded" }] });
  });

  it("shutdown durably terminalizes a published blocked continuation", async () => {
    // Given
    const runs = new BlockingRuns();
    const { manager } = await managerHarness({ createRunner: runs.createRunner });
    const first = await manager.startBackground(request("root-shutdown-durable", "first"));
    if (!first.ok) throw first.error;
    await runs.entered.promise;
    const blocked = await manager.continueBackground({ ...owner("root-shutdown-durable"), childSessionId: first.value.childSessionId, taskUserContent: "blocked" });
    if (!blocked.ok) throw blocked.error;

    // When
    const shutdown = await manager.shutdown();
    const durable = await manager.getTaskResult(owner("root-shutdown-durable"), blocked.value.taskId);

    // Then
    expect(shutdown).toEqual({ ok: true, value: undefined });
    expect(durable).toMatchObject({ ok: true, value: { status: "cancelled" } });
  });

  it("releases lifecycle deadline timers after completion, queued cancellation, and shutdown", async () => {
    // Given
    const before = activeTimeouts();
    const runs = new BlockingRuns();
    const { manager } = await managerHarness({ createRunner: runs.createRunner });
    const first = await manager.startBackground(request("root-timer-cleanup", "first"));
    if (!first.ok) throw first.error;
    await runs.entered.promise;
    const blocked = await manager.continueBackground({ ...owner("root-timer-cleanup"), childSessionId: first.value.childSessionId, taskUserContent: "blocked" });
    if (!blocked.ok) throw blocked.error;

    // When
    await manager.cancelTask(owner("root-timer-cleanup"), blocked.value.taskId);
    runs.release();
    await manager.waitForTasks(owner("root-timer-cleanup"), [first.value.taskId]);
    await manager.shutdown();
    await flushMicrotasks();

    // Then
    expect(activeTimeouts()).toBeLessThanOrEqual(before);
  });

  it("keeps a published continuation bound to its original owner after request mutation", async () => {
    // Given
    const runs = new BlockingRuns();
    const { manager } = await managerHarness({ createRunner: runs.createRunner });
    const first = await manager.startBackground(request("root-mutable-owner", "first"));
    if (!first.ok) throw first.error;
    await runs.entered.promise;
    const mutable = {
      parentSessionId: "root-mutable-owner",
      rootSessionId: "root-mutable-owner",
      childSessionId: first.value.childSessionId,
      taskUserContent: "original",
      timeoutMs: 30_000
    };
    const blocked = await manager.continueBackground(mutable);
    if (!blocked.ok) throw blocked.error;

    // When
    mutable.parentSessionId = "root-mutated";
    mutable.rootSessionId = "root-mutated";
    mutable.childSessionId = "child-mutated";
    mutable.taskUserContent = "mutated";
    mutable.timeoutMs = 1;
    const cancelled = await manager.cancelRoot("root-mutable-owner");
    await flushMicrotasks();

    // Then
    expect(cancelled).toMatchObject({ ok: true, value: [{ status: "cancelled" }, { status: "cancelled" }] });
    expect(await manager.getTaskResult(owner("root-mutable-owner"), blocked.value.taskId)).toMatchObject({ ok: true, value: { status: "cancelled" } });
    expect(runs.prompts).toEqual(["first"]);
  });

  it("captures each continuation request field exactly once before claiming", async () => {
    // Given
    const runs = new BlockingRuns();
    const { manager } = await managerHarness({ createRunner: runs.createRunner });
    const first = await manager.startBackground(request("root-getter-owner", "first"));
    if (!first.ok) throw first.error;
    await runs.entered.promise;
    const counts = { parent: 0, root: 0, child: 0, prompt: 0, timeout: 0, signal: 0 };
    const controller = new AbortController();
    const getterRequest = {
      get parentSessionId() { counts.parent += 1; return "root-getter-owner"; },
      get rootSessionId() { counts.root += 1; return "root-getter-owner"; },
      get childSessionId() { counts.child += 1; return first.value.childSessionId; },
      get taskUserContent() { counts.prompt += 1; return "captured"; },
      get timeoutMs() { counts.timeout += 1; return 30_000; },
      get signal() { counts.signal += 1; return controller.signal; }
    } satisfies ContinuationTaskRequest;

    // When
    const blocked = await manager.continueBackground(getterRequest);
    const observed = { ...counts };
    await manager.cancelRoot("root-getter-owner");

    // Then
    expect(blocked).toMatchObject({ ok: true });
    expect(observed).toEqual({ parent: 1, root: 1, child: 1, prompt: 1, timeout: 1, signal: 1 });
  });
});
