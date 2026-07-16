import type { ProviderAuth, ProviderAuthReader } from "../src/models/auth-store";
import { AnthropicModelProvider } from "../src/models/anthropic-provider";
import { GoogleGeminiModelProvider } from "../src/models/google-provider";
import { GoogleVertexModelProvider } from "../src/models/google-vertex-provider";
import type { NativeProviderFetcher } from "../src/models/native-provider-utils";
import type { ModelRequest } from "../src/models/provider";
import { providerDefaults } from "../src/models/registry";

vi.mock("../src/models/gcloud-delegated", () => ({
  getGoogleAdcAccessToken: vi.fn(async () => "vertex-access-token")
}));

const authStore: ProviderAuthReader = {
  async get(): Promise<ProviderAuth> {
    return { type: "api", key: "native-usage-key" };
  },
  async all(): Promise<Record<string, ProviderAuth>> {
    return {};
  }
};

const request: ModelRequest = {
  prompt: "Report native usage",
  sessionId: "native-usage",
  messages: [],
  tools: []
};

function response(body: unknown, headers: Readonly<Record<string, string>> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers }
  });
}

function anthropic(body: unknown, headers?: Readonly<Record<string, string>>): AnthropicModelProvider {
  const fetcher: NativeProviderFetcher = async () => response(body, headers);
  return new AnthropicModelProvider({
    providerId: "anthropic",
    providerConfig: { ...providerDefaults().anthropic, enabled: true },
    modelId: "claude-test",
    modelConfig: { provider: "anthropic", model: "claude-test", enabled: true },
    authStore,
    fetcher
  });
}

function gemini(body: unknown, headers?: Readonly<Record<string, string>>): GoogleGeminiModelProvider {
  const fetcher: NativeProviderFetcher = async () => response(body, headers);
  return new GoogleGeminiModelProvider({
    providerId: "google",
    providerConfig: { ...providerDefaults().google, enabled: true },
    modelId: "gemini-test",
    modelConfig: { provider: "google", model: "gemini-test", enabled: true },
    authStore,
    fetcher
  });
}

function vertex(body: unknown, headers?: Readonly<Record<string, string>>): GoogleVertexModelProvider {
  const fetcher: NativeProviderFetcher = async () => response(body, headers);
  return new GoogleVertexModelProvider({
    providerId: "google-vertex",
    providerConfig: {
      ...providerDefaults()["google-vertex"],
      projectId: "example-project",
      location: "europe-west4",
      enabled: true
    },
    modelId: "gemini-test",
    modelConfig: { provider: "google-vertex", model: "gemini-test", enabled: true },
    fetcher
  });
}

describe("native provider-reported usage", () => {
  it("preserves exact Anthropic categories and only a real HTTP request identifier", async () => {
    // Given
    const provider = anthropic({
      id: "msg-body-is-not-a-request-id",
      content: [{ type: "text", text: "Claude" }],
      usage: {
        input_tokens: 11,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 5,
        output_tokens: 7,
        thinking_tokens: 99
      }
    }, { "request-id": "req-anthropic-1" });

    // When
    const result = await provider.complete(request);

    // Then
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7, cacheReadTokens: 5, cacheWriteTokens: 3 });
    expect(result.providerUsage).toEqual([
      { source: "provider-reported", provider: "anthropic-messages", field: "usage.input_tokens", category: "input", tokens: 11, semantics: "exclusive" },
      { source: "provider-reported", provider: "anthropic-messages", field: "usage.cache_creation_input_tokens", category: "cache-write", tokens: 3, semantics: "exclusive" },
      { source: "provider-reported", provider: "anthropic-messages", field: "usage.cache_read_input_tokens", category: "cache-read", tokens: 5, semantics: "exclusive" },
      { source: "provider-reported", provider: "anthropic-messages", field: "usage.output_tokens", category: "output", tokens: 7, semantics: "output-includes-reasoning" }
    ]);
    expect(result.providerRequestId).toBe("req-anthropic-1");
    expect(result.providerResponseId).toBe("msg-body-is-not-a-request-id");
    expect(result.usage).not.toHaveProperty("reasoningTokens");
    expect(result.usage).not.toHaveProperty("totalTokens");
  });

  it("preserves valid Anthropic zeroes independently and omits malformed siblings", async () => {
    // Given
    const provider = anthropic({
      content: [{ type: "text", text: "partial" }],
      usage: {
        input_tokens: 0,
        output_tokens: -1,
        cache_creation_input_tokens: 1.5,
        cache_read_input_tokens: "4",
        unknown_input_tokens: 20
      }
    });

    // When
    const result = await provider.complete(request);

    // Then
    expect(result.usage).toEqual({ inputTokens: 0 });
    expect(result.providerUsage).toEqual([
      { source: "provider-reported", provider: "anthropic-messages", field: "usage.input_tokens", category: "input", tokens: 0, semantics: "exclusive" }
    ]);
    expect(result).not.toHaveProperty("providerRequestId");
  });

  it("preserves Gemini totals, overlaps, reasoning, tool-use semantics, and response identity", async () => {
    // Given
    const provider = gemini({
      responseId: "resp-gemini-1",
      candidates: [{ content: { parts: [{ text: "Gemini" }] } }],
      usageMetadata: {
        promptTokenCount: 20,
        candidatesTokenCount: 6,
        totalTokenCount: 97,
        cachedContentTokenCount: 4,
        thoughtsTokenCount: 5,
        toolUsePromptTokenCount: 2
      }
    }, { "x-request-id": "req-gemini-1" });

    // When
    const result = await provider.complete(request);

    // Then
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 6, reasoningTokens: 5, cacheReadTokens: 4, totalTokens: 97 });
    expect(result.providerUsage).toEqual([
      { source: "provider-reported", provider: "gemini-developer-api", field: "usageMetadata.promptTokenCount", category: "input", tokens: 20, semantics: "input-includes-cache" },
      { source: "provider-reported", provider: "gemini-developer-api", field: "usageMetadata.candidatesTokenCount", category: "output", tokens: 6, semantics: "exclusive" },
      { source: "provider-reported", provider: "gemini-developer-api", field: "usageMetadata.totalTokenCount", category: "total", tokens: 97, semantics: "reported-total" },
      { source: "provider-reported", provider: "gemini-developer-api", field: "usageMetadata.cachedContentTokenCount", category: "cache-read", tokens: 4, semantics: "input-overlap" },
      { source: "provider-reported", provider: "gemini-developer-api", field: "usageMetadata.thoughtsTokenCount", category: "reasoning", tokens: 5, semantics: "exclusive" },
      { source: "provider-reported", provider: "gemini-developer-api", field: "usageMetadata.toolUsePromptTokenCount", category: "provider-specific", tokens: 2, semantics: "gemini-tool-use-prompt" }
    ]);
    expect(result.providerRequestId).toBe("req-gemini-1");
    expect(result.providerResponseId).toBe("resp-gemini-1");
  });

  it("keeps Vertex tool-execution-result input distinct from Gemini tool-use prompt usage", async () => {
    // Given
    const provider = vertex({
      responseId: "resp-vertex-1",
      candidates: [{ content: { parts: [{ text: "Vertex" }] } }],
      usageMetadata: {
        promptTokenCount: 13,
        candidatesTokenCount: 0,
        totalTokenCount: 42,
        cachedContentTokenCount: 3,
        thoughtsTokenCount: 4,
        toolUsePromptTokenCount: 2
      }
    }, { "x-request-id": "req-vertex-1" });

    // When
    const result = await provider.complete(request);

    // Then
    expect(result.usage).toEqual({ inputTokens: 13, outputTokens: 0, reasoningTokens: 4, cacheReadTokens: 3, totalTokens: 42 });
    expect(result.providerUsage?.at(-1)).toEqual({
      source: "provider-reported",
      provider: "google-vertex-ai",
      field: "usageMetadata.toolUsePromptTokenCount",
      category: "provider-specific",
      tokens: 2,
      semantics: "vertex-tool-execution-result-input"
    });
    expect(result.providerRequestId).toBe("req-vertex-1");
    expect(result.providerResponseId).toBe("resp-vertex-1");
  });

  it.each([
    ["Anthropic", () => anthropic({ content: [{ type: "text", text: "none" }], usage: {} })],
    ["Gemini", () => gemini({ candidates: [{ content: { parts: [{ text: "none" }] } }], usageMetadata: {} })],
    ["Vertex", () => vertex({ candidates: [{ content: { parts: [{ text: "none" }] } }], usageMetadata: {} })]
  ])("leaves wholly missing %s usage and provenance absent", async (_name, createProvider) => {
    // Given
    const provider = createProvider();

    // When
    const result = await provider.complete(request);

    // Then
    expect(result).not.toHaveProperty("usage");
    expect(result).not.toHaveProperty("providerUsage");
  });

  it("preserves a partial Gemini literal zero without inferring sibling buckets", async () => {
    // Given
    const provider = gemini({
      candidates: [{ content: { parts: [{ text: "partial" }] } }],
      usageMetadata: {
        promptTokenCount: 0,
        candidatesTokenCount: null,
        totalTokenCount: "0",
        cachedContentTokenCount: -1,
        thoughtsTokenCount: 1.5,
        toolUsePromptTokenCount: Number.POSITIVE_INFINITY
      }
    });

    // When
    const result = await provider.complete(request);

    // Then
    expect(result.usage).toEqual({ inputTokens: 0 });
    expect(result.providerUsage).toEqual([
      { source: "provider-reported", provider: "gemini-developer-api", field: "usageMetadata.promptTokenCount", category: "input", tokens: 0, semantics: "input-includes-cache" }
    ]);
  });

  it.each([
    ["Gemini", () => gemini({
      responseId: 7,
      candidates: [{ content: { parts: [{ text: "partial" }] } }],
      usageMetadata: {
        promptTokenCount: Number.POSITIVE_INFINITY,
        candidatesTokenCount: Number.MAX_SAFE_INTEGER + 1,
        totalTokenCount: -1,
        cachedContentTokenCount: 1.25,
        thoughtsTokenCount: "5",
        toolUsePromptTokenCount: Number.NaN,
        futureTokenCount: 8
      }
    })],
    ["Vertex", () => vertex({
      responseId: "bad\r\nid",
      candidates: [{ content: { parts: [{ text: "partial" }] } }],
      usageMetadata: {
        promptTokenCount: Number.NEGATIVE_INFINITY,
        candidatesTokenCount: 2.5,
        totalTokenCount: "3",
        cachedContentTokenCount: -4,
        thoughtsTokenCount: Number.MAX_SAFE_INTEGER + 1,
        toolUsePromptTokenCount: null,
        futureTokenCount: 8
      }
    })]
  ])("does not coerce or infer malformed %s usage or identifiers", async (_name, createProvider) => {
    // Given
    const provider = createProvider();

    // When
    const result = await provider.complete(request);

    // Then
    expect(result).not.toHaveProperty("usage");
    expect(result).not.toHaveProperty("providerUsage");
    expect(result).not.toHaveProperty("providerResponseId");
  });
});
