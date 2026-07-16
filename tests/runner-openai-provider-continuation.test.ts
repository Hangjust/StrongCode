import { StrongCodeError } from "../src/core/errors";
import {
  chatGptProvider,
  chatGptResponse,
  openAIProvider,
  openAIResponse
} from "./provider-tool-fixtures";
import { createRunnerHarness } from "./runner-provider-fixtures";

describe("AgentRunner OpenAI provider continuation", () => {
  it("preserves the OpenAI-compatible call ID through the second request", async () => {
    // Given
    const bodies: string[] = [];
    const responses = [
      openAIResponse({ choices: [{ message: {
        content: null,
        tool_calls: [{
          id: "call-runner-openai-1",
          type: "function",
          function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" }
        }]
      } }] }),
      openAIResponse({ choices: [{ message: { content: "Runner continuation complete" } }] })
    ];
    const model = openAIProvider(async (_url, init) => {
      bodies.push(init.body);
      const response = responses.shift();
      if (!response) throw new StrongCodeError("MODEL_ERROR", "Unexpected extra OpenAI request");
      return response;
    });
    const harness = await createRunnerHarness(model);

    // When
    const result = await harness.runner.run(harness.agent, "Inspect the workspace", "runner-openai");

    // Then
    if (!result.ok) throw result.error;
    expect(JSON.parse(bodies[1] ?? "")).toMatchObject({
      messages: [
        { role: "system", content: "Trusted test instructions." },
        { role: "user", content: "Inspect the workspace" },
        { role: "assistant", tool_calls: [{ id: "call-runner-openai-1" }] },
        { role: "tool", tool_call_id: "call-runner-openai-1", content: "fixture contents" }
      ]
    });
  });

  it("preserves the ChatGPT call ID through the second request", async () => {
    // Given
    const bodies: string[] = [];
    const responses = [
      chatGptResponse({ output: [{
        type: "function_call",
        call_id: "call-runner-chatgpt-1",
        name: "read_file",
        arguments: "{\"path\":\"README.md\"}"
      }] }),
      chatGptResponse({ output: [{
        type: "message",
        content: [{ type: "output_text", text: "Runner continuation complete" }]
      }] })
    ];
    const model = chatGptProvider(async (_input, init) => {
      bodies.push(String(init?.body));
      const response = responses.shift();
      if (!response) throw new StrongCodeError("MODEL_ERROR", "Unexpected extra ChatGPT request");
      return response;
    });
    const harness = await createRunnerHarness(model);

    // When
    const result = await harness.runner.run(harness.agent, "Inspect the workspace", "runner-chatgpt");

    // Then
    if (!result.ok) throw result.error;
    expect(JSON.parse(bodies[1] ?? "")).toMatchObject({
      input: [
        { role: "user", content: [{ type: "input_text", text: "Inspect the workspace" }] },
        { type: "function_call", call_id: "call-runner-chatgpt-1", name: "read_file" },
        { type: "function_call_output", call_id: "call-runner-chatgpt-1", output: "fixture contents" }
      ]
    });
  });
});
