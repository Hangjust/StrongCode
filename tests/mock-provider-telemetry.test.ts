import { MockModelProvider } from "../src/models/mock-provider";

const request = { prompt: "fixture", sessionId: "mock-corrective", messages: [], tools: [] };

describe("scripted mock telemetry boundary", () => {
  it("does not share typed fixture telemetry references across completions", async () => {
    // Given
    const response = {
      message: "typed",
      toolCalls: [],
      usage: { inputTokens: 0 },
      providerUsage: [{
        source: "provider-reported" as const,
        provider: "fixture",
        field: "usage.input",
        category: "input" as const,
        tokens: 0,
        semantics: "exclusive" as const
      }]
    };
    const provider = new MockModelProvider([response, response]);

    // When
    const first = await provider.complete(request);
    Object.defineProperty(first.usage, "inputTokens", { value: 99 });
    Object.defineProperty(first.providerUsage?.[0], "tokens", { value: 99 });
    const second = await provider.complete(request);

    // Then
    expect(second.usage).toEqual({ inputTokens: 0 });
    expect(second.providerUsage?.[0]?.tokens).toBe(0);
    expect(response.usage).toEqual({ inputTokens: 0 });
  });

  it("parses valid telemetry by value and isolates every completion", async () => {
    // Given
    const fixture: unknown = JSON.parse(JSON.stringify([
      {
        message: "first",
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 3, totalTokens: "3" },
        providerUsage: [
          { source: "provider-reported", provider: "fixture", field: "usage.input", category: "input", tokens: 0, semantics: "exclusive" },
          { source: "provider-reported", provider: "fixture", field: "usage.bad", category: "unknown", tokens: 4, semantics: "exclusive" }
        ],
        directAttempts: [
          { attemptId: "attempt-1", provider: "fixture-provider", model: "fixture-model", scope: "exclusive", usage: { outputTokens: 2 } },
          { attemptId: "", provider: "fixture-provider", model: "fixture-model", scope: "exclusive" }
        ]
      },
      {
        message: "second",
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 3, totalTokens: "3" },
        providerUsage: [
          { source: "provider-reported", provider: "fixture", field: "usage.input", category: "input", tokens: 0, semantics: "exclusive" }
        ],
        directAttempts: [
          { attemptId: "attempt-1", provider: "fixture-provider", model: "fixture-model", scope: "exclusive", usage: { outputTokens: 2 } }
        ]
      }
    ]));
    const provider = MockModelProvider.fromFixture(fixture);

    // When
    const first = await provider.complete(request);
    Object.defineProperty(first.usage, "inputTokens", { value: 99 });
    Object.defineProperty(first.providerUsage?.[0], "tokens", { value: 99 });
    Object.defineProperty(first.directAttempts?.[0]?.usage, "outputTokens", { value: 99 });
    const second = await provider.complete(request);

    // Then
    expect(second.usage).toEqual({ inputTokens: 0, outputTokens: 3 });
    expect(second.providerUsage).toEqual([
      { source: "provider-reported", provider: "fixture", field: "usage.input", category: "input", tokens: 0, semantics: "exclusive" }
    ]);
    expect(second.directAttempts).toEqual([
      { attemptId: "attempt-1", provider: "fixture-provider", model: "fixture-model", scope: "exclusive", usage: { outputTokens: 2 } }
    ]);
  });

  it("omits malformed empty usage rather than fabricating an object", async () => {
    // Given
    const fixture: unknown = JSON.parse(JSON.stringify([{ message: "empty", toolCalls: [], usage: {}, providerUsage: [{}], directAttempts: [{}] }]));
    const provider = MockModelProvider.fromFixture(fixture);

    // When
    const result = await provider.complete(request);

    // Then
    expect(result).toEqual({ message: "empty", toolCalls: [] });
  });
});
