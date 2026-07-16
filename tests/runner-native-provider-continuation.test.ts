import { StrongCodeError } from "../src/core/errors";
import {
  anthropicRunnerProvider,
  createRunnerHarness,
  geminiRunnerProvider,
  providerResponse
} from "./runner-provider-fixtures";

describe("AgentRunner native provider continuation", () => {
  it("preserves the Anthropic call ID through tool execution and the second request", async () => {
    // Given
    const bodies: string[] = [];
    const responses = [
      providerResponse({
        content: [{
          type: "tool_use",
          id: "call-runner-anthropic-1",
          name: "read_file",
          input: { path: "README.md" }
        }]
      }),
      providerResponse({ content: [{ type: "text", text: "Runner continuation complete" }] })
    ];
    const model = anthropicRunnerProvider(async (_url, init) => {
      bodies.push(init.body);
      const response = responses.shift();
      if (!response) throw new StrongCodeError("MODEL_ERROR", "Unexpected extra Anthropic request");
      return response;
    });
    const harness = await createRunnerHarness(model);

    // When
    const result = await harness.runner.run(harness.agent, "Inspect the workspace", "runner-anthropic");

    // Then
    if (!result.ok) throw result.error;
    expect(result.value.response).toBe("Runner continuation complete");
    expect(JSON.parse(bodies[1] ?? "")).toMatchObject({
      messages: [
        { role: "user", content: "Inspect the workspace" },
        {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: "call-runner-anthropic-1",
            name: "read_file",
            input: { path: "README.md" }
          }]
        },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "call-runner-anthropic-1",
            content: "fixture contents",
            is_error: false
          }]
        }
      ]
    });
  });

  it("preserves the Gemini call ID through tool execution and the second request", async () => {
    // Given
    const bodies: string[] = [];
    const responses = [
      providerResponse({
        candidates: [{ content: { parts: [{
          functionCall: {
            id: "call-runner-gemini-1",
            name: "read_file",
            args: { path: "README.md" }
          }
        }] } }]
      }),
      providerResponse({ candidates: [{ content: { parts: [{ text: "Runner continuation complete" }] } }] })
    ];
    const model = geminiRunnerProvider(async (_url, init) => {
      bodies.push(init.body);
      const response = responses.shift();
      if (!response) throw new StrongCodeError("MODEL_ERROR", "Unexpected extra Gemini request");
      return response;
    });
    const harness = await createRunnerHarness(model);

    // When
    const result = await harness.runner.run(harness.agent, "Inspect the workspace", "runner-gemini");

    // Then
    if (!result.ok) throw result.error;
    expect(result.value.response).toBe("Runner continuation complete");
    expect(JSON.parse(bodies[1] ?? "")).toMatchObject({
      contents: [
        { role: "user", parts: [{ text: "Inspect the workspace" }] },
        {
          role: "model",
          parts: [{ functionCall: {
            id: "call-runner-gemini-1",
            name: "read_file",
            args: { path: "README.md" }
          } }]
        },
        {
          role: "user",
          parts: [{ functionResponse: {
            id: "call-runner-gemini-1",
            name: "read_file",
            response: { output: "fixture contents", isError: false }
          } }]
        }
      ]
    });
  });
});
