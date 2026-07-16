import type { Agent } from "../src/agents/agent";
import { AgentRunner } from "../src/agents/runner";
import { ok } from "../src/core/result";
import type { ModelRequest, ModelResponse } from "../src/models/provider";
import type { RuntimeEventType } from "../src/runtime/events";
import type { SessionCommitGuard } from "../src/sessions/session-store";
import type { ConversationSessionEvent } from "../src/sessions/session";
import {
  continuationAgent,
  continuationTool,
  createContinuationHarness,
  scriptedProvider
} from "./runner-continuation-fixtures";

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>(resolve => {
    resolvePromise = resolve;
  });
  if (resolvePromise === undefined) throw new Error("Deferred resolver was not initialized");
  return { promise, resolve: resolvePromise };
}

describe("AgentRunner terminal state", () => {
  it("fails closed when resuming after an in-flight tool cancellation", async () => {
    // Given
    const harness = await createContinuationHarness(["helper"]);
    const controller = new AbortController();
    const started = deferred<void>();
    const late = deferred<ReturnType<typeof ok<{ content: string }>>>();
    const baseTool = continuationTool("helper", "unused", []);
    harness.registry.register({
      ...baseTool,
      async execute() {
        started.resolve(undefined);
        return late.promise;
      }
    });
    const firstModel = scriptedProvider([
      { message: "", toolCalls: [{ callId: "resume-cancelled-id", name: "helper", input: {} }] }
    ], []);
    const firstRunner = new AgentRunner(
      { ...harness.context, signal: controller.signal },
      harness.sessions,
      harness.registry
    );
    const pending = firstRunner.run(continuationAgent(harness.config, firstModel), "Start", "resume-cancelled");
    await started.promise;
    controller.abort();
    late.resolve(ok({ content: "late success" }));
    const cancelled = await pending;
    if (cancelled.ok) throw new Error("Expected cancellation");
    const resumeRequests: ModelRequest[] = [];
    const resumeRunner = new AgentRunner(harness.context, harness.sessions, harness.registry);
    const resumeModel = scriptedProvider([{ message: "Resumed", toolCalls: [] }], resumeRequests);

    // When
    const resumed = await resumeRunner.run(
      continuationAgent(harness.config, resumeModel),
      "Continue",
      "resume-cancelled"
    );

    // Then
    expect(resumed).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    expect(resumeRequests).toHaveLength(0);
  });

  it("cancels before forwarding the final assistant event to persistence", async () => {
    // Given
    const harness = await createContinuationHarness([]);
    const controller = new AbortController();
    const events: RuntimeEventType[] = [];
    const commit = harness.sessions.commitGuarded.bind(harness.sessions);
    vi.spyOn(harness.sessions, "commitGuarded").mockImplementation(
      (sessionId: string, event: ConversationSessionEvent | undefined, guard: SessionCommitGuard) => {
        controller.abort();
        return commit(sessionId, event, guard);
      }
    );
    const model = scriptedProvider([{ message: "Committed final", toolCalls: [] }], []);
    const runner = new AgentRunner(
      { ...harness.context, signal: controller.signal },
      harness.sessions,
      harness.registry,
      { emit: event => events.push(event.type) }
    );

    // When
    const result = await runner.run(continuationAgent(harness.config, model), "Start", "final-claim");

    // Then
    expect(result).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    const stored = await harness.sessions.read("final-claim");
    if (!stored.ok) throw stored.error;
    expect(stored.value.events.some(event => (
      event.type === "message" && event.role === "assistant" && event.content === "Committed final"
    ))).toBe(false);
    expect(events).toContain("run_cancelled");
    expect(events).not.toContain("run_finished");
  });

  it("emits run_failed when a closed runner rejects a run", async () => {
    // Given
    const harness = await createContinuationHarness([]);
    const events: RuntimeEventType[] = [];
    const complete = vi.fn(async (): Promise<ModelResponse> => ({ message: "must not run", toolCalls: [] }));
    const agent: Agent = { name: "default", config: harness.config, model: { name: "closed", complete } };
    const runner = new AgentRunner(harness.context, harness.sessions, harness.registry, {
      emit: event => events.push(event.type)
    });
    await runner.close();

    // When
    const result = await runner.run(agent, "Start", "closed-event");

    // Then
    expect(result).toMatchObject({ ok: false, error: { code: "MODEL_ERROR" } });
    expect(complete).not.toHaveBeenCalled();
    expect(events).toContain("run_failed");
    expect(events).not.toContain("run_finished");
  });
});
