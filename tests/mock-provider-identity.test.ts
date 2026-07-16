import { MockModelProvider } from "../src/models/mock-provider";

const request = { prompt: "identity", sessionId: "mock-identity", messages: [], tools: [] };

const unsafeFragments = [
  ["newline", "\n"],
  ["ANSI escape", "\u001b[31m"],
  ["OSC", "\u001b]0;spoof\u0007"],
  ["C1 CSI", "\u009b31m"],
  ["bidi override", "\u202e"],
  ["bidi isolate", "\u2066"],
  ["zero-width format", "\u200b"],
  ["unpaired surrogate", "\ud800"],
  ["line separator", "\u2028"],
  ["paragraph separator", "\u2029"]
] as const;

const invalidIdentities = [
  ...unsafeFragments.map(([name, fragment]) => [name, `safe${fragment}name`] as const),
  ["empty", ""],
  ["whitespace-only", "   "],
  ["leading whitespace", " leading"],
  ["trailing whitespace", "trailing "]
] as const;

function metric(provider: string, field: string, tokens = 1) {
  return { source: "provider-reported", provider, field, category: "input", tokens, semantics: "exclusive" };
}

function attempt(attemptId: string, provider: string, model: string, providerUsage?: readonly unknown[]) {
  return {
    attemptId,
    provider,
    model,
    scope: "exclusive",
    usage: { inputTokens: 0 },
    providerCost: { amount: 0, currency: "USD" },
    ...(providerUsage ? { providerUsage } : {})
  };
}

describe("mock telemetry identity boundary", () => {
  it.each(["provider", "field"] as const)("drops only a metric whose %s identity is unsafe", async identityField => {
    for (const [caseName, invalidIdentity] of invalidIdentities) {
      // Given
      const invalidMetric = metric(
        identityField === "provider" ? invalidIdentity : "provider",
        identityField === "field" ? invalidIdentity : "usage.invalid"
      );
      const provider = MockModelProvider.fromFixture([{
        message: caseName,
        toolCalls: [],
        providerUsage: [metric("provider", "usage.first", 0), invalidMetric, metric("provider", "usage.last", 2)]
      }]);

      // When
      const result = await provider.complete(request);

      // Then
      expect(result.providerUsage, `${identityField}: ${caseName}`).toEqual([
        metric("provider", "usage.first", 0),
        metric("provider", "usage.last", 2)
      ]);
    }
  });

  it.each(["attemptId", "provider", "model"] as const)("drops only an attempt whose %s identity is unsafe", async identityField => {
    for (const [caseName, invalidIdentity] of invalidIdentities) {
      // Given
      const invalidAttempt = attempt(
        identityField === "attemptId" ? invalidIdentity : "attempt-invalid",
        identityField === "provider" ? invalidIdentity : "provider",
        identityField === "model" ? invalidIdentity : "model"
      );
      const provider = MockModelProvider.fromFixture([{
        message: caseName,
        toolCalls: [],
        directAttempts: [attempt("attempt-first", "provider", "model"), invalidAttempt, attempt("attempt-last", "provider", "model")]
      }]);

      // When
      const result = await provider.complete(request);

      // Then
      expect(result.directAttempts?.map(entry => entry.attemptId), `${identityField}: ${caseName}`).toEqual(["attempt-first", "attempt-last"]);
    }
  });

  it("preserves visible Unicode identities exactly without normalization", async () => {
    // Given
    const visibleProvider = "Azure OpenAI / 東京 (β)";
    const visibleField = "usage.Cafe\u0301[count:0]";
    const visibleAttemptId = "attempt-🚀 / α";
    const visibleModel = "模型-🚀.v1";
    const provider = MockModelProvider.fromFixture([{
      message: "visible",
      toolCalls: [],
      providerUsage: [metric(visibleProvider, visibleField, 0)],
      directAttempts: [attempt(visibleAttemptId, visibleProvider, visibleModel)]
    }]);

    // When
    const result = await provider.complete(request);

    // Then
    expect(result.providerUsage?.[0]).toEqual(metric(visibleProvider, visibleField, 0));
    expect(result.directAttempts?.[0]).toMatchObject({ attemptId: visibleAttemptId, provider: visibleProvider, model: visibleModel });
  });

  it("omits unsafe children and optional IDs independently while preserving zero telemetry", async () => {
    // Given
    const unsafeMetric = metric("provider\u001b", "usage.invalid");
    const validNestedMetrics = [metric("provider", "nested.first", 0), metric("provider", "nested.last", 2)];
    const provider = MockModelProvider.fromFixture([{
      message: "granular",
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      providerCost: { amount: 0, currency: "USD" },
      providerRequestId: "request\nunsafe",
      providerResponseId: "response-safe",
      providerUsage: [unsafeMetric],
      directAttempts: [{
        ...attempt("attempt-safe", "provider", "model", [validNestedMetrics[0], unsafeMetric, validNestedMetrics[1]]),
        providerRequestId: "request-safe",
        providerResponseId: "response\u009bunsafe"
      }]
    }]);

    // When
    const result = await provider.complete(request);

    // Then
    expect(result).not.toHaveProperty("providerUsage");
    expect(result).not.toHaveProperty("providerRequestId");
    expect(result.providerResponseId).toBe("response-safe");
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(result.providerCost).toEqual({ amount: 0, currency: "USD" });
    expect(result.directAttempts?.[0]).toMatchObject({
      attemptId: "attempt-safe",
      usage: { inputTokens: 0 },
      providerCost: { amount: 0, currency: "USD" },
      providerRequestId: "request-safe",
      providerUsage: validNestedMetrics
    });
    expect(result.directAttempts?.[0]).not.toHaveProperty("providerResponseId");
  });
});
