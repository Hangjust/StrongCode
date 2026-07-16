import { StrongCodeError } from "../src/core/errors";
import type { ConversationItem } from "../src/core/types";
import { MockModelProvider } from "../src/models/mock-provider";

describe("scripted mock provider", () => {
  it("emits a deterministic tool call followed by final text", async () => {
    // Given
    const exchange: readonly ConversationItem[] = [
      { type: "text", role: "user", content: "Inspect" },
      { type: "tool_call", role: "assistant", callId: "mock-call-1", name: "read_file", input: { path: "README.md" } },
      { type: "tool_result", role: "tool", callId: "mock-call-1", content: "StrongCode", isError: false }
    ];
    const provider = new MockModelProvider([
      {
        message: "Inspecting.",
        toolCalls: [{ callId: "mock-call-1", name: "read_file", input: { path: "README.md" } }]
      },
      { message: "Final: StrongCode", toolCalls: [] }
    ]);

    // When
    const first = await provider.complete({ prompt: "Inspect", sessionId: "mock-script", messages: [], tools: ["read_file"] });
    const second = await provider.complete({ prompt: "", sessionId: "mock-script", messages: [], items: exchange, tools: ["read_file"] });

    // Then
    expect(first).toMatchObject({ toolCalls: [{ callId: "mock-call-1", name: "read_file" }] });
    expect(second).toEqual({ message: "Final: StrongCode", toolCalls: [] });
  });

  it("fails with a typed error when a deterministic script is exhausted", async () => {
    // Given
    const provider = new MockModelProvider([{ message: "only", toolCalls: [] }]);
    const request = { prompt: "hello", sessionId: "mock-script", messages: [], tools: [] };
    await provider.complete(request);

    // When
    const completion = provider.complete(request);

    // Then
    await expect(completion).rejects.toEqual(new StrongCodeError("MODEL_ERROR", "Mock provider script exhausted after 1 completion"));
  });

  it("preserves the legacy prompt-driven behavior when no script is configured", async () => {
    // Given
    const provider = new MockModelProvider();

    // When
    const result = await provider.complete({ prompt: "hello", sessionId: "legacy-mock", messages: [], tools: [] });

    // Then
    expect(result).toEqual({ message: "Mock response: hello", toolCalls: [] });
    expect(result).not.toHaveProperty("usage");
  });

  it("preserves explicitly supplied typed fixture usage without fabricating siblings", async () => {
    // Given
    const usage = { inputTokens: 0, cacheReadTokens: 4 };
    const providerUsage = [{
      source: "provider-reported" as const,
      provider: "fixture",
      field: "usage.input",
      category: "input" as const,
      tokens: 0,
      semantics: "exclusive" as const
    }];
    const provider = new MockModelProvider([{
      message: "fixture",
      toolCalls: [],
      usage,
      providerUsage
    }]);

    // When
    const result = await provider.complete({ prompt: "hello", sessionId: "mock-usage", messages: [], tools: [] });

    // Then
    expect(result.usage).not.toBe(usage);
    expect(result.providerUsage).not.toBe(providerUsage);
    expect(result.usage).toEqual({ inputTokens: 0, cacheReadTokens: 4 });
  });
});
