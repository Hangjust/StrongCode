import { AgentRunner } from "../src/agents/runner";
import { StrongCodeError } from "../src/core/errors";
import { messageEvent, toolEvent } from "../src/sessions/session";
import {
  anthropicRunnerProvider,
  createRunnerHarness,
  providerResponse
} from "./runner-provider-fixtures";

describe("AgentRunner persisted tool continuation", () => {
  it("restores exact correlated IDs in a fresh runner", async () => {
    // Given
    const bodies: string[] = [];
    const responses = [
      providerResponse({ content: [{
        type: "tool_use",
        id: "call-resume-1",
        name: "read_file",
        input: { path: "README.md" }
      }] }),
      providerResponse({ content: [{ type: "text", text: "First turn complete" }] }),
      providerResponse({ content: [{ type: "text", text: "Fresh runner complete" }] })
    ];
    const fetcher = async (_url: string, init: { readonly body: string }): Promise<Response> => {
      bodies.push(init.body);
      const response = responses.shift();
      if (!response) throw new StrongCodeError("MODEL_ERROR", "Unexpected extra resume request");
      return response;
    };
    const firstHarness = await createRunnerHarness(anthropicRunnerProvider(fetcher));

    // When
    const first = await firstHarness.runner.run(firstHarness.agent, "Inspect", "resume-tools");
    if (!first.ok) throw first.error;
    const resumedModel = anthropicRunnerProvider(fetcher);
    const freshRunner = new AgentRunner(firstHarness.context, firstHarness.sessions, firstHarness.tools);
    const resumed = await freshRunner.run({ ...firstHarness.agent, model: resumedModel }, "Continue", "resume-tools");

    // Then
    if (!resumed.ok) throw resumed.error;
    expect(JSON.parse(bodies[2] ?? "")).toMatchObject({
      messages: [
        { role: "user", content: "Inspect" },
        { role: "assistant", content: [{ type: "tool_use", id: "call-resume-1" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call-resume-1" }] },
        { role: "assistant", content: "First turn complete" },
        { role: "user", content: "Continue" }
      ]
    });
    const stored = await firstHarness.sessions.read("resume-tools");
    if (!stored.ok) throw stored.error;
    expect(stored.value.events.filter(event => event.type === "message" || event.type === "conversation_item").map(event => event.type)).toEqual([
      "message",
      "conversation_item",
      "conversation_item",
      "message",
      "message",
      "message"
    ]);
    expect(stored.value.events.filter(event => event.type === "attempt_created" && event.role === "primary")).toHaveLength(3);
  });

  it("omits anonymous legacy tool output from provider-bound replay", async () => {
    // Given
    const bodies: string[] = [];
    const model = anthropicRunnerProvider(async (_url, init) => {
      bodies.push(init.body);
      return providerResponse({ content: [{ type: "text", text: "Legacy-safe continuation" }] });
    });
    const harness = await createRunnerHarness(model);
    await harness.sessions.append("legacy-tool", messageEvent("assistant", "Prior answer"));
    await harness.sessions.append("legacy-tool", toolEvent({
      tool: "read_file",
      input: { path: "README.md" },
      output: "anonymous legacy output"
    }));

    // When
    const result = await harness.runner.run(harness.agent, "Continue safely", "legacy-tool");

    // Then
    if (!result.ok) throw result.error;
    expect(bodies[0]).not.toContain("anonymous legacy output");
    expect(JSON.parse(bodies[0] ?? "")).toMatchObject({
      messages: [
        { role: "assistant", content: "Prior answer" },
        { role: "user", content: "Continue safely" }
      ]
    });
  });
});
