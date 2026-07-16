import { StrongCodeError } from "../src/core/errors";
import { err } from "../src/core/result";
import { TaskManager } from "../src/tasks/task-manager";
import {
  GatedOwnershipRegistry,
  GatedTaskPersistence,
  managerHarness,
  request
} from "./fixtures/task-manager-harness";

const TASK_LIMITS = {
  enabled: true,
  maxActive: 1,
  maxChildrenPerRoot: 1,
  defaultTimeoutMs: 30_000,
  maxInlineResultChars: 12_000
} as const;

function after(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

describe("task manager absolute admission deadline", () => {
  it("times out from acquire entry while waiting on the serialized admission tail", async () => {
    // Given
    const persistence = new GatedTaskPersistence();
    let factoryCalls = 0;
    let runnerCalls = 0;
    const { manager } = await managerHarness({
      taskStore: persistence,
      limits: TASK_LIMITS,
      childFactory: input => {
        factoryCalls += 1;
        return TaskManager.defaultChildFactory(input);
      },
      createRunner: () => ({
        run: async (_agent, _prompt, sessionId) => {
          runnerCalls += 1;
          return { ok: true, value: { sessionId, response: "ok", toolExecutions: [] } };
        }
      })
    });
    const gate = persistence.blockNextList();
    const blocker = manager.runForeground(request("root-deadline-tail-blocker", "blocker", { timeoutMs: 30_000 }));
    await gate.entered;
    const timed = manager.runForeground(request("root-deadline-tail", "timed", { timeoutMs: 10 }));

    // When
    await after(25);
    gate.release();

    // Then
    expect((await blocker).ok).toBe(true);
    await expect(timed).resolves.toMatchObject({ ok: false, error: { code: "TASK_ERROR" } });
    expect(factoryCalls).toBe(1);
    expect(runnerCalls).toBe(1);
    expect(persistence.snapshot().filter(record => record.rootSessionId === "root-deadline-tail")).toEqual([]);
  });

  it.each(["list", "ownership", "queued-write"] as const)(
    "uses the acquire-entry deadline while waiting on %s",
    async stage => {
      // Given
      const persistence = new GatedTaskPersistence();
      const ownership = new GatedOwnershipRegistry();
      let factoryCalls = 0;
      let runnerCalls = 0;
      const { manager } = await managerHarness({
        taskStore: persistence,
        ownership,
        limits: TASK_LIMITS,
        childFactory: input => {
          factoryCalls += 1;
          return TaskManager.defaultChildFactory(input);
        },
        createRunner: () => ({
          run: async () => {
            runnerCalls += 1;
            return err(new StrongCodeError("MODEL_ERROR", "must not run"));
          }
        })
      });
      const gate = stage === "list"
        ? persistence.blockNextList()
        : stage === "ownership"
          ? ownership.blockNextReserve()
          : persistence.blockNextQueuedWrite();
      const startedAt = Date.now();
      const timed = manager.runForeground(request(`root-deadline-${stage}`, stage, {
        timeoutMs: stage === "list" ? 10 : 100,
        writePaths: stage === "list" ? [] : [`src/${stage}.ts`]
      }));
      await gate.entered;

      // When
      await after(stage === "list" ? 75 : 125);
      gate.release();
      const result = await timed;

      // Then
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(stage === "list" ? 70 : 120);
      expect(result).toMatchObject({ ok: false, error: { code: "TASK_ERROR" } });
      expect(factoryCalls).toBe(0);
      expect(runnerCalls).toBe(0);
      const records = persistence.snapshot().filter(record => record.rootSessionId === `root-deadline-${stage}`);
      expect(records).toEqual(stage === "queued-write"
        ? [expect.objectContaining({ status: "timed_out" })]
        : []);
    }
  );

  it("preserves committed ChildRunner success when the manager timeout fires before the result is observed", async () => {
    // Given
    const { manager, taskStore } = await managerHarness({
      createRunner: () => ({
        run: async (_agent, _prompt, sessionId) => {
          await after(1_100);
          // ChildRunner ok models AgentRunner returning only after Task 9 durable finalization commits.
          return { ok: true, value: { sessionId, response: "late success", toolExecutions: [] } };
        }
      })
    });

    // When
    const result = await manager.runForeground(request("root-running-absolute-timeout", "late", { timeoutMs: 1_000 }));

    // Then
    expect(result).toMatchObject({ ok: true, value: { status: "succeeded", text: "late success" } });
    if (!result.ok) throw result.error;
    await expect(taskStore.read(result.value.taskId)).resolves.toMatchObject({
      ok: true,
      value: { status: "succeeded" }
    });
  });
});

describe("task manager Unicode terminal errors", () => {
  it("persists a 3,000-emoji runner failure as one bounded frozen failed envelope", async () => {
    // Given
    const message = "😀".repeat(3_000);
    const { manager, taskStore } = await managerHarness({
      createRunner: () => ({ run: async () => err(new StrongCodeError("MODEL_ERROR", message)) })
    });

    // When
    const result = await manager.runForeground(request("root-unicode-runner-error", "runner-error"));

    // Then
    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("failed");
    expect(result.value.error?.message.length).toBe(4_096);
    expect(result.value.error?.message).toBe("😀".repeat(2_048));
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.error)).toBe(true);
    const durable = await taskStore.read(result.value.taskId);
    expect(durable).toMatchObject({ ok: true, value: { status: "failed", error: { code: "MODEL_ERROR" } } });
    expect(JSON.parse(JSON.stringify(durable))).toBeDefined();
  });

  it("persists a Unicode-heavy createRunner failure without splitting a surrogate pair", async () => {
    // Given
    const message = `${"x".repeat(4_095)}😀tail`;
    const { manager, taskStore } = await managerHarness({
      createRunner: () => {
        throw new StrongCodeError("MODEL_ERROR", message);
      }
    });

    // When
    const result = await manager.runForeground(request("root-unicode-pre-run", "pre-run"));

    // Then
    expect(result).toMatchObject({ ok: false, error: { code: "MODEL_ERROR" } });
    if (result.ok) throw new Error("Expected createRunner failure");
    expect(result.error.message).toBe("x".repeat(4_095));
    const listed = await taskStore.list();
    if (!listed.ok) throw listed.error;
    expect(listed.value).toHaveLength(1);
    expect(listed.value[0]).toMatchObject({ status: "failed", error: { message: "x".repeat(4_095) } });
    expect(listed.value[0]?.error?.message.length).toBe(4_095);
  });
});
