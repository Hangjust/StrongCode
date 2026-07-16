import type { ProviderAuth, ProviderAuthReader } from "../../src/models/auth-store";
import { AnthropicModelProvider } from "../../src/models/anthropic-provider";
import { ChatGptModelProvider } from "../../src/models/chatgpt-provider";
import { GoogleGeminiModelProvider } from "../../src/models/google-provider";
import { GoogleVertexModelProvider } from "../../src/models/google-vertex-provider";
import type { NativeProviderFetcher } from "../../src/models/native-provider-utils";
import { OpenAICompatibleModelProvider } from "../../src/models/openai-compatible-provider";
import type { ModelRequest, ModelResponse } from "../../src/models/provider";
import { providerDefaults } from "../../src/models/registry";

const apiAuth: ProviderAuthReader = {
  async get(): Promise<ProviderAuth> {
    return { type: "api", key: "protocol-api-key" };
  },
  async all(): Promise<Record<string, ProviderAuth>> {
    return {};
  }
};

const oauthAuth: ProviderAuthReader = {
  async get(): Promise<ProviderAuth> {
    return { type: "oauth", access: "protocol-oauth", expires: Date.now() + 3_600_000 };
  },
  async all(): Promise<Record<string, ProviderAuth>> {
    return {};
  }
};

const request: ModelRequest = {
  prompt: "Summarize",
  sessionId: "protocol-integration",
  messages: [],
  tools: []
};

const result = JSON.stringify({
  kind: "complete",
  result: {
    title: "Protocol title",
    generalSummary: "Protocol summary",
    requestedItems: ["Protocol request"]
  }
});

function json(body: unknown, headers: Readonly<Record<string, string>> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers }
  });
}

function openAi(): Promise<ModelResponse> {
  const provider = new OpenAICompatibleModelProvider({
    providerId: "deepseek",
    providerConfig: { ...providerDefaults().deepseek, enabled: true },
    modelId: "deepseek-v4-flash",
    modelConfig: { provider: "deepseek", model: "deepseek-v4-flash", enabled: true },
    authStore: apiAuth,
    fetcher: async () => json({
      choices: [{ message: { content: result } }],
      usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50, cost: 0.01, currency: "USD" }
    }, { "x-request-id": "openai-request" })
  });
  return provider.complete(request);
}

function chatGpt(): Promise<ModelResponse> {
  const provider = new ChatGptModelProvider({
    providerId: "chatgpt",
    providerConfig: { ...providerDefaults().chatgpt, enabled: true },
    modelId: "gpt-5.5",
    modelConfig: { provider: "chatgpt", model: "gpt-5.5", enabled: true },
    authStore: oauthAuth,
    fetcher: async () => json({
      id: "chatgpt-response",
      output: [{ type: "message", content: [{ type: "output_text", text: result }] }],
      usage: { input_tokens: 40, output_tokens: 12, total_tokens: 52 }
    }),
    timeoutMs: 2_000
  });
  return provider.complete(request);
}

function anthropic(): Promise<ModelResponse> {
  const fetcher: NativeProviderFetcher = async () => json({
    id: "anthropic-response",
    content: [{ type: "text", text: result }],
    usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 5 }
  }, { "request-id": "anthropic-request" });
  return new AnthropicModelProvider({
    providerId: "anthropic",
    providerConfig: { ...providerDefaults().anthropic, enabled: true },
    modelId: "claude-test",
    modelConfig: { provider: "anthropic", model: "claude-test", enabled: true },
    authStore: apiAuth,
    fetcher
  }).complete(request);
}

function gemini(): Promise<ModelResponse> {
  const fetcher: NativeProviderFetcher = async () => json({
    responseId: "gemini-response",
    candidates: [{ content: { parts: [{ text: result }] } }],
    usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 6, totalTokenCount: 26 }
  }, { "x-request-id": "gemini-request" });
  return new GoogleGeminiModelProvider({
    providerId: "google",
    providerConfig: { ...providerDefaults().google, enabled: true },
    modelId: "gemini-test",
    modelConfig: { provider: "google", model: "gemini-test", enabled: true },
    authStore: apiAuth,
    fetcher
  }).complete(request);
}

function vertex(): Promise<ModelResponse> {
  const fetcher: NativeProviderFetcher = async () => json({
    responseId: "vertex-response",
    candidates: [{ content: { parts: [{ text: result }] } }],
    usageMetadata: { promptTokenCount: 13, candidatesTokenCount: 4, totalTokenCount: 17 }
  }, { "x-request-id": "vertex-request" });
  return new GoogleVertexModelProvider({
    providerId: "google-vertex",
    providerConfig: {
      ...providerDefaults()["google-vertex"],
      projectId: "example-project",
      location: "europe-west4",
      enabled: true
    },
    modelId: "vertex-test",
    modelConfig: { provider: "google-vertex", model: "vertex-test", enabled: true },
    fetcher
  }).complete(request);
}

function directAttempts(): ModelResponse {
  return {
    message: result,
    toolCalls: [],
    directAttempts: [
      {
        attemptId: "direct-flash",
        provider: "deepseek",
        model: "flash",
        scope: "exclusive",
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        providerCost: { amount: 0.01, currency: "USD" },
        providerRequestId: "direct-flash-request"
      },
      {
        attemptId: "direct-gemma",
        provider: "google",
        model: "gemma",
        scope: "exclusive",
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
        providerCost: { amount: 0.005, currency: "USD" },
        providerRequestId: "direct-gemma-request"
      }
    ]
  };
}

export type ProtocolCase = Readonly<{
  name: string;
  response: ModelResponse;
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  costUsd?: number;
}>;

export async function protocolCases(): Promise<readonly ProtocolCase[]> {
  const responses = await Promise.all([openAi(), chatGpt(), anthropic(), gemini(), vertex()]);
  const cases: ProtocolCase[] = [
    { name: "openai", response: responses[0] ?? directAttempts(), inputTokens: 30, outputTokens: 20, totalTokens: 50, costUsd: 0.01 },
    { name: "chatgpt", response: responses[1] ?? directAttempts(), inputTokens: 40, outputTokens: 12, totalTokens: 52 },
    { name: "anthropic", response: responses[2] ?? directAttempts(), inputTokens: 11, outputTokens: 7 },
    { name: "gemini", response: responses[3] ?? directAttempts(), inputTokens: 20, outputTokens: 6, totalTokens: 26 },
    { name: "vertex", response: responses[4] ?? directAttempts(), inputTokens: 13, outputTokens: 4, totalTokens: 17 },
    { name: "direct-attempts", response: directAttempts(), inputTokens: 15, outputTokens: 5, totalTokens: 20, costUsd: 0.015 }
  ];
  return cases;
}
