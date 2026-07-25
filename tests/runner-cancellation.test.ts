import type { Agent } from "../src/agents/agent";
import { AgentRunner } from "../src/agents/runner";
import { ok } from "../src/core/result";
import type { ConversationToolResultItem } from "../src/core/types";
import type { ModelRequest, ModelResponse } from "../src/models/provider";
import type { RuntimeEventType } from "../src/runtime/events";
import type { SessionEvent } from "../src/sessions/session";
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

function options(events: RuntimeEventType[]) {
  return {
    maxToolCalls: 4,
    maxSteps: 4,
    maxToolCallsPerStep: 4,
    maxTotalToolCalls: 4,
    emit: (event: { readonly type: RuntimeEventType }) => events.push(event.type)
  } as const;
}

function expectCancelled(events: readonly RuntimeEventType[]): void {
  expect(events).toContain("run_cancelled");
  expect(events).not.toContain("run_finished");
}

function toolResults(events: readonly SessionEvent[]): readonly ConversationToolResultItem[] {
  return events.flatMap(event => (
    event.type === "conversation_item" && event.item.type === "tool_result" ? [event.item] : []
  ));
}

describe("AgentRunner cancellation", () => {
  it("does not call the provider when already aborted", async () => {
    // Given
    const harness = await createContinuationHarness([]);
    const controller = new AbortController();
    controller.abort();
    const complete = vi.fn(async (): Promise<ModelResponse> => ({ message: "late success", toolCalls: [] }));
    const agent: Agent = { name: "default", config: harness.config, model: { name: "pre-abort", complete } };
    const events: RuntimeEventType[] = [];
    const runner = new AgentRunner({ ...harness.context, signal: controller.signal }, harness.sessions, harness.registry, options(events));

    // When
    const result = await runner.run(agent, "Start", "pre-abort");

    // Then
    expect(result).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    expect(complete).not.toHaveBeenCalled();
    expectCancelled(events);
  });

  it("rejects a late provider success after in-flight abort", async () => {
    // Given
    const harness = await createContinuationHarness([]);
    const controller = new AbortController();
    const started = deferred<void>();
    const late = deferred<ModelResponse>();
    let seenSignal: AbortSignal | undefined;
    const agent: Agent = {
      name: "default",
      config: harness.config,
      model: {
        name: "in-flight-provider",
        async complete(request) {
          seenSignal = request.signal;
          started.resolve(undefined);
          return late.promise;
        }
      }
    };
    const events: RuntimeEventType[] = [];
    const runner = new AgentRunner({ ...harness.context, signal: controller.signal }, harness.sessions, harness.registry, options(events));

    // When
    const pending = runner.run(agent, "Start", "provider-abort");
    await started.promise;
    controller.abort();
    late.resolve({ message: "late success", toolCalls: [] });
    const result = await pending;

    // Then
    expect(seenSignal).toBe(controller.signal);
    expect(result).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    const stored = await harness.sessions.read("provider-abort");
    if (!stored.ok) throw stored.error;
    expect(stored.value.events.filter(event => event.type === "message" || event.type === "conversation_item"))
      .toEqual([expect.objectContaining({ type: "message", role: "user" })]);
    expect(stored.value.events.filter(event => event.type === "attempt_created" && event.role === "primary")).toHaveLength(1);
    expectCancelled(events);
  });

  it("rejects a late tool success after in-flight abort", async () => {
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
    const requests: ModelRequest[] = [];
    const model = scriptedProvider([
      { message: "", toolCalls: [{ callId: "tool-abort-id", name: "helper", input: {} }] },
      { message: "late success", toolCalls: [] }
    ], requests);
    const events: RuntimeEventType[] = [];
    const runner = new AgentRunner({ ...harness.context, signal: controller.signal }, harness.sessions, harness.registry, options(events));

    // When
    const pending = runner.run(continuationAgent(harness.config, model), "Start", "tool-abort");
    await started.promise;
    controller.abort();
    late.resolve(ok({ content: "late tool success" }));
    const result = await pending;

    // Then
    expect(result).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    expect(requests).toHaveLength(1);
    const stored = await harness.sessions.read("tool-abort");
    if (!stored.ok) throw stored.error;
    expect(toolResults(stored.value.events)).toEqual([{
      type: "tool_result",
      role: "tool",
      callId: "tool-abort-id",
      content: "Tool interrupted [CANCELLED]: execution may have completed, but no reliable result was recorded; StrongCode will not retry it automatically.",
      isError: true
    }]);
    expectCancelled(events);
    expect(events).not.toContain("tool_finished");
  });

  it("skips every persisted call when cancelled before the first execution", async () => {
    // Given
    const harness = await createContinuationHarness(["alpha", "beta"]);
    const controller = new AbortController();
    const executions: string[] = [];
    const resultAppendCalls: string[] = [];
    harness.registry.register(continuationTool("alpha", "must not run", executions));
    harness.registry.register(continuationTool("beta", "must not run", executions));
    const append = harness.sessions.append.bind(harness.sessions);
    vi.spyOn(harness.sessions, "append").mockImplementation(async (sessionId, event) => {
      const result = await append(sessionId, event);
      if (event.type === "conversation_item" && event.item.type === "tool_call" && event.item.callId === "pre-beta") {
        controller.abort();
      }
      if (event.type === "conversation_item" && event.item.type === "tool_result") {
        resultAppendCalls.push(event.item.callId);
      }
      return result;
    });
    const requests: ModelRequest[] = [];
    const model = scriptedProvider([{
      message: "",
      toolCalls: [
        { callId: "pre-alpha", name: "alpha", input: {} },
        { callId: "pre-beta", name: "beta", input: {} }
      ]
    }], requests);
    const events: RuntimeEventType[] = [];
    const runner = new AgentRunner({ ...harness.context, signal: controller.signal }, harness.sessions, harness.registry, options(events));

    // When
    const result = await runner.run(continuationAgent(harness.config, model), "Start", "pre-tool-abort");

    // Then
    expect(result).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    expect(requests).toHaveLength(1);
    expect(executions).toEqual([]);
    const stored = await harness.sessions.read("pre-tool-abort");
    if (!stored.ok) throw stored.error;
    expect(toolResults(stored.value.events).map(item => [item.callId, item.content, item.isError])).toEqual([
      ["pre-alpha", "Tool skipped [CANCELLED]: the batch stopped after a terminal failure; this tool did not run.", true],
      ["pre-beta", "Tool skipped [CANCELLED]: the batch stopped after a terminal failure; this tool did not run.", true]
    ]);
    expect(resultAppendCalls).toEqual(["pre-alpha", "pre-beta"]);
    expect(events).not.toContain("tool_started");
    expect(events).not.toContain("tool_finished");
    expectCancelled(events);
  });

  it("settles later siblings as skipped when cancellation lands between calls", async () => {
    // Given
    const harness = await createContinuationHarness(["alpha", "beta"]);
    const controller = new AbortController();
    const executions: string[] = [];
    harness.registry.register(continuationTool("alpha", "ALPHA_OK", executions));
    harness.registry.register(continuationTool("beta", "must not run", executions));
    const append = harness.sessions.append.bind(harness.sessions);
    vi.spyOn(harness.sessions, "append").mockImplementation(async (sessionId, event) => {
      const result = await append(sessionId, event);
      if (result.ok
        && event.type === "conversation_item"
        && event.item.type === "tool_result"
        && event.item.callId === "between-alpha") {
        controller.abort();
      }
      return result;
    });
    const requests: ModelRequest[] = [];
    const model = scriptedProvider([{
      message: "",
      toolCalls: [
        { callId: "between-alpha", name: "alpha", input: {} },
        { callId: "between-beta", name: "beta", input: {} }
      ]
    }], requests);
    const events: RuntimeEventType[] = [];
    const runner = new AgentRunner({ ...harness.context, signal: controller.signal }, harness.sessions, harness.registry, options(events));

    // When
    const result = await runner.run(continuationAgent(harness.config, model), "Start", "between-tool-abort");

    // Then
    expect(result).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    expect(requests).toHaveLength(1);
    expect(executions).toEqual(["alpha"]);
    const stored = await harness.sessions.read("between-tool-abort");
    if (!stored.ok) throw stored.error;
    expect(toolResults(stored.value.events).map(item => [item.callId, item.content, item.isError])).toEqual([
      ["between-alpha", "ALPHA_OK", false],
      ["between-beta", "Tool skipped [CANCELLED]: the batch stopped after a terminal failure; this tool did not run.", true]
    ]);
    expect(events.filter(event => event === "tool_started")).toHaveLength(1);
    expect(events.filter(event => event === "tool_finished")).toHaveLength(1);
    expectCancelled(events);
  });

  it("stops after a persisted tool result when aborted before the final completion", async () => {
    // Given
    const harness = await createContinuationHarness(["helper"]);
    const controller = new AbortController();
    harness.registry.register(continuationTool("helper", "HELPER_OK", []));
    const append = harness.sessions.append.bind(harness.sessions);
    vi.spyOn(harness.sessions, "append").mockImplementation(async (sessionId, event) => {
      const result = await append(sessionId, event);
      if (result.ok && event.type === "conversation_item" && event.item.type === "tool_result") controller.abort();
      return result;
    });
    const requests: ModelRequest[] = [];
    const partialReasoning = "Partial reasoning must not escape cancellation.";
    const model = scriptedProvider([
      {
        message: "",
        toolCalls: [{ callId: "after-tool-id", name: "helper", input: {} }],
        reasoning: partialReasoning
      },
      { message: "late final", toolCalls: [] }
    ], requests);
    const events: RuntimeEventType[] = [];
    const runner = new AgentRunner({ ...harness.context, signal: controller.signal }, harness.sessions, harness.registry, options(events));

    // When
    const result = await runner.run(continuationAgent(harness.config, model), "Start", "after-tool-abort");

    // Then
    expect(result).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    expect(JSON.stringify(result)).not.toContain(partialReasoning);
    expect(requests).toHaveLength(1);
    const stored = await harness.sessions.read("after-tool-abort");
    if (!stored.ok) throw stored.error;
    expect(stored.value.events.some(event => event.type === "message" && event.role === "assistant" && event.content === "late final")).toBe(false);
    expectCancelled(events);
  });
});
