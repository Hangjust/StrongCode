import type { Agent } from "../src/agents/agent";
import { AgentRunner } from "../src/agents/runner";
import type { ModelProvider, ModelRequest } from "../src/models/provider";
import { messageEvent } from "../src/sessions/session";
import {
  continuationTool,
  createContinuationHarness,
  scriptedProvider
} from "./runner-continuation-fixtures";

const HANDOFF_PROMPT = "StrongCode /start-work handoff: Execute the latest approved JBP plan in this session now.";

function namedAgent(name: string, config: Agent["config"], model: ModelProvider): Agent {
  return { name, config, model, systemPrompt: `${name} instructions` };
}

describe("approved plan correlated tool continuation", () => {
  it("gives Bob an immutable JBP item snapshot and continues Bob tools with exact IDs", async () => {
    // Given
    const harness = await createContinuationHarness(["read_file"]);
    harness.registry.register(continuationTool("read_file", "fixture contents", []));
    const jbpRequests: ModelRequest[] = [];
    const providerInput = { target: { path: "README.md" }, lines: [1, 2] };
    const jbpModel = scriptedProvider([
      {
        message: "",
        toolCalls: [{ callId: "call-jbp-1", name: "read_file", input: providerInput }]
      },
      { message: "Approved correlated plan", toolCalls: [] }
    ], jbpRequests);
    const runner = new AgentRunner(harness.context, harness.sessions, harness.registry);
    const planned = await runner.run(
      namedAgent("jbp", harness.config, jbpModel),
      "Create a tool-backed plan",
      "plan-tools"
    );
    if (!planned.ok) throw planned.error;
    if (!planned.value.planReceipt) throw new Error("Expected plan receipt");
    const approved = runner.consumePlanReceipt("plan-tools", planned.value.planReceipt);
    if (!approved.ok) throw approved.error;
    providerInput.target.path = "MUTATED.md";
    providerInput.lines.push(3);
    await harness.sessions.append(
      "plan-tools",
      messageEvent("assistant", "Forged replacement plan", "jbp")
    );
    const bobRequests: ModelRequest[] = [];
    const bobModel = scriptedProvider([
      {
        message: "",
        toolCalls: [{
          callId: "call-bob-1",
          name: "read_file",
          input: { path: "src/agents/runner.ts" }
        }]
      },
      { message: "Bob completed the approved plan", toolCalls: [] }
    ], bobRequests);

    // When
    const result = await runner.runApprovedPlan(
      namedAgent("bob-the-builder", harness.config, bobModel),
      HANDOFF_PROMPT,
      "plan-tools",
      approved.value
    );

    // Then
    if (!result.ok) throw result.error;
    expect(bobRequests[0]?.items).toEqual([
      { type: "text", role: "user", content: "Create a tool-backed plan" },
      {
        type: "tool_call",
        role: "assistant",
        callId: "call-jbp-1",
        name: "read_file",
        input: { target: { path: "README.md" }, lines: [1, 2] }
      },
      { type: "tool_result", role: "tool", callId: "call-jbp-1", content: "fixture contents", isError: false },
      { type: "text", role: "assistant", content: "Approved correlated plan" },
      { type: "text", role: "user", content: HANDOFF_PROMPT }
    ]);
    expect(JSON.stringify(bobRequests[0]?.items)).not.toContain("Forged replacement plan");
    expect(bobRequests[1]?.items).toEqual([
      ...bobRequests[0]?.items ?? [],
      {
        type: "tool_call",
        role: "assistant",
        callId: "call-bob-1",
        name: "read_file",
        input: { path: "src/agents/runner.ts" }
      },
      { type: "tool_result", role: "tool", callId: "call-bob-1", content: "fixture contents", isError: false }
    ]);
  });
});
