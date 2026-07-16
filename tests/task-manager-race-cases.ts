import { StrongCodeError } from "../src/core/errors";
import { err, type Result } from "../src/core/result";
import { TaskManager } from "../src/tasks/task-manager";
import { ControlledRuns, GatedOwnershipRegistry, GatedTaskPersistence, managerHarness, request } from "./fixtures/task-manager-harness";

class TerminalFailPersistence extends GatedTaskPersistence {
  failWrite = 2;
  private writes = 0;

  override async write(record: unknown): Promise<Result<void>> {
    this.writes += 1;
    if (this.writes === this.failWrite) {
      return err(new StrongCodeError("TASK_ERROR", "terminal persistence failed"));
    }
    return super.write(record);
  }
}

describe("task manager admission cancellation races", () => {
  it.each(["list", "ownership"] as const)("does not lose cancellation during asynchronous %s", async stage => {
    // Given
    const persistence = new GatedTaskPersistence();
    const ownership = new GatedOwnershipRegistry();
    const runs = new ControlledRuns();
    const { manager } = await managerHarness({
      taskStore: persistence,
      ownership,
      limits: { enabled: true, maxActive: 1, maxChildrenPerRoot: 1, defaultTimeoutMs: 30_000, maxInlineResultChars: 12_000 },
      createRunner: runs.createRunner
    });
    const active = manager.runForeground(request(`root-race-${stage}-active`, "active"));
    await vi.waitFor(() => expect(runs.starts).toEqual(["active"]));
    const gate = stage === "list" ? persistence.blockNextList() : ownership.blockNextReserve();
    const controller = new AbortController();
    const queued = manager.runForeground(request(`root-race-${stage}`, stage, {
      signal: controller.signal,
      writePaths: stage === "ownership" ? ["src/race.ts"] : []
    }));
    await gate.entered;
    let settled = false;
    const observedQueued = queued.then(result => {
      settled = true;
      return result;
    });

    // When
    controller.abort(new StrongCodeError("CANCELLED", `${stage} cancelled`));
    gate.release();

    // Then
    const settledBeforeActive = await Promise.race([
      observedQueued.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 100))
    ]);
    const startsBeforeActive = [...runs.starts];
    runs.complete(0);
    await active;
    await expect(observedQueued).resolves.toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    expect(settledBeforeActive).toBe(true);
    expect(startsBeforeActive).toEqual(["active"]);
    expect(persistence.snapshot().filter(record => record.rootSessionId === `root-race-${stage}`)).toEqual([]);
  });

  it("cancels a queued durable write before the active child completes", async () => {
    // Given
    const persistence = new GatedTaskPersistence();
    const runs = new ControlledRuns();
    let factoryCalls = 0;
    let runnerCreations = 0;
    const { manager } = await managerHarness({
      taskStore: persistence,
      limits: { enabled: true, maxActive: 1, maxChildrenPerRoot: 1, defaultTimeoutMs: 30_000, maxInlineResultChars: 12_000 },
      childFactory: input => {
        factoryCalls += 1;
        return TaskManager.defaultChildFactory(input);
      },
      createRunner: context => {
        runnerCreations += 1;
        return runs.createRunner(context);
      }
    });
    const active = manager.runForeground(request("root-race-active", "active"));
    await vi.waitFor(() => expect(runs.starts).toEqual(["active"]));
    const gate = persistence.blockNextQueuedWrite();
    const controller = new AbortController();
    const queued = manager.runForeground(request("root-race-write", "queued", {
      signal: controller.signal,
      timeoutMs: 30_000,
      writePaths: ["src/gated.ts"]
    }));
    await gate.entered;
    let settled = false;
    const observedQueued = queued.then(result => {
      settled = true;
      return result;
    });

    // When
    controller.abort(new StrongCodeError("CANCELLED", "write cancelled"));
    gate.release();

    // Then
    const settledBeforeActive = await Promise.race([
      observedQueued.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 100))
    ]);
    const startsBeforeActive = [...runs.starts];
    const factoryCallsBeforeActive = factoryCalls;
    const runnerCreationsBeforeActive = runnerCreations;
    runs.complete(0);
    await active;
    await expect(observedQueued).resolves.toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    const replacement = manager.runForeground(request("root-race-write", "replacement", {
      writePaths: ["src/gated.ts"]
    }));
    await vi.waitFor(() => expect(runs.starts).toEqual(["active", "replacement"]));
    runs.complete(1);
    expect((await replacement).ok).toBe(true);
    expect(settledBeforeActive).toBe(true);
    expect(startsBeforeActive).toEqual(["active"]);
    expect(factoryCallsBeforeActive).toBe(1);
    expect(runnerCreationsBeforeActive).toBe(1);
    expect(persistence.snapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ rootSessionId: "root-race-write", status: "cancelled" })
    ]));
  });

  it("returns terminal persistence failure after createRunner construction fails", async () => {
    // Given
    const persistence = new TerminalFailPersistence();
    let shouldThrow = true;
    const { manager } = await managerHarness({
      taskStore: persistence,
      limits: { enabled: true, maxActive: 1, maxChildrenPerRoot: 1, defaultTimeoutMs: 30_000, maxInlineResultChars: 12_000 },
      createRunner: () => {
        if (shouldThrow) throw new StrongCodeError("MODEL_ERROR", "construction failed");
        return { run: async () => err(new StrongCodeError("MODEL_ERROR", "replacement failed")) };
      }
    });

    // When
    const failed = await manager.runForeground(request("root-terminal-fail", "first", {
      writePaths: ["src/terminal-fail.ts"]
    }));
    persistence.failWrite = 0;
    shouldThrow = false;
    const replacement = await manager.runForeground(request("root-terminal-fail", "replacement", {
      writePaths: ["src/terminal-fail.ts"]
    }));

    // Then
    expect(failed).toMatchObject({ ok: false, error: { code: "TASK_ERROR", message: "terminal persistence failed" } });
    expect(replacement).toMatchObject({ ok: true, value: { status: "failed" } });
  });
});
