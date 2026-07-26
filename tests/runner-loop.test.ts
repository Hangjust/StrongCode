import type { Agent } from "../src/agents/agent";
import { AgentRunner } from "../src/agents/runner";
import { resolveRunnerLoopLimits } from "../src/agents/runner-loop-limits";
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
  OneShotAppendFaultSessionStore,
  scriptedProvider
} from "./runner-continuation-fixtures";

const GENEROUS_LIMITS = {
  maxToolCalls: 8,
  maxSteps: 8,
  maxToolCallsPerStep: 8,
  maxTotalToolCalls: 8
} as const;

function failingTool(name: string, code: StrongCodeErrorCode, executions?: string[]): Tool {
  const tool = continuationTool(name, "unused", []);
  return {
    ...tool,
    async execute() {
      executions?.push(name);
      return err(new StrongCodeError(code, `${name} failed`));
    }
  };
}

describe("AgentRunner bounded model-tool loop", () => {
  it("defaults normal runs to a 500-call tool budget", () => {
    // Given / When
    const limits = resolveRunnerLoopLimits({});

    // Then
    expect(limits.maxToolCallsPerStep).toBe(500);
    expect(limits.maxTotalToolCalls).toBe(500);
  });

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

  it("continues a sequential batch after a recoverable tool failure", async () => {
    // Given
    const harness = await createContinuationHarness(["alpha", "beta"]);
    const executions: string[] = [];
    const requests: ModelRequest[] = [];
    harness.registry.register(failingTool("alpha", "TOOL_ERROR", executions));
    harness.registry.register(continuationTool("beta", "BETA_OK", executions));
    const model = scriptedProvider([
      {
        message: "",
        toolCalls: [
          { callId: "recoverable-alpha", name: "alpha", input: {} },
          { callId: "recoverable-beta", name: "beta", input: {} }
        ]
      },
      { message: "Recovered batch", toolCalls: [] }
    ], requests);
    const runner = new AgentRunner(harness.context, harness.sessions, harness.registry, GENEROUS_LIMITS);

    // When
    const result = await runner.run(continuationAgent(harness.config, model), "Start", "recoverable-batch");

    // Then
    expect(result).toMatchObject({ ok: true, value: { response: "Recovered batch" } });
    expect(executions).toEqual(["alpha", "beta"]);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.items?.slice(-4)).toEqual([
      { type: "tool_call", role: "assistant", callId: "recoverable-alpha", name: "alpha", input: {} },
      { type: "tool_call", role: "assistant", callId: "recoverable-beta", name: "beta", input: {} },
      {
        type: "tool_result",
        role: "tool",
        callId: "recoverable-alpha",
        content: "Tool failed [TOOL_ERROR]: alpha failed",
        isError: true
      },
      {
        type: "tool_result",
        role: "tool",
        callId: "recoverable-beta",
        content: "BETA_OK",
        isError: false
      }
    ]);
  });

  it("settles a terminal failure and skips later siblings in original call order", async () => {
    // Given
    const harness = await createContinuationHarness(["alpha", "beta", "gamma"]);
    const executions: string[] = [];
    const requests: ModelRequest[] = [];
    const events: RuntimeEventType[] = [];
    harness.registry.register(continuationTool("alpha", "ALPHA_OK", executions));
    harness.registry.register(failingTool("beta", "PERMISSION_DENIED", executions));
    harness.registry.register(continuationTool("gamma", "must not run", executions));
    const model = scriptedProvider([
      {
        message: "",
        toolCalls: [
          { callId: "terminal-alpha", name: "alpha", input: { secret: "ALPHA_INPUT_SECRET" } },
          { callId: "terminal-beta", name: "beta", input: { secret: "BETA_INPUT_SECRET" } },
          { callId: "terminal-gamma", name: "gamma", input: { secret: "GAMMA_INPUT_SECRET" } }
        ]
      },
      { message: "must not run", toolCalls: [] }
    ], requests);
    const runner = new AgentRunner(harness.context, harness.sessions, harness.registry, {
      ...GENEROUS_LIMITS,
      emit: event => events.push(event.type)
    });

    // When
    const result = await runner.run(continuationAgent(harness.config, model), "Start", "terminal-batch");
    const stored = await harness.sessions.read("terminal-batch");

    // Then
    expect(result).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    expect(requests).toHaveLength(1);
    expect(executions).toEqual(["alpha", "beta"]);
    expect(executions.filter(name => name === "gamma")).toHaveLength(0);
    if (!stored.ok) throw stored.error;
    const resultItems = stored.value.events.flatMap(event => (
      event.type === "conversation_item" && event.item.type === "tool_result" ? [event.item] : []
    ));
    expect(resultItems).toEqual([
      {
        type: "tool_result",
        role: "tool",
        callId: "terminal-alpha",
        content: "ALPHA_OK",
        isError: false
      },
      {
        type: "tool_result",
        role: "tool",
        callId: "terminal-beta",
        content: "Tool failed [PERMISSION_DENIED]: beta failed",
        isError: true
      },
      {
        type: "tool_result",
        role: "tool",
        callId: "terminal-gamma",
        content: "Tool skipped [PERMISSION_DENIED]: the batch stopped after a terminal failure; this tool did not run.",
        isError: true
      }
    ]);
    expect(JSON.stringify(resultItems)).not.toContain("INPUT_SECRET");
    expect(events.filter(event => event === "tool_started")).toHaveLength(2);
    expect(events.filter(event => event === "tool_finished")).toHaveLength(1);
    expect(events).not.toContain("run_finished");
  });

  it("reaches the provider on a same-session re-ask after terminal settlement", async () => {
    // Given
    const harness = await createContinuationHarness(["alpha", "beta", "gamma"]);
    const executions: string[] = [];
    const failedRunRequests: ModelRequest[] = [];
    const retryRequests: ModelRequest[] = [];
    harness.registry.register(continuationTool("alpha", "ALPHA_OK", executions));
    harness.registry.register(failingTool("beta", "PERMISSION_DENIED", executions));
    harness.registry.register(continuationTool("gamma", "must not run", executions));
    const failedRunModel = scriptedProvider([{
      message: "",
      toolCalls: [
        { callId: "retry-alpha", name: "alpha", input: {} },
        { callId: "retry-beta", name: "beta", input: {} },
        { callId: "retry-gamma", name: "gamma", input: {} }
      ]
    }], failedRunRequests);
    const retryModel: ModelProvider = {
      name: "retry-model",
      async complete(request) {
        retryRequests.push(request);
        return { message: "Retry completed", toolCalls: [] };
      }
    };
    const runner = new AgentRunner(harness.context, harness.sessions, harness.registry, GENEROUS_LIMITS);

    // When
    const failedRun = await runner.run(
      continuationAgent(harness.config, failedRunModel),
      "Start",
      "terminal-retry"
    );
    const retry = await runner.run(
      continuationAgent(harness.config, retryModel),
      "Try again",
      "terminal-retry"
    );

    // Then
    expect(failedRun).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    expect(retry).toMatchObject({ ok: true, value: { response: "Retry completed" } });
    expect(failedRunRequests).toHaveLength(1);
    expect(retryRequests).toHaveLength(1);
    expect(executions).toEqual(["alpha", "beta"]);
    expect(retryRequests[0]?.items?.filter(item => item.type === "tool_result")).toEqual([
      {
        type: "tool_result",
        role: "tool",
        callId: "retry-alpha",
        content: "ALPHA_OK",
        isError: false
      },
      {
        type: "tool_result",
        role: "tool",
        callId: "retry-beta",
        content: "Tool failed [PERMISSION_DENIED]: beta failed",
        isError: true
      },
      {
        type: "tool_result",
        role: "tool",
        callId: "retry-gamma",
        content: "Tool skipped [PERMISSION_DENIED]: the batch stopped after a terminal failure; this tool did not run.",
        isError: true
      }
    ]);
  });

  it("settles only calls whose response-item append succeeded", async () => {
    // Given
    const harness = await createContinuationHarness(["alpha", "beta", "gamma"]);
    const executions: string[] = [];
    const sessions = new OneShotAppendFaultSessionStore(harness.context.dataDir, {
      failAt: 3,
      message: "Injected beta call append failure"
    });
    harness.registry.register(continuationTool("alpha", "must not run", executions));
    harness.registry.register(continuationTool("beta", "must not run", executions));
    harness.registry.register(continuationTool("gamma", "must not run", executions));
    const model = scriptedProvider([{
      message: "",
      toolCalls: [
        { callId: "persisted-alpha", name: "alpha", input: {} },
        { callId: "failed-beta", name: "beta", input: {} },
        { callId: "unattempted-gamma", name: "gamma", input: {} }
      ]
    }], []);
    const runner = new AgentRunner(harness.context, sessions, harness.registry, GENEROUS_LIMITS);

    // When
    const result = await runner.run(continuationAgent(harness.config, model), "Start", "partial-call-append");
    const stored = await sessions.read("partial-call-append");

    // Then
    expect(result).toMatchObject({
      ok: false,
      error: { code: "SESSION_ERROR", message: "Injected beta call append failure" }
    });
    expect(executions).toEqual([]);
    expect(sessions.appendAttempts.flatMap(event => (
      event.type === "conversation_item" && event.item.type === "tool_call" ? [event.item.callId] : []
    ))).toEqual(["persisted-alpha", "failed-beta"]);
    expect(sessions.appendAttempts.flatMap(event => (
      event.type === "conversation_item" && event.item.type === "tool_result" ? [event.item.callId] : []
    ))).toEqual(["persisted-alpha"]);
    if (!stored.ok) throw stored.error;
    expect(stored.value.events.flatMap(event => (
      event.type === "conversation_item" && event.item.type === "tool_call" ? [event.item.callId] : []
    ))).toEqual(["persisted-alpha"]);
    expect(stored.value.events.flatMap(event => (
      event.type === "conversation_item" && event.item.type === "tool_result" ? [event.item] : []
    ))).toEqual([{
      type: "tool_result",
      role: "tool",
      callId: "persisted-alpha",
      content: "Tool skipped [SESSION_ERROR]: the batch stopped after a terminal failure; this tool did not run.",
      isError: true
    }]);
  });

  it.each([
    { interruption: "cancellation", code: "CANCELLED" },
    { interruption: "close", code: "MODEL_ERROR" }
  ] as const)("settles the persisted subset on $interruption between response-item appends", async ({
    interruption,
    code
  }) => {
    // Given
    const harness = await createContinuationHarness(["alpha", "beta"]);
    const controller = new AbortController();
    const executions: string[] = [];
    let closeRunner: (() => void) | undefined;
    let closePromise: Promise<void> | undefined;
    const sessions = new OneShotAppendFaultSessionStore(harness.context.dataDir, {
      failAt: 99,
      message: "Unused append fault",
      afterSuccessfulAppend: ({ invocation }) => {
        if (invocation !== 2) return;
        switch (interruption) {
          case "cancellation":
            controller.abort();
            break;
          case "close":
            closeRunner?.();
            break;
          default: {
            const exhaustiveInterruption: never = interruption;
            return exhaustiveInterruption;
          }
        }
      }
    });
    harness.registry.register(continuationTool("alpha", "must not run", executions));
    harness.registry.register(continuationTool("beta", "must not run", executions));
    const model = scriptedProvider([{
      message: "",
      toolCalls: [
        { callId: `${interruption}-alpha`, name: "alpha", input: {} },
        { callId: `${interruption}-beta`, name: "beta", input: {} }
      ]
    }], []);
    const runner = new AgentRunner(
      { ...harness.context, signal: controller.signal },
      sessions,
      harness.registry,
      GENEROUS_LIMITS
    );
    closeRunner = () => {
      closePromise = runner.close();
    };

    // When
    const result = await runner.run(
      continuationAgent(harness.config, model),
      "Start",
      `${interruption}-during-response-append`
    );
    if (closePromise !== undefined) await closePromise;
    const stored = await sessions.read(`${interruption}-during-response-append`);

    // Then
    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(executions).toEqual([]);
    expect(sessions.appendAttempts.flatMap(event => (
      event.type === "conversation_item" && event.item.type === "tool_call" ? [event.item.callId] : []
    ))).toEqual([`${interruption}-alpha`]);
    expect(sessions.appendAttempts.flatMap(event => (
      event.type === "conversation_item" && event.item.type === "tool_result" ? [event.item.callId] : []
    ))).toEqual([`${interruption}-alpha`]);
    if (!stored.ok) throw stored.error;
    expect(stored.value.events.flatMap(event => (
      event.type === "conversation_item" && event.item.type === "tool_result" ? [event.item.callId] : []
    ))).toEqual([`${interruption}-alpha`]);
  });

  it("returns a settlement append failure without retrying the append", async () => {
    // Given
    const harness = await createContinuationHarness(["alpha", "beta", "gamma"]);
    const executions: string[] = [];
    const requests: ModelRequest[] = [];
    const sessions = new OneShotAppendFaultSessionStore(harness.context.dataDir, {
      failAt: 6,
      message: "Injected terminal result append failure"
    });
    harness.registry.register(continuationTool("alpha", "ALPHA_OK", executions));
    harness.registry.register(failingTool("beta", "PERMISSION_DENIED", executions));
    harness.registry.register(continuationTool("gamma", "must not run", executions));
    const model = scriptedProvider([{
      message: "",
      toolCalls: [
        { callId: "terminal-alpha", name: "alpha", input: {} },
        { callId: "terminal-beta", name: "beta", input: {} },
        { callId: "terminal-gamma", name: "gamma", input: {} }
      ]
    }], requests);
    const runner = new AgentRunner(harness.context, sessions, harness.registry, GENEROUS_LIMITS);

    // When
    const result = await runner.run(continuationAgent(harness.config, model), "Start", "terminal-append-failure");
    const stored = await sessions.read("terminal-append-failure");

    // Then
    expect(result).toMatchObject({
      ok: false,
      error: { code: "SESSION_ERROR", message: "Injected terminal result append failure" }
    });
    expect(sessions.appendAttempts.flatMap(event => (
      event.type === "conversation_item" && event.item.type === "tool_result" ? [event.item.callId] : []
    ))).toEqual(["terminal-alpha", "terminal-beta", "terminal-gamma"]);
    expect(requests).toHaveLength(1);
    expect(executions).toEqual(["alpha", "beta"]);
    if (!stored.ok) throw stored.error;
    expect(stored.value.events.flatMap(event => (
      event.type === "conversation_item" && event.item.type === "tool_result" ? [event.item.callId] : []
    ))).toEqual(["terminal-alpha", "terminal-gamma"]);
  });

  it("does not retry a failed sibling settlement and settles only untouched calls", async () => {
    // Given
    const harness = await createContinuationHarness(["alpha", "beta", "gamma"]);
    const controller = new AbortController();
    const executions: string[] = [];
    const sessions = new OneShotAppendFaultSessionStore(harness.context.dataDir, {
      failAt: 6,
      message: "Injected second sibling settlement failure",
      afterSuccessfulAppend: ({ invocation }) => {
        if (invocation === 4) controller.abort();
      }
    });
    harness.registry.register(continuationTool("alpha", "must not run", executions));
    harness.registry.register(continuationTool("beta", "must not run", executions));
    harness.registry.register(continuationTool("gamma", "must not run", executions));
    const model = scriptedProvider([{
      message: "",
      toolCalls: [
        { callId: "settlement-alpha", name: "alpha", input: {} },
        { callId: "settlement-beta", name: "beta", input: {} },
        { callId: "settlement-gamma", name: "gamma", input: {} }
      ]
    }], []);
    const runner = new AgentRunner(
      { ...harness.context, signal: controller.signal },
      sessions,
      harness.registry,
      GENEROUS_LIMITS
    );

    // When
    const result = await runner.run(continuationAgent(harness.config, model), "Start", "partial-settlement");
    const stored = await sessions.read("partial-settlement");

    // Then
    expect(result).toMatchObject({
      ok: false,
      error: { code: "SESSION_ERROR", message: "Injected second sibling settlement failure" }
    });
    expect(executions).toEqual([]);
    expect(sessions.appendAttempts.flatMap(event => (
      event.type === "conversation_item" && event.item.type === "tool_result" ? [event.item.callId] : []
    ))).toEqual(["settlement-alpha", "settlement-beta", "settlement-gamma"]);
    if (!stored.ok) throw stored.error;
    expect(stored.value.events.flatMap(event => (
      event.type === "conversation_item" && event.item.type === "tool_result" ? [event.item.callId] : []
    ))).toEqual(["settlement-alpha", "settlement-gamma"]);
  });

  it.each([
    "PERMISSION_DENIED",
    "NESTED_SPAWN_DENIED",
    "SESSION_ERROR",
    "MODEL_ERROR",
    "CANCELLED",
    "MODEL_STEP_LIMIT",
    "TOOL_STEP_LIMIT",
    "TOOL_TOTAL_LIMIT",
    "TOOL_LOOP_DETECTED"
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
    expect(stored.value.events).toContainEqual(expect.objectContaining({
      type: "conversation_item",
      item: {
        type: "tool_result",
        role: "tool",
        callId: `terminal-${code}`,
        content: `Tool failed [${code}]: helper failed`,
        isError: true
      }
    }));
    expect(events).not.toContain("tool_finished");
    expect(events).not.toContain("run_finished");
    expect(events).toContain(code === "CANCELLED" ? "run_cancelled" : "run_failed");
  });
});
