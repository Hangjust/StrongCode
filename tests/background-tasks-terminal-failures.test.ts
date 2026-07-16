import { StrongCodeError } from "../src/core/errors";
import { err, ok, type Result } from "../src/core/result";
import type { AgentRunResult } from "../src/core/types";
import type { ToolInvocationContext } from "../src/runtime/context";
import type { TaskOwner } from "../src/tasks/background-jobs";
import type { ForegroundTaskResult } from "../src/tasks/execution";
import { parseTaskRecord } from "../src/tasks/types";
import { deferred, managerHarness, MemoryTaskPersistence, request } from "./fixtures/task-manager-harness";

function owner(id: string): TaskOwner { return Object.freeze({ parentSessionId: id, rootSessionId: id }); }

async function flushMicrotasks(): Promise<void> { for (let index = 0; index < 20; index += 1) await Promise.resolve(); }

function activeTimeouts(): number { return process.getActiveResourcesInfo().filter(resource => resource === "Timeout").length; }

class BlockingRuns {
  readonly entered = deferred<void>();
  private readonly releaseGate = deferred<void>();

  createRunner = (context: ToolInvocationContext) => ({
    run: async (_agent: object, prompt: string, sessionId: string): Promise<Result<AgentRunResult>> => {
      this.entered.resolve(undefined);
      return new Promise(resolve => {
        this.releaseGate.promise.then(() => resolve(ok({ sessionId, response: prompt, toolExecutions: [] })));
        context.signal?.addEventListener("abort", () => resolve(err(new StrongCodeError("CANCELLED", "stopped"))), { once: true });
      });
    }
  });

  release(): void { this.releaseGate.resolve(undefined); }
}

class TerminalFailPersistence extends MemoryTaskPersistence {
  failedTaskId: string | undefined;

  override async write(record: unknown): Promise<Result<void>> {
    const parsed = parseTaskRecord(record);
    if (parsed.id === this.failedTaskId && ["cancelled", "timed_out"].includes(parsed.status)) {
      return err(new StrongCodeError("TASK_ERROR", "terminal write failed"));
    }
    return super.write(parsed);
  }
}

class TransitionFailPersistence extends MemoryTaskPersistence {
  failedTaskId: string | undefined;
  failTerminal = false;

  override async write(record: unknown): Promise<Result<void>> {
    const parsed = parseTaskRecord(record);
    if (parsed.id === this.failedTaskId && parsed.status === "queued") {
      return err(new StrongCodeError("TASK_ERROR", "queued transition failed"));
    }
    if (parsed.id === this.failedTaskId && parsed.status === "failed" && this.failTerminal) {
      return err(new StrongCodeError("TASK_ERROR", "failed terminal write failed"));
    }
    return super.write(parsed);
  }
}

class InitialTerminalFailPersistence extends MemoryTaskPersistence {
  failedTaskId: string | undefined;

  override async write(record: unknown): Promise<Result<void>> {
    const parsed = parseTaskRecord(record);
    if (parsed.id === this.failedTaskId && parsed.status === "succeeded") {
      return err(new StrongCodeError("TASK_ERROR", "initial terminal write failed"));
    }
    return super.write(parsed);
  }
}

class CancellationTerminalFailPersistence extends MemoryTaskPersistence {
  override async write(record: unknown): Promise<Result<void>> {
    const parsed = parseTaskRecord(record);
    return parsed.status === "cancelled"
      ? err(new StrongCodeError("TASK_ERROR", "poison terminal write failed"))
      : super.write(parsed);
  }
}

describe("background terminal persistence failures", () => {
  it("propagates a queued terminal-write failure as TASK_ERROR", async () => {
    // Given
    const persistence = new TerminalFailPersistence();
    const runs = new BlockingRuns();
    const { manager } = await managerHarness({ taskStore: persistence, createRunner: runs.createRunner });
    const first = await manager.startBackground(request("root-terminal-write", "first"));
    if (!first.ok) throw first.error;
    await runs.entered.promise;
    const continued = await manager.continueBackground({ ...owner("root-terminal-write"), childSessionId: first.value.childSessionId, taskUserContent: "second" });
    if (!continued.ok) throw continued.error;
    persistence.failedTaskId = continued.value.taskId;

    // When
    const cancelled = await manager.cancelTask(owner("root-terminal-write"), continued.value.taskId);

    // Then
    expect(cancelled).toMatchObject({ ok: false, error: { code: "TASK_ERROR", message: "terminal write failed" } });
    runs.release();
    await manager.waitForTasks(owner("root-terminal-write"), [first.value.taskId]);
  });

  it("terminalizes a failed blocked-to-queued transition as durable failed", async () => {
    // Given
    const persistence = new TransitionFailPersistence();
    const runs = new BlockingRuns();
    const { manager } = await managerHarness({ taskStore: persistence, createRunner: runs.createRunner });
    const first = await manager.startBackground(request("root-transition-fail", "first"));
    if (!first.ok) throw first.error;
    await runs.entered.promise;
    const blocked = await manager.continueBackground({ ...owner("root-transition-fail"), childSessionId: first.value.childSessionId, taskUserContent: "blocked" });
    if (!blocked.ok) throw blocked.error;
    persistence.failedTaskId = blocked.value.taskId;

    // When
    runs.release();
    const result = await manager.waitForTasks(owner("root-transition-fail"), [blocked.value.taskId]);
    const durable = await manager.getTaskResult(owner("root-transition-fail"), blocked.value.taskId);

    // Then
    expect(result).toMatchObject({ ok: true, value: [{ status: "failed", error: { message: "queued transition failed" } }] });
    expect(durable).toMatchObject({ ok: true, value: { status: "failed" } });
  });

  it("replays a continuation double terminal-write failure without retaining lifecycle resources", async () => {
    // Given
    const before = activeTimeouts();
    const persistence = new TransitionFailPersistence();
    persistence.failTerminal = true;
    const runs = new BlockingRuns();
    const { manager } = await managerHarness({ taskStore: persistence, createRunner: runs.createRunner });
    const first = await manager.startBackground(request("root-transition-terminal-fail", "first"));
    if (!first.ok) throw first.error;
    await runs.entered.promise;
    const blocked = await manager.continueBackground({ ...owner("root-transition-terminal-fail"), childSessionId: first.value.childSessionId, taskUserContent: "blocked" });
    if (!blocked.ok) throw blocked.error;
    persistence.failedTaskId = blocked.value.taskId;

    // When
    runs.release();
    const firstFailure = await manager.waitForTasks(owner("root-transition-terminal-fail"), [blocked.value.taskId]);
    const repeatedCancel = await manager.cancelTask(owner("root-transition-terminal-fail"), blocked.value.taskId);
    const repeatedResult = await manager.getTaskResult(owner("root-transition-terminal-fail"), blocked.value.taskId);
    const repeatedWait = await manager.waitForTasks(owner("root-transition-terminal-fail"), [blocked.value.taskId]);
    const resumed = await manager.continueBackground({ ...owner("root-transition-terminal-fail"), childSessionId: first.value.childSessionId, taskUserContent: "must-not-run" });
    const registry = manager["supervisor"]["dependencies"].jobs;
    const revoked = await manager.cancelRoot("root-transition-terminal-fail");
    const afterPurge = await manager.getTaskResult(owner("root-transition-terminal-fail"), blocked.value.taskId);
    await flushMicrotasks();

    // Then
    expect(firstFailure).toMatchObject({ ok: false, error: { message: "failed terminal write failed" } });
    expect(repeatedCancel).toMatchObject({ ok: false, error: { message: "failed terminal write failed" } });
    expect(repeatedResult).toMatchObject({ ok: false, error: { message: "failed terminal write failed" } });
    expect(repeatedWait).toMatchObject({ ok: false, error: { message: "failed terminal write failed" } });
    expect(resumed).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    expect(registry.allJobs()).toEqual([]);
    expect(revoked).toMatchObject({ ok: false, error: { message: "failed terminal write failed" } });
    expect(afterPurge).toMatchObject({ ok: false, error: { message: expect.not.stringContaining("failed terminal write failed") } });
    expect(activeTimeouts()).toBeLessThanOrEqual(before);
  });

  it("replays an initial running terminal-write failure until shutdown purges its tombstone", async () => {
    // Given
    const before = activeTimeouts();
    const persistence = new InitialTerminalFailPersistence();
    const runs = new BlockingRuns();
    const { manager } = await managerHarness({ taskStore: persistence, createRunner: runs.createRunner });
    const started = await manager.startBackground(request("root-initial-terminal-fail", "initial"));
    if (!started.ok) throw started.error;
    await runs.entered.promise;
    persistence.failedTaskId = started.value.taskId;

    // When
    runs.release();
    const firstFailure = await manager.waitForTasks(owner("root-initial-terminal-fail"), [started.value.taskId]);
    const repeatedCancel = await manager.cancelTask(owner("root-initial-terminal-fail"), started.value.taskId);
    const repeatedResult = await manager.getTaskResult(owner("root-initial-terminal-fail"), started.value.taskId);
    const repeatedWait = await manager.waitForTasks(owner("root-initial-terminal-fail"), [started.value.taskId]);
    const resumed = await manager.continueBackground({ ...owner("root-initial-terminal-fail"), childSessionId: started.value.childSessionId, taskUserContent: "must-not-run" });
    const registry = manager["supervisor"]["dependencies"].jobs;
    const shutdown = await manager.shutdown();
    const afterPurge = await manager.getTaskResult(owner("root-initial-terminal-fail"), started.value.taskId);
    await flushMicrotasks();

    // Then
    expect(firstFailure).toMatchObject({ ok: false, error: { message: "initial terminal write failed" } });
    expect(repeatedCancel).toMatchObject({ ok: false, error: { message: "initial terminal write failed" } });
    expect(repeatedResult).toMatchObject({ ok: false, error: { message: "initial terminal write failed" } });
    expect(repeatedWait).toMatchObject({ ok: false, error: { message: "initial terminal write failed" } });
    expect(resumed).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    expect(registry.allJobs()).toEqual([]);
    expect(shutdown).toMatchObject({ ok: false, error: { message: "initial terminal write failed" } });
    expect(afterPurge).toMatchObject({ ok: false, error: { message: expect.not.stringContaining("initial terminal write failed") } });
    expect(activeTimeouts()).toBeLessThanOrEqual(before);
  });

  it("poisons a root after its first tombstone and bounds sequential queued failures", async () => {
    // Given
    const persistence = new CancellationTerminalFailPersistence();
    const runs = new BlockingRuns();
    const { manager } = await managerHarness({
      taskStore: persistence,
      createRunner: runs.createRunner,
      limits: { enabled: true, maxActive: 1, maxChildrenPerRoot: 2, defaultTimeoutMs: 30_000, maxInlineResultChars: 12_000 }
    });
    const blocker = await manager.startBackground(request("root-poison-bound", "blocker"));
    if (!blocker.ok) throw blocker.error;
    await runs.entered.promise;

    // When
    const starts: Result<Readonly<{ taskId: string; childSessionId: string }>>[] = [];
    const cancellations: Result<ForegroundTaskResult>[] = [];
    for (let index = 0; index < 4; index += 1) {
      const started = await manager.startBackground(request("root-poison-bound", `queued-${index}`));
      starts.push(started);
      if (started.ok) cancellations.push(await manager.cancelTask(owner("root-poison-bound"), started.value.taskId));
    }
    const registry = manager["supervisor"]["dependencies"].jobs;
    runs.release();
    const blockerResult = await manager.waitForTasks(owner("root-poison-bound"), [blocker.value.taskId]);
    const revoked = await manager.cancelRoot("root-poison-bound");

    // Then
    expect(starts.map(result => result.ok)).toEqual([true, false, false, false]);
    expect(cancellations).toHaveLength(1);
    expect(cancellations[0]).toMatchObject({ ok: false, error: { message: "poison terminal write failed" } });
    expect(registry.allJobs()).toEqual([]);
    expect(registry["profiles"].size).toBe(0);
    expect(blockerResult).toMatchObject({ ok: true, value: [{ status: "succeeded" }] });
    expect(revoked).toMatchObject({ ok: false, error: { message: "poison terminal write failed" } });
    expect(registry["terminalFailures"].size).toBe(0);
  });
});
