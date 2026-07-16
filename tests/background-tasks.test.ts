import { StrongCodeError } from "../src/core/errors";
import { err, ok, type Result } from "../src/core/result";
import type { AgentRunResult } from "../src/core/types";
import type { ToolInvocationContext } from "../src/runtime/context";
import type { TaskRecord } from "../src/tasks/types";
import {
  ControlledRuns,
  MemoryTaskPersistence,
  deferred,
  managerHarness,
  request
} from "./fixtures/task-manager-harness";

const owner = (id: string) => Object.freeze({ parentSessionId: id, rootSessionId: id });

describe("task manager background lifecycle", () => {
  it("returns a frozen distinct-id handle after queued persistence without awaiting child completion", async () => {
    // Given
    const runs = new ControlledRuns();
    const persistence = new MemoryTaskPersistence();
    const { manager } = await managerHarness({ taskStore: persistence, createRunner: runs.createRunner });

    // When
    const started = await manager.startBackground(request("root-background-start", "gated"));

    // Then
    if (!started.ok) throw started.error;
    expect(started.value.taskId).not.toBe(started.value.childSessionId);
    expect(Object.isFrozen(started.value)).toBe(true);
    expect(persistence.snapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: started.value.taskId, mode: "background" })
    ]));
    await vi.waitFor(() => expect(runs.starts).toEqual(["gated"]));
    runs.complete(0);
    await expect(manager.waitForTasks(owner("root-background-start"), [started.value.taskId]))
      .resolves.toMatchObject({ ok: true, value: [{ status: "succeeded" }] });
  });

  it("waits for a snapshot in caller order and rejects duplicate or unavailable ids", async () => {
    // Given
    const runs = new ControlledRuns();
    const { manager } = await managerHarness({ taskStore: new MemoryTaskPersistence(), createRunner: runs.createRunner });
    const first = await manager.startBackground(request("root-wait", "first"));
    const second = await manager.startBackground(request("root-wait", "second"));
    if (!first.ok) throw first.error;
    if (!second.ok) throw second.error;
    await vi.waitFor(() => expect(runs.starts).toEqual(["first", "second"]));

    // When
    const waiting = manager.waitForTasks(owner("root-wait"), [second.value.taskId, first.value.taskId]);
    runs.complete(0, "first-result");
    runs.complete(1, "second-result");

    // Then
    await expect(waiting).resolves.toMatchObject({
      ok: true,
      value: [{ taskId: second.value.taskId, text: "second-result" }, { taskId: first.value.taskId, text: "first-result" }]
    });
    await expect(manager.waitForTasks(owner("root-wait"), [first.value.taskId, first.value.taskId]))
      .resolves.toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    await expect(manager.waitForTasks(owner("other-root"), [first.value.taskId]))
      .resolves.toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
  });

  it("filters status, result, and list access by exact parent and root ownership", async () => {
    // Given
    const { manager } = await managerHarness();
    const started = await manager.startBackground(request("root-owned", "private"));
    if (!started.ok) throw started.error;
    await manager.waitForTasks(owner("root-owned"), [started.value.taskId]);

    // When
    const visible = await manager.listTasks(owner("root-owned"));
    const foreignStatus = await manager.getTaskStatus(owner("root-foreign"), started.value.taskId);
    const foreignResult = await manager.getTaskResult(owner("root-foreign"), started.value.taskId);

    // Then
    expect(visible).toMatchObject({ ok: true, value: [{ id: started.value.taskId }] });
    expect(foreignStatus).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    expect(foreignResult).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
  });

  it("rejects a foreign continuation before any additional runner or session turn", async () => {
    // Given
    let runnerCalls = 0;
    const { manager } = await managerHarness({
      createRunner: () => ({
        run: async (_agent, _prompt, sessionId) => {
          runnerCalls += 1;
          return ok({ sessionId, response: "private", toolExecutions: [] });
        }
      })
    });
    const started = await manager.startBackground(request("root-continuation-owner", "private"));
    if (!started.ok) throw started.error;
    await manager.waitForTasks(owner("root-continuation-owner"), [started.value.taskId]);

    // When
    const forged = await manager.continueBackground({
      ...owner("root-foreign-continuation"),
      childSessionId: started.value.childSessionId,
      taskUserContent: "steal history"
    });

    // Then
    expect(forged).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    expect(runnerCalls).toBe(1);
  });

  it("links parent cancellation reason to a background child controller", async () => {
    // Given
    const parent = new AbortController();
    let observedReason: unknown;
    const entered = deferred<void>();
    const { manager } = await managerHarness({
      createRunner: context => ({
        run: async () => {
          entered.resolve(undefined);
          return new Promise(resolve => context.signal?.addEventListener("abort", () => {
            observedReason = context.signal?.reason;
            resolve(err(new StrongCodeError("CANCELLED", "parent stopped")));
          }, { once: true }));
        }
      })
    });
    const started = await manager.startBackground(request("root-parent-abort", "attached", { signal: parent.signal }));
    if (!started.ok) throw started.error;
    await entered.promise;
    const reason = new StrongCodeError("CANCELLED", "exact parent reason");

    // When
    parent.abort(reason);
    const result = await manager.waitForTasks(owner("root-parent-abort"), [started.value.taskId]);

    // Then
    expect(observedReason).toBe(reason);
    expect(result).toMatchObject({ ok: true, value: [{ status: "cancelled", error: { message: "exact parent reason" } }] });
  });

  it("continues the owned child with the same profile and serializes against its active turn", async () => {
    // Given
    const firstGate = deferred<void>();
    const calls: Array<{ readonly prompt: string; readonly sessionId: string; readonly context: ToolInvocationContext; readonly agent: object }> = [];
    const { manager } = await managerHarness({
      createRunner: context => ({
        run: async (agent, prompt, sessionId) => {
          calls.push({ agent, prompt, sessionId, context });
          if (prompt === "first turn") await firstGate.promise;
          return ok({ sessionId, response: prompt, toolExecutions: [] });
        }
      })
    });
    const first = await manager.startBackground(request("root-continue", "first turn"));
    if (!first.ok) throw first.error;
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    // When
    const continued = await manager.continueBackground({
      ...owner("root-continue"),
      childSessionId: first.value.childSessionId,
      taskUserContent: "second turn"
    });
    if (!continued.ok) throw continued.error;
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    firstGate.resolve(undefined);
    const results = await manager.waitForTasks(owner("root-continue"), [first.value.taskId, continued.value.taskId]);

    // Then
    expect(results).toMatchObject({ ok: true, value: [{ status: "succeeded" }, { status: "succeeded" }] });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.sessionId).toBe(first.value.childSessionId);
    expect(calls[1]?.agent).toBe(calls[0]?.agent);
    expect(calls[1]?.context.effectivePermissions).toEqual(calls[0]?.context.effectivePermissions);
  });

  it("cancels queued and running work idempotently and awaits root cancellation", async () => {
    // Given
    const signals: AbortSignal[] = [];
    const { manager } = await managerHarness({
      limits: { enabled: true, maxActive: 1, maxChildrenPerRoot: 16, defaultTimeoutMs: 30_000, maxInlineResultChars: 12_000 },
      createRunner: context => ({
        run: async () => {
          const signal = context.signal;
          if (!signal) return err(new StrongCodeError("TASK_ERROR", "missing signal"));
          signals.push(signal);
          return new Promise(resolve => signal.addEventListener(
            "abort",
            () => resolve(err(new StrongCodeError("CANCELLED", String(signal.reason)))),
            { once: true }
          ));
        }
      })
    });
    const running = await manager.startBackground(request("root-cancel", "running"));
    const queued = await manager.startBackground(request("root-cancel", "queued"));
    if (!running.ok) throw running.error;
    if (!queued.ok) throw queued.error;
    await vi.waitFor(() => expect(signals).toHaveLength(1));

    // When
    const cancelled = await manager.cancelRoot("root-cancel", new StrongCodeError("CANCELLED", "root stopped"));
    const duplicate = await manager.cancelTask(owner("root-cancel"), running.value.taskId);

    // Then
    expect(cancelled).toMatchObject({ ok: true, value: [{ status: "cancelled" }, { status: "cancelled" }] });
    expect(duplicate).toMatchObject({ ok: true, value: { status: "cancelled" } });
    expect(signals[0]?.aborted).toBe(true);
  });

  it("reconciles nonterminal records without constructing a child or runner", async () => {
    // Given
    const persistence = new MemoryTaskPersistence();
    const timestamp = new Date().toISOString();
    const records = ["queued", "running", "blocked"].map((status, index) => ({
      id: `task-123e4567-e89b-42d3-a456-42661417410${index}`,
      childSessionId: `child-restart-${index}`,
      parentSessionId: "parent-restart",
      rootSessionId: "root-restart",
      target: { class: "helper" as const, id: "explore" },
      attempt: 1,
      depth: 1,
      mode: "background" as const,
      ...(status === "queued" ? {} : { model: "mock", timestamps: { createdAt: timestamp, updatedAt: timestamp, startedAt: timestamp } }),
      effectivePolicyHash: "a".repeat(64),
      skillReceipts: [],
      ownedPaths: [],
      ...(status === "queued" ? { timestamps: { createdAt: timestamp, updatedAt: timestamp } } : {}),
      status
    })) as readonly TaskRecord[];
    for (const record of records) await persistence.write(record);
    let factoryCalls = 0;
    let runnerCalls = 0;
    const { manager } = await managerHarness({
      taskStore: persistence,
      childFactory: input => {
        factoryCalls += 1;
        return input as never;
      },
      createRunner: () => {
        runnerCalls += 1;
        return { run: async () => err(new StrongCodeError("MODEL_ERROR", "must not run")) };
      }
    });

    // When
    const initialized = await manager.initialize();

    // Then
    expect(initialized).toMatchObject({ ok: true, value: [{ status: "interrupted" }, { status: "interrupted" }, { status: "interrupted" }] });
    expect(factoryCalls).toBe(0);
    expect(runnerCalls).toBe(0);
  });

  it("stress-tests cancel-versus-complete and duplicate cancel for fifty terminal claims", async () => {
    // Given
    const completions: Array<ReturnType<typeof deferred<Result<AgentRunResult>>>> = [];
    const { manager } = await managerHarness({
      taskStore: new MemoryTaskPersistence(),
      createRunner: context => ({
        run: async (_agent, _prompt, sessionId) => {
          const completion = deferred<Result<AgentRunResult>>();
          completions.push(completion);
          context.signal?.addEventListener("abort", () => completion.resolve(ok({ sessionId, response: "committed", toolExecutions: [] })), { once: true });
          return completion.promise;
        }
      })
    });
    const outcomes: string[] = [];

    // When
    for (let index = 0; index < 50; index += 1) {
      const started = await manager.startBackground(request(`root-claim-${index}`, `claim-${index}`));
      if (!started.ok) throw started.error;
      await vi.waitFor(() => expect(completions).toHaveLength(index + 1));
      if (index % 2 === 0) completions[index]?.resolve(ok({ sessionId: started.value.childSessionId, response: "committed", toolExecutions: [] }));
      const firstCancel = manager.cancelTask(owner(`root-claim-${index}`), started.value.taskId);
      const duplicateCancel = manager.cancelTask(owner(`root-claim-${index}`), started.value.taskId);
      if (index % 2 !== 0) completions[index]?.resolve(ok({ sessionId: started.value.childSessionId, response: "late", toolExecutions: [] }));
      const [first, duplicate] = await Promise.all([firstCancel, duplicateCancel]);
      if (!first.ok) throw first.error;
      if (!duplicate.ok) throw duplicate.error;
      expect(duplicate.value.status).toBe(first.value.status);
      outcomes.push(first.value.status);
    }

    // Then
    expect(outcomes).toHaveLength(50);
    expect(outcomes.every(status => status === "succeeded")).toBe(true);
  });

  it("stress-tests timeout-versus-committed-success for fifty attempts", async () => {
    // Given
    const { manager } = await managerHarness({
      taskStore: new MemoryTaskPersistence(),
      createRunner: () => ({
        run: async (_agent, _prompt, sessionId) => {
          await new Promise(resolve => setTimeout(resolve, 110));
          return ok({ sessionId, response: "durably committed", toolExecutions: [] });
        }
      })
    });

    // When
    const results = [];
    for (let index = 0; index < 50; index += 1) {
      const started = await manager.startBackground(request(`root-timeout-claim-${index}`, `timeout-${index}`, { timeoutMs: 100 }));
      if (!started.ok) throw started.error;
      results.push(await manager.waitForTasks(owner(`root-timeout-claim-${index}`), [started.value.taskId]));
    }

    // Then
    expect(results).toHaveLength(50);
    expect(results.every(result => result.ok && result.value[0]?.status === "succeeded")).toBe(true);
  });

  it("stress-tests fifty continuations against one active child turn", async () => {
    // Given
    const firstGate = deferred<void>();
    let active = 0;
    let maximumActive = 0;
    const { manager } = await managerHarness({
      taskStore: new MemoryTaskPersistence(),
      createRunner: () => ({
        run: async (_agent, prompt, sessionId) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          if (prompt === "initial") await firstGate.promise;
          active -= 1;
          return ok({ sessionId, response: prompt, toolExecutions: [] });
        }
      })
    });
    const initial = await manager.startBackground(request("root-fifty-continuations", "initial"));
    if (!initial.ok) throw initial.error;
    await vi.waitFor(() => expect(active).toBe(1));

    // When
    const continuations: BackgroundTaskHandleForTest[] = [];
    for (let index = 0; index < 50; index += 1) {
      const continued = await manager.continueBackground({
        ...owner("root-fifty-continuations"),
        childSessionId: initial.value.childSessionId,
        taskUserContent: `continuation-${index}`
      });
      if (!continued.ok) throw continued.error;
      continuations.push(continued.value);
    }
    firstGate.resolve(undefined);
    const waited = await manager.waitForTasks(
      owner("root-fifty-continuations"),
      [initial.value.taskId, ...continuations.map(handle => handle.taskId)]
    );

    // Then
    expect(waited).toMatchObject({ ok: true });
    expect(maximumActive).toBe(1);
    const listed = await manager.listTasks(owner("root-fifty-continuations"));
    if (!listed.ok) throw listed.error;
    expect(new Set(listed.value.map(record => record.childSessionId))).toEqual(new Set([initial.value.childSessionId]));
    expect(listed.value.map(record => record.attempt)).toEqual(Array.from({ length: 51 }, (_, index) => index + 1));
  });

  it("shutdown cancels and persists fifty jobs, then rejects new work", async () => {
    // Given
    const { manager } = await managerHarness({
      taskStore: new MemoryTaskPersistence(),
      createRunner: context => ({
        run: async () => new Promise(resolve => context.signal?.addEventListener(
          "abort",
          () => resolve(err(new StrongCodeError("CANCELLED", "shutdown"))),
          { once: true }
        ))
      })
    });
    const handles = [];
    for (let index = 0; index < 50; index += 1) {
      const started = await manager.startBackground(request(`root-shutdown-${index}`, `shutdown-${index}`));
      if (!started.ok) throw started.error;
      handles.push(started.value);
    }

    // When
    const shutdown = await manager.shutdown();
    const rejected = await manager.startBackground(request("root-after-shutdown", "rejected"));

    // Then
    expect(shutdown).toEqual({ ok: true, value: undefined });
    expect(rejected).toMatchObject({ ok: false, error: { code: "TASK_ERROR" } });
    for (let index = 0; index < handles.length; index += 1) {
      const result = await manager.getTaskResult(owner(`root-shutdown-${index}`), handles[index]?.taskId ?? "missing");
      expect(result).toMatchObject({ ok: true, value: { status: "cancelled" } });
    }
  });

  it("serializes fifty durable observations against terminal replacement writes", async () => {
    // Given
    const gates: Array<ReturnType<typeof deferred<void>>> = [];
    const { manager } = await managerHarness({
      createRunner: () => ({
        run: async (_agent, _prompt, sessionId) => {
          const gate = deferred<void>();
          gates.push(gate);
          await gate.promise;
          return ok({ sessionId, response: "observed", toolExecutions: [] });
        }
      })
    });

    // When
    for (let index = 0; index < 50; index += 1) {
      const root = `root-durable-observation-${index}`;
      const started = await manager.startBackground(request(root, `observe-${index}`));
      if (!started.ok) throw started.error;
      await vi.waitFor(() => expect(gates).toHaveLength(index + 1));
      const observed = manager.getTaskStatus(owner(root), started.value.taskId);
      gates[index]?.resolve(undefined);
      const [status, result] = await Promise.all([
        observed,
        manager.waitForTasks(owner(root), [started.value.taskId])
      ]);
      if (!status.ok) throw status.error;
      if (!result.ok) throw result.error;
      expect(result.value[0]?.status).toBe("succeeded");
    }

    // Then
    expect(gates).toHaveLength(50);
  });
});

type BackgroundTaskHandleForTest = Readonly<{ readonly taskId: string; readonly childSessionId: string }>;
