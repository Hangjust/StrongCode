import { StrongCodeError } from "../src/core/errors";
import { err, ok, type Result } from "../src/core/result";
import { parseTaskRecord, type TaskRecord } from "../src/tasks/types";
import type { TaskPersistence } from "../src/tasks/admission";
import { ControlledRuns, managerHarness, MemoryTaskPersistence, request } from "./fixtures/task-manager-harness";
import "./task-manager-admission-cases";
import "./task-manager-oracle-cases";
import "./task-manager-race-cases";

class FailingPersistence implements TaskPersistence {
  readonly records: TaskRecord[] = [];
  failWrite = 2;
  private writes = 0;

  async write(record: unknown): Promise<Result<void>> {
    this.writes += 1;
    if (this.writes === this.failWrite) return err(new StrongCodeError("TASK_ERROR", "persistence failed"));
    this.records.push(parseTaskRecord(record));
    return ok(undefined);
  }

  async list(): Promise<Result<TaskRecord[]>> {
    return ok([...this.records]);
  }
}

describe("task manager foreground execution", () => {
  it.each([
    [12_000, false],
    [12_001, true],
    [0, false]
  ] as const)("bounds a %i-character result and retains its durable session pointer", async (length, truncated) => {
    // Given
    const output = "x".repeat(length);
    const { manager, taskStore } = await managerHarness({
      createRunner: () => ({
        run: async (_agent, _prompt, sessionId) => ok({ sessionId, response: output, toolExecutions: [] })
      })
    });

    // When
    const result = await manager.runForeground(request(`root-output-${length}`, "output"));

    // Then
    expect(result).toMatchObject({
      ok: true,
      value: {
        status: "succeeded",
        text: "x".repeat(Math.min(length, 12_000)),
        outputChars: length,
        truncated
      }
    });
    if (!result.ok) return;
    expect(result.value.fullResultPointer).toBe(`sessions/${result.value.childSessionId}.jsonl`);
    expect((await taskStore.read(result.value.taskId))).toMatchObject({
      ok: true,
      value: { artifactPointer: result.value.fullResultPointer, resultMetadata: { truncated } }
    });
  });

  it("truncates on Unicode code-point boundaries and deeply freezes the envelope", async () => {
    // Given
    const output = `${"a".repeat(11_999)}😀z`;
    const { manager } = await managerHarness({
      createRunner: () => ({
        run: async (_agent, _prompt, sessionId) => ok({ sessionId, response: output, toolExecutions: [] })
      })
    });

    // When
    const result = await manager.runForeground(request("root-unicode", "unicode"));

    // Then
    if (!result.ok) throw result.error;
    expect(result.value.text).toBe("a".repeat(11_999));
    expect(result.value.outputChars).toBe(12_001);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.target)).toBe(true);
    expect(Object.isFrozen(result.value.timestamps)).toBe(true);
  });

  it("returns one failed envelope for a child error and a runner throw", async () => {
    // Given
    let shouldThrow = false;
    const { manager } = await managerHarness({
      createRunner: () => ({
        run: async () => {
          if (shouldThrow) throw new StrongCodeError("MODEL_ERROR", "runner threw");
          return err(new StrongCodeError("MODEL_ERROR", "child failed"));
        }
      })
    });

    // When
    const returned = await manager.runForeground(request("root-errors", "returned"));
    shouldThrow = true;
    const thrown = await manager.runForeground(request("root-errors", "thrown"));

    // Then
    expect(returned).toMatchObject({ ok: true, value: { status: "failed", error: { code: "MODEL_ERROR", message: "child failed" } } });
    expect(thrown).toMatchObject({ ok: true, value: { status: "failed", error: { code: "MODEL_ERROR", message: "runner threw" } } });
  });

  it.each(["timeout", "cancellation"] as const)("aborts running child work on %s and removes the parent listener", async kind => {
    // Given
    const parent = new AbortController();
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => {
      signalStarted = resolve;
    });
    const { manager } = await managerHarness({
      taskStore: new MemoryTaskPersistence(),
      createRunner: context => ({
        run: async () => new Promise(resolve => {
          signalStarted?.();
          context.signal?.addEventListener("abort", () => resolve(err(new StrongCodeError("CANCELLED", "aborted"))), { once: true });
        })
      })
    });
    const execution = manager.runForeground(request(`root-running-${kind}`, kind, {
      timeoutMs: kind === "timeout" ? 100 : 10_000,
      signal: parent.signal
    }));
    await started;

    // When
    if (kind === "cancellation") parent.abort("caller reason");

    // Then
    expect(await execution).toMatchObject({
      ok: true,
      value: {
        status: kind === "timeout" ? "timed_out" : "cancelled",
        ...(kind === "cancellation" ? { error: { message: "caller reason" } } : {})
      }
    });
  });

  it("does not invoke runner execution when running-state persistence fails", async () => {
    // Given
    const persistence = new FailingPersistence();
    let runnerCalls = 0;
    let childSignal: AbortSignal | undefined;
    const { manager } = await managerHarness({
      taskStore: persistence,
      limits: { enabled: true, maxActive: 1, maxChildrenPerRoot: 1, defaultTimeoutMs: 10_000, maxInlineResultChars: 12_000 },
      createRunner: context => {
        childSignal = context.signal;
        return {
          run: async () => {
          runnerCalls += 1;
          return err(new StrongCodeError("CANCELLED", "observed"));
          }
        };
      }
    });

    // When
    const result = await manager.runForeground(request("root-persist", "persist", { writePaths: ["src/persist.ts"] }));

    // Then
    expect(result).toMatchObject({ ok: false, error: { code: "TASK_ERROR", message: "persistence failed" } });
    expect(runnerCalls).toBe(0);
    expect(childSignal?.aborted).toBe(true);

    persistence.failWrite = 0;
    const replacement = await manager.runForeground(request("root-persist", "replacement", { writePaths: ["src/persist.ts"] }));

    expect(replacement).toMatchObject({ ok: true, value: { status: "failed" } });
    expect(runnerCalls).toBe(1);
  });

  it("normalizes a createRunner throw and releases pre-run reservations", async () => {
    // Given
    const persistence = new MemoryTaskPersistence();
    let shouldThrow = true;
    let runnerCalls = 0;
    const { manager } = await managerHarness({
      taskStore: persistence,
      limits: { enabled: true, maxActive: 1, maxChildrenPerRoot: 1, defaultTimeoutMs: 10_000, maxInlineResultChars: 12_000 },
      createRunner: () => {
        if (shouldThrow) throw new StrongCodeError("MODEL_ERROR", "runner construction failed");
        return {
          run: async () => {
            runnerCalls += 1;
            return err(new StrongCodeError("MODEL_ERROR", "replacement runner failed"));
          }
        };
      }
    });

    // When
    const failed = await manager.runForeground(request("root-runner-construction", "first", {
      writePaths: ["src/runner-construction.ts"]
    }));
    shouldThrow = false;
    const replacement = await manager.runForeground(request("root-runner-construction", "replacement", {
      writePaths: ["src/runner-construction.ts"]
    }));

    // Then
    expect(failed).toMatchObject({ ok: false, error: { code: "MODEL_ERROR", message: "runner construction failed" } });
    expect(persistence.snapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ rootSessionId: "root-runner-construction", status: "failed" })
    ]));
    expect(replacement).toMatchObject({ ok: true, value: { status: "failed" } });
    expect(runnerCalls).toBe(1);
  });

  it("treats duplicate terminal release as a no-op across fifty concurrent cycles", async () => {
    // Given
    const runs = new ControlledRuns();
    const { manager } = await managerHarness({ taskStore: new MemoryTaskPersistence(), createRunner: runs.createRunner });
    const executions = Array.from({ length: 50 }, (_, index) => (
      manager.runForeground(request(`root-stress-${index}`, `stress-${index}`))
    ));

    // When
    for (let index = 0; index < 50; index += 1) {
      await vi.waitFor(() => expect(runs.starts.length).toBeGreaterThan(index));
      runs.complete(index);
    }
    const results = await Promise.all(executions);

    // Then
    expect(results.every(result => result.ok)).toBe(true);
    expect(runs.maximumActive).toBeLessThanOrEqual(4);
    const reuse = manager.runForeground(request("root-stress-reuse", "reuse", { writePaths: ["src/reused.ts"] }));
    await vi.waitFor(() => expect(runs.starts.at(-1)).toBe("reuse"));
    runs.complete(50);
    expect((await reuse).ok).toBe(true);
    const reuseAgain = manager.runForeground(request("root-stress-reuse-again", "reuse-again", {
      writePaths: ["src/reused.ts"]
    }));
    await vi.waitFor(() => expect(runs.starts.at(-1)).toBe("reuse-again"));
    runs.complete(51);
    expect((await reuseAgain).ok).toBe(true);
  });
});
