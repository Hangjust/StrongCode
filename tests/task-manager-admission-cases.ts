import { StrongCodeError } from "../src/core/errors";
import { err } from "../src/core/result";
import { TaskManager } from "../src/tasks/task-manager";
import { AdmissionQueue } from "../src/tasks/admission";
import type { TaskRecord } from "../src/tasks/types";
import { ControlledRuns, managerHarness, MemoryTaskPersistence, request } from "./fixtures/task-manager-harness";

describe("task manager admission", () => {
  it("admits at most four children and starts the fifth in strict FIFO order", async () => {
    // Given
    const runs = new ControlledRuns();
    const { manager } = await managerHarness({
      taskStore: new MemoryTaskPersistence(),
      limits: { enabled: true, maxActive: 64, maxChildrenPerRoot: 1_024, defaultTimeoutMs: 10_000, maxInlineResultChars: 12_000 },
      createRunner: runs.createRunner
    });
    const results = Array.from({ length: 6 }, (_, index) => (
      manager.runForeground(request("root-fifo", `task-${index}`))
    ));
    await vi.waitFor(() => expect(runs.starts).toEqual(["task-0", "task-1", "task-2", "task-3"]));

    // When
    runs.complete(1);
    await vi.waitFor(() => expect(runs.starts).toEqual(["task-0", "task-1", "task-2", "task-3", "task-4"]));
    runs.complete(0);
    await vi.waitFor(() => expect(runs.starts).toEqual(["task-0", "task-1", "task-2", "task-3", "task-4", "task-5"]));
    [2, 3, 4, 5].forEach(index => runs.complete(index));

    // Then
    expect((await Promise.all(results)).every(result => result.ok)).toBe(true);
    expect(runs.maximumActive).toBe(4);
  });

  it("rejects the seventeenth accepted child for one root before factory creation", async () => {
    // Given
    let factoryCalls = 0;
    const { manager } = await managerHarness({
      taskStore: new MemoryTaskPersistence(),
      limits: { enabled: true, maxActive: 16, maxChildrenPerRoot: 16, defaultTimeoutMs: 10_000, maxInlineResultChars: 12_000 },
      childFactory: input => {
        factoryCalls += 1;
        return TaskManager.defaultChildFactory(input);
      },
      createRunner: () => ({
        run: async (_agent, _prompt, sessionId) => ({
          ok: true,
          value: { sessionId, response: "ok", toolExecutions: [] }
        })
      })
    });
    for (let index = 0; index < 16; index += 1) {
      expect((await manager.runForeground(request("root-sixteen", `accepted-${index}`))).ok).toBe(true);
    }

    // When
    const rejected = await manager.runForeground(request("root-sixteen", "rejected"));

    // Then
    expect(rejected).toMatchObject({ ok: false, error: { code: "TASK_ERROR" } });
    expect(factoryCalls).toBe(16);
  });

  it("denies child origins before malformed target parsing or persistence", async () => {
    // Given
    let factoryCalls = 0;
    const { manager, taskStore } = await managerHarness({
      childFactory: input => {
        factoryCalls += 1;
        return TaskManager.defaultChildFactory(input);
      }
    });

    // When
    const result = await manager.runForeground(request("root-nested", "nested", {
      origin: { kind: "child", agentId: "explore" },
      target: { kind: "injected", id: "\ninvalid" }
    }));

    // Then
    expect(result).toMatchObject({ ok: false, error: { code: "NESTED_SPAWN_DENIED" } });
    expect(factoryCalls).toBe(0);
    expect(await taskStore.list()).toEqual({ ok: true, value: [] });
  });

  it.each(["timeout", "cancellation"] as const)("removes a queued %s without starting child work", async kind => {
    // Given
    const runs = new ControlledRuns();
    let factoryCalls = 0;
    const { manager } = await managerHarness({
      taskStore: new MemoryTaskPersistence(),
      limits: { enabled: true, maxActive: 1, maxChildrenPerRoot: 16, defaultTimeoutMs: 10_000, maxInlineResultChars: 12_000 },
      childFactory: input => {
        factoryCalls += 1;
        return TaskManager.defaultChildFactory(input);
      },
      createRunner: runs.createRunner
    });
    const active = manager.runForeground(request(`root-${kind}`, "active"));
    await vi.waitFor(() => expect(runs.starts).toEqual(["active"]));
    const controller = new AbortController();
    const queued = manager.runForeground(request(`root-${kind}`, "queued", {
      timeoutMs: kind === "timeout" ? 25 : 10_000,
      signal: controller.signal,
      writePaths: ["src/queued.ts"]
    }));

    // When
    if (kind === "cancellation") controller.abort(new StrongCodeError("CANCELLED", "parent cancelled"));

    // Then
    expect(await queued).toMatchObject({ ok: false, error: { code: kind === "timeout" ? "TASK_ERROR" : "CANCELLED" } });
    expect(factoryCalls).toBe(1);
    runs.complete(0);
    await active;
    const replacement = manager.runForeground(request(`root-${kind}`, "replacement", {
      writePaths: ["src/queued.ts"]
    }));
    await vi.waitFor(() => expect(runs.starts).toEqual(["active", "replacement"]));
    runs.complete(1);
    expect((await replacement).ok).toBe(true);
    expect(factoryCalls).toBe(2);
  });

  it("rolls back root capacity and ownership when child creation throws", async () => {
    // Given
    let shouldThrow = true;
    const { manager } = await managerHarness({
      taskStore: new MemoryTaskPersistence(),
      limits: { enabled: true, maxActive: 1, maxChildrenPerRoot: 1, defaultTimeoutMs: 10_000, maxInlineResultChars: 12_000 },
      childFactory: input => {
        if (shouldThrow) throw new StrongCodeError("MODEL_ERROR", "factory failed");
        return TaskManager.defaultChildFactory(input);
      },
      createRunner: () => ({ run: async () => err(new StrongCodeError("MODEL_ERROR", "runner failed")) })
    });
    const first = await manager.runForeground(request("root-rollback", "first", { writePaths: ["src/task-a.ts"] }));
    shouldThrow = false;

    // When
    const second = await manager.runForeground(request("root-rollback", "second", { writePaths: ["src/task-a.ts"] }));

    // Then
    expect(first).toMatchObject({ ok: false, error: { code: "MODEL_ERROR" } });
    expect(second).toMatchObject({ ok: true, value: { status: "failed" } });
  });

  it("makes duplicate lease release a no-op before admitting the next waiter", async () => {
    // Given
    const tasks = new MemoryTaskPersistence();
    const harness = await managerHarness({ taskStore: tasks });
    const queue = new AdmissionQueue({ maxActive: 1, maxChildrenPerRoot: 16 }, tasks);
    const createdAt = new Date().toISOString();
    const record = (suffix: string): TaskRecord => ({
      id: `task-123e4567-e89b-42d3-a456-4266141740${suffix}`,
      childSessionId: `child-${suffix}`,
      parentSessionId: "parent-release",
      rootSessionId: "root-release",
      target: { class: "helper", id: "explore" },
      attempt: 1,
      depth: 1,
      mode: "foreground",
      effectivePolicyHash: "a".repeat(64),
      skillReceipts: [],
      ownedPaths: [],
      timestamps: { createdAt, updatedAt: createdAt },
      status: "queued"
    });
    const first = await queue.acquire({ context: harness.context, queuedRecord: record("00"), writePaths: [], timeoutMs: 1_000 });
    if (!first.ok) throw first.error;

    // When
    await Promise.all([first.value.release(), first.value.release()]);
    const second = await queue.acquire({ context: harness.context, queuedRecord: record("01"), writePaths: [], timeoutMs: 1_000 });

    // Then
    expect(second.ok).toBe(true);
    if (second.ok) await second.value.release();
  });
});
