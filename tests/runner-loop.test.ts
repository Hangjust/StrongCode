import type { Agent } from "../src/agents/agent";
import { AgentRunner } from "../src/agents/runner";
import { StrongCodeError, type StrongCodeErrorCode } from "../src/core/errors";
import { err } from "../src/core/result";
import type { ModelProvider, ModelRequest, ModelResponse } from "../src/models/provider";
import type { RuntimeEventType } from "../src/runtime/events";
import type { AttemptCreatedEvent } from "../src/sessions/session-ledger-events";
import type { Tool } from "../src/tools/tool";
import {
  continuationAgent,
  continuationTool,
  createContinuationHarness,
  scriptedProvider
} from "./runner-continuation-fixtures";

const GENEROUS_LIMITS = {
  maxToolCalls: 8,
  maxSteps: 8,
  maxToolCallsPerStep: 8,
  maxTotalToolCalls: 8
} as const;

function failingTool(name: string, code: StrongCodeErrorCode): Tool {
  const tool = continuationTool(name, "unused", []);
  return {
    ...tool,
    async execute() {
      return err(new StrongCodeError(code, `${name} failed`));
    }
  };
}

describe("AgentRunner bounded model-tool loop", () => {
  it("returns a final answer after exactly two correlated completions", async () => {
    // Given
    const firstReasoning = "Inspect the helper before answering.";
    const finalReasoning = "Use the helper result in the final answer.";
    const harness = await createContinuationHarness(["helper"]);
    const executions: string[] = [];
    const requests: ModelRequest[] = [];
    harness.registry.register(continuationTool("helper", "HELPER_OK", executions));
    const model: ModelProvider = {
      name: "two-completion-model",
      async complete(request): Promise<ModelResponse> {
        requests.push(request);
        if (requests.length === 1) {
          return {
            message: "",
            toolCalls: [{ callId: "native-helper-id", name: "helper", input: { task: "inspect" } }],
            reasoning: firstReasoning
          };
        }
        let helperContent = "MISSING";
        for (const item of request.items ?? []) {
          if (item.type === "tool_result" && item.callId === "native-helper-id") helperContent = item.content;
        }
        return { message: `FINAL: ${helperContent}`, toolCalls: [], reasoning: finalReasoning };
      }
    };
    const runner = new AgentRunner(harness.context, harness.sessions, harness.registry, GENEROUS_LIMITS);

    // When
    const result = await runner.run(continuationAgent(harness.config, model), "Use helper", "two-completions");

    // Then
    if (!result.ok) throw result.error;
    expect(result.value.response).toBe("FINAL: HELPER_OK");
    expect(result.value.reasoning).toBe(`${firstReasoning}\n\n${finalReasoning}`);
    expect(requests).toHaveLength(2);
    expect(executions).toEqual(["helper"]);
    expect(requests[1]?.items?.slice(-2)).toEqual([
      { type: "tool_call", role: "assistant", callId: "native-helper-id", name: "helper", input: { task: "inspect" } },
      { type: "tool_result", role: "tool", callId: "native-helper-id", content: "HELPER_OK", isError: false }
    ]);
    expect(JSON.stringify({ items: requests[1]?.items, messages: requests[1]?.messages })).not.toContain(firstReasoning);
    expect(JSON.stringify({ items: requests[1]?.items, messages: requests[1]?.messages })).not.toContain(finalReasoning);
    const stored = await harness.sessions.read("two-completions");
    if (!stored.ok) throw stored.error;
    const primaryAttempts = stored.value.events.filter((event): event is AttemptCreatedEvent => (
      event.type === "attempt_created" && event.role === "primary"
    ));
    const conversationEvents = stored.value.events.filter(event => (
      event.type === "message" || event.type === "conversation_item"
    ));
    expect(JSON.stringify(conversationEvents)).not.toContain(firstReasoning);
    expect(JSON.stringify(conversationEvents)).not.toContain(finalReasoning);
    expect(primaryAttempts).toHaveLength(2);
    expect(primaryAttempts[1]?.parentAttemptId).toBe(primaryAttempts[0]?.attemptId);
  });

  it("stops before a model completion beyond maxSteps", async () => {
    // Given
    const harness = await createContinuationHarness(["helper"]);
    const requests: ModelRequest[] = [];
    harness.registry.register(continuationTool("helper", "HELPER_OK", []));
    const model = scriptedProvider([
      {
        message: "",
        toolCalls: [{ callId: "step-one", name: "helper", input: {} }],
        reasoning: "Partial reasoning must stay private."
      },
      { message: "must not run", toolCalls: [] }
    ], requests);
    const limits = { ...GENEROUS_LIMITS, maxSteps: 1 };
    const runner = new AgentRunner(harness.context, harness.sessions, harness.registry, limits);

    // When
    const result = await runner.run(continuationAgent(harness.config, model), "Start", "max-steps");

    // Then
    expect(result).toMatchObject({ ok: false, error: { code: "MODEL_STEP_LIMIT" } });
    expect(JSON.stringify(result)).not.toContain("Partial reasoning must stay private.");
    expect(requests).toHaveLength(1);
  });

  it("rejects a batch beyond the per-step tool-call limit", async () => {
    // Given
    const harness = await createContinuationHarness(["alpha", "beta"]);
    const executions: string[] = [];
    harness.registry.register(continuationTool("alpha", "A", executions));
    harness.registry.register(continuationTool("beta", "B", executions));
    const limits = { ...GENEROUS_LIMITS, maxToolCallsPerStep: 1 };
    const model = scriptedProvider([{
      message: "",
      toolCalls: [
        { callId: "per-step-a", name: "alpha", input: {} },
        { callId: "per-step-b", name: "beta", input: {} }
      ]
    }], []);
    const runner = new AgentRunner(harness.context, harness.sessions, harness.registry, limits);

    // When
    const result = await runner.run(continuationAgent(harness.config, model), "Start", "per-step-limit");

    // Then
    expect(result).toMatchObject({ ok: false, error: { code: "TOOL_STEP_LIMIT" } });
    expect(executions).toEqual([]);
  });

  it("rejects calls beyond the total tool-call limit", async () => {
    // Given
    const harness = await createContinuationHarness(["helper"]);
    const executions: string[] = [];
    const requests: ModelRequest[] = [];
    harness.registry.register(continuationTool("helper", "HELPER_OK", executions));
    const model = scriptedProvider([
      { message: "", toolCalls: [{ callId: "total-one", name: "helper", input: { value: 1 } }] },
      { message: "", toolCalls: [{ callId: "total-two", name: "helper", input: { value: 2 } }] }
    ], requests);
    const limits = { ...GENEROUS_LIMITS, maxTotalToolCalls: 1 };
    const runner = new AgentRunner(harness.context, harness.sessions, harness.registry, limits);

    // When
    const result = await runner.run(continuationAgent(harness.config, model), "Start", "total-limit");

    // Then
    expect(result).toMatchObject({ ok: false, error: { code: "TOOL_TOTAL_LIMIT" } });
    expect(requests).toHaveLength(2);
    expect(executions).toEqual(["helper"]);
  });

  it("detects an identical call set before executing it twice", async () => {
    // Given
    const harness = await createContinuationHarness(["helper"]);
    const executions: string[] = [];
    harness.registry.register(continuationTool("helper", "HELPER_OK", executions));
    const model = scriptedProvider([
      { message: "", toolCalls: [{ callId: "loop-one", name: "helper", input: { a: 1, b: 2 } }] },
      { message: "", toolCalls: [{ callId: "loop-two", name: "helper", input: { b: 2, a: 1 } }] }
    ], []);
    const runner = new AgentRunner(harness.context, harness.sessions, harness.registry, GENEROUS_LIMITS);

    // When
    const result = await runner.run(continuationAgent(harness.config, model), "Start", "identical-loop");

    // Then
    expect(result).toMatchObject({ ok: false, error: { code: "TOOL_LOOP_DETECTED" } });
    expect(executions).toEqual(["helper"]);
  });

  it("returns recoverable tool failures as correlated error results", async () => {
    // Given
    const harness = await createContinuationHarness(["helper"]);
    const requests: ModelRequest[] = [];
    harness.registry.register(failingTool("helper", "TOOL_ERROR"));
    const model: ModelProvider = {
      name: "recoverable-model",
      async complete(request) {
        requests.push(request);
        return requests.length === 1
          ? { message: "", toolCalls: [{ callId: "recoverable-id", name: "helper", input: {} }] }
          : { message: "Recovered", toolCalls: [] };
      }
    };
    const runner = new AgentRunner(harness.context, harness.sessions, harness.registry, GENEROUS_LIMITS);

    // When
    const result = await runner.run(continuationAgent(harness.config, model), "Start", "recoverable-error");

    // Then
    expect(result).toMatchObject({ ok: true, value: { response: "Recovered" } });
    if (!result.ok) throw result.error;
    expect(Object.hasOwn(result.value, "reasoning")).toBe(false);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.items?.at(-1)).toMatchObject({
      type: "tool_result",
      callId: "recoverable-id",
      isError: true,
      content: expect.stringContaining("TOOL_ERROR")
    });
  });

  it.each([
    "PERMISSION_DENIED",
    "NESTED_SPAWN_DENIED",
    "SESSION_ERROR",
    "MODEL_ERROR",
    "CANCELLED"
  ] satisfies readonly StrongCodeErrorCode[])("terminates on %s tool failures", async code => {
    // Given
    const harness = await createContinuationHarness(["helper"]);
    const events: RuntimeEventType[] = [];
    harness.registry.register(failingTool("helper", code));
    const requests: ModelRequest[] = [];
    const model = scriptedProvider([
      { message: "", toolCalls: [{ callId: `terminal-${code}`, name: "helper", input: {} }] },
      { message: "must not run", toolCalls: [] }
    ], requests);
    const options = { ...GENEROUS_LIMITS, emit: (event: { readonly type: RuntimeEventType }) => events.push(event.type) };
    const runner = new AgentRunner(harness.context, harness.sessions, harness.registry, options);

    // When
    const result = await runner.run(continuationAgent(harness.config, model), "Start", `terminal-${code}`);
    const stored = await harness.sessions.read(`terminal-${code}`);

    // Then
    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(requests).toHaveLength(1);
    if (!stored.ok) throw stored.error;
    expect(stored.value.events).not.toContainEqual(expect.objectContaining({
      type: "conversation_item",
      item: expect.objectContaining({ type: "tool_result", callId: `terminal-${code}` })
    }));
    expect(events).not.toContain("run_finished");
    expect(events).toContain(code === "CANCELLED" ? "run_cancelled" : "run_failed");
  });
});
