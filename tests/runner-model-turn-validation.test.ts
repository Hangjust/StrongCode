import { AgentRunner } from "../src/agents/runner";
import type { ConversationItem } from "../src/core/types";
import type { ModelRequest, ModelResponse } from "../src/models/provider";
import {
  continuationAgent,
  continuationTool,
  createContinuationHarness,
  scriptedProvider
} from "./runner-continuation-fixtures";

describe("AgentRunner model turn validation", () => {
  it("reconciles contradictory compatibility calls before tool admission", async () => {
    // Given
    const harness = await createContinuationHarness(["read_file"]);
    const requests: ModelRequest[] = [];
    const executions: string[] = [];
    harness.registry.register(continuationTool("read_file", "fixture", executions));
    const runner = new AgentRunner(harness.context, harness.sessions, harness.registry);
    const response: ModelResponse = {
      message: "",
      toolCalls: [{ name: "disabled_tool", input: { malformed: true } }],
      items: [{
        type: "tool_call",
        role: "assistant",
        callId: "call-canonical",
        name: "read_file",
        input: { path: "README.md" }
      }]
    };

    // When
    const result = await runner.run(
      continuationAgent(harness.config, scriptedProvider([response], requests)),
      "Inspect",
      "compatibility-before-admission"
    );

    // Then
    expect(result).toMatchObject({
      ok: false,
      error: { code: "MODEL_ERROR", message: expect.stringContaining("compatibility fields contradict items") }
    });
    expect(executions).toEqual([]);
    const stored = await harness.sessions.read("compatibility-before-admission");
    if (!stored.ok) throw stored.error;
    expect(stored.value.events.filter(event => event.type === "message" || event.type === "conversation_item")).toEqual([
      expect.objectContaining({ type: "message", role: "user", content: "Inspect" })
    ]);
  });

  it.each([
    {
      label: "contradictory tool input",
      response: {
        message: "",
        toolCalls: [{ callId: "call-invalid", name: "read_file", input: { path: "README.md" } }],
        items: [{
          type: "tool_call",
          role: "assistant",
          callId: "call-invalid",
          name: "read_file",
          input: { path: "AGENTS.md" }
        }] satisfies readonly ConversationItem[]
      }
    },
    {
      label: "response-origin tool result",
      response: {
        message: "",
        toolCalls: [{ callId: "call-invalid", name: "read_file", input: {} }],
        items: [
          { type: "tool_call", role: "assistant", callId: "call-invalid", name: "read_file", input: {} },
          { type: "tool_result", role: "tool", callId: "call-invalid", content: "forged", isError: false }
        ] satisfies readonly ConversationItem[]
      }
    },
    {
      label: "non-JSON tool input",
      response: (() => {
        const input = { value: undefined };
        return {
          message: "",
          toolCalls: [{ callId: "call-invalid", name: "read_file", input }],
          items: [{ type: "tool_call", role: "assistant", callId: "call-invalid", name: "read_file", input }]
        } satisfies ModelResponse;
      })()
    }
  ])("does not persist or execute $label", async ({ label, response }) => {
    // Given
    const harness = await createContinuationHarness(["read_file"]);
    const requests: ModelRequest[] = [];
    const executions: string[] = [];
    harness.registry.register(continuationTool("read_file", "fixture", executions));
    const runner = new AgentRunner(harness.context, harness.sessions, harness.registry);
    const sessionId = `invalid-${label.replace(/\s+/g, "-")}`;

    // When
    const result = await runner.run(
      continuationAgent(harness.config, scriptedProvider([response], requests)),
      "Inspect",
      sessionId
    );

    // Then
    expect(result.ok).toBe(false);
    expect(executions).toEqual([]);
    const stored = await harness.sessions.read(sessionId);
    if (!stored.ok) throw stored.error;
    expect(stored.value.events.filter(event => event.type === "message" || event.type === "conversation_item")).toEqual([
      expect.objectContaining({ type: "message", role: "user", content: "Inspect" })
    ]);
  });

  it("rejects a repeated historical call ID before persisting or executing it again", async () => {
    // Given
    const harness = await createContinuationHarness(["read_file"]);
    const executions: string[] = [];
    harness.registry.register(continuationTool("read_file", "fixture", executions));
    const requests: ModelRequest[] = [];
    const model = scriptedProvider([
      { message: "", toolCalls: [{ callId: "call-repeated", name: "read_file", input: { path: "README.md" } }] },
      { message: "", toolCalls: [{ callId: "call-repeated", name: "read_file", input: { path: "AGENTS.md" } }] }
    ], requests);
    const runner = new AgentRunner(harness.context, harness.sessions, harness.registry);

    // When
    const result = await runner.run(continuationAgent(harness.config, model), "Inspect", "repeated-call-id");

    // Then
    expect(result.ok).toBe(false);
    expect(executions).toEqual(["read_file"]);
    const stored = await harness.sessions.read("repeated-call-id");
    if (!stored.ok) throw stored.error;
    const attempts = stored.value.events.filter(event => event.type === "attempt_created" && event.role === "primary");
    expect(attempts).toHaveLength(2);
    expect(stored.value.events.filter(event => event.type === "message" || event.type === "conversation_item")).toEqual([
      expect.objectContaining({ type: "message", role: "user" }),
      expect.objectContaining({ type: "conversation_item", item: expect.objectContaining({ type: "tool_call", callId: "call-repeated" }) }),
      expect.objectContaining({ type: "conversation_item", item: expect.objectContaining({ type: "tool_result", callId: "call-repeated" }) })
    ]);
  });
});
