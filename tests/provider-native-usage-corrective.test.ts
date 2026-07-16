import type { ProviderAuth, ProviderAuthReader } from "../src/models/auth-store";
import { AnthropicModelProvider } from "../src/models/anthropic-provider";
import { GoogleGeminiModelProvider } from "../src/models/google-provider";
import { GoogleVertexModelProvider } from "../src/models/google-vertex-provider";
import type { NativeProviderFetcher } from "../src/models/native-provider-utils";
import type { ModelRequest } from "../src/models/provider";
import { providerDefaults } from "../src/models/registry";

vi.mock("../src/models/gcloud-delegated", () => ({
  getGoogleAdcAccessToken: vi.fn(async () => "vertex-corrective-token")
}));

const authStore: ProviderAuthReader = {
  async get(): Promise<ProviderAuth> {
    return { type: "api", key: "corrective-native-key" };
  },
  async all(): Promise<Record<string, ProviderAuth>> {
    return {};
  }
};

const request: ModelRequest = {
  prompt: "Report corrective native usage",
  sessionId: "native-corrective",
  messages: [],
  tools: []
};

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function anthropic(body: unknown): AnthropicModelProvider {
  const fetcher: NativeProviderFetcher = async () => response(body);
  return new AnthropicModelProvider({
    providerId: "anthropic",
    providerConfig: { ...providerDefaults().anthropic, enabled: true },
    modelId: "claude-test",
    modelConfig: { provider: "anthropic", model: "claude-test", enabled: true },
    authStore,
    fetcher
  });
}

function google(kind: "gemini" | "vertex", body: unknown): GoogleGeminiModelProvider | GoogleVertexModelProvider {
  const fetcher: NativeProviderFetcher = async () => response(body);
  if (kind === "gemini") {
    return new GoogleGeminiModelProvider({
      providerId: "google",
      providerConfig: { ...providerDefaults().google, enabled: true },
      modelId: "gemini-test",
      modelConfig: { provider: "google", model: "gemini-test", enabled: true },
      authStore,
      fetcher
    });
  }
  return new GoogleVertexModelProvider({
    providerId: "google-vertex",
    providerConfig: {
      ...providerDefaults()["google-vertex"],
      projectId: "corrective-project",
      location: "europe-west4",
      enabled: true
    },
    modelId: "gemini-test",
    modelConfig: { provider: "google-vertex", model: "gemini-test", enabled: true },
    fetcher
  });
}

describe("corrective native usage boundaries", () => {
  it("preserves nested Anthropic thinking as an output subset without adding it", async () => {
    // Given
    const provider = anthropic({
      content: [{ type: "text", text: "thinking" }],
      usage: {
        input_tokens: 3,
        output_tokens: 9,
        thinking_tokens: 88,
        output_tokens_details: { thinking_tokens: 4 }
      }
    });

    // When
    const result = await provider.complete(request);

    // Then
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 9, reasoningTokens: 4 });
    expect(result.usage).not.toHaveProperty("totalTokens");
    expect(result.providerUsage?.at(-1)).toEqual({
      source: "provider-reported",
      provider: "anthropic-messages",
      field: "usage.output_tokens_details.thinking_tokens",
      category: "reasoning",
      tokens: 4,
      semantics: "output-subset"
    });
  });

  it.each([
    [0, { inputTokens: 1, outputTokens: 5, reasoningTokens: 0 }],
    [6, { inputTokens: 1, outputTokens: 5 }],
    [-1, { inputTokens: 1, outputTokens: 5 }],
    [1.5, { inputTokens: 1, outputTokens: 5 }],
    ["2", { inputTokens: 1, outputTokens: 5 }]
  ])("handles Anthropic thinking boundary %j independently", async (thinkingTokens, expected) => {
    // Given
    const provider = anthropic({
      content: [{ type: "text", text: "boundary" }],
      usage: { input_tokens: 1, output_tokens: 5, output_tokens_details: { thinking_tokens: thinkingTokens } }
    });

    // When
    const result = await provider.complete(request);

    // Then
    expect(result.usage).toEqual(expected);
  });

  it.each(["gemini", "vertex"] as const)("enforces documented int32 usage for %s", async kind => {
    // Given
    const provider = google(kind, {
      candidates: [{ content: { parts: [{ text: "int32" }] } }],
      usageMetadata: {
        promptTokenCount: 2_147_483_647,
        candidatesTokenCount: 2_147_483_648,
        totalTokenCount: 0,
        cachedContentTokenCount: -1,
        thoughtsTokenCount: 1.5,
        toolUsePromptTokenCount: "2"
      }
    });

    // When
    const result = await provider.complete(request);

    // Then
    expect(result.usage).toEqual({ inputTokens: 2_147_483_647, totalTokens: 0 });
    expect(result.providerUsage).toHaveLength(2);
    expect(result.usage).not.toHaveProperty("outputTokens");
  });
});
