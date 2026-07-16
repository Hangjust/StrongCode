import { describe, expect, it } from "vitest";
import type { OAuthProviderAuth, ProviderAuth, ProviderAuthReader } from "../src/models/auth-store";
import type { ChatGptOAuthFetch } from "../src/models/chatgpt-oauth";
import { ChatGptModelProvider } from "../src/models/chatgpt-provider";
import { OpenAICompatibleModelProvider } from "../src/models/openai-compatible-provider";
import { providerDefaults } from "../src/models/registry";

const request = {
  prompt: "Report exact provider usage",
  sessionId: "usage-test",
  messages: [],
  tools: []
};

const apiAuthStore: ProviderAuthReader = {
  async get(): Promise<ProviderAuth> {
    return { type: "api", key: "provider-usage-test-key" };
  },
  async all(): Promise<Record<string, ProviderAuth>> {
    return {};
  }
};

class OAuthAuthStore implements ProviderAuthReader {
  constructor(readonly auth: OAuthProviderAuth) {}

  async get(): Promise<ProviderAuth> {
    return this.auth;
  }

  async all(): Promise<Record<string, ProviderAuth>> {
    return { chatgpt: this.auth };
  }
}

function openAIResponse(body: unknown, headers?: Readonly<Record<string, string>>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers }
  });
}

function openAIProvider(body: unknown, headers?: Readonly<Record<string, string>>): OpenAICompatibleModelProvider {
  return new OpenAICompatibleModelProvider({
    providerId: "deepseek",
    providerConfig: { ...providerDefaults().deepseek, enabled: true },
    modelId: "deepseek-chat",
    modelConfig: { provider: "deepseek", model: "deepseek-chat", enabled: true },
    authStore: apiAuthStore,
    fetcher: async () => openAIResponse(body, headers)
  });
}

function eventStream(events: readonly Readonly<Record<string, unknown>>[]): Response {
  const text = events
    .map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function chatGptProvider(fetcher: ChatGptOAuthFetch): ChatGptModelProvider {
  return new ChatGptModelProvider({
    providerId: "chatgpt",
    providerConfig: { ...providerDefaults().chatgpt, enabled: true },
    modelId: "gpt-5.5",
    modelConfig: { provider: "chatgpt", model: "gpt-5.5", enabled: true },
    authStore: new OAuthAuthStore({
      type: "oauth",
      access: "usage-oauth-access",
      expires: Date.now() + 3_600_000
    }),
    fetcher,
    timeoutMs: 2_000
  });
}

describe("provider-reported model usage", () => {
  it("normalizes complete OpenAI-compatible usage, cost, currency, and request ID", async () => {
    const result = await openAIProvider({
      id: "chatcmpl-provider-body-id",
      choices: [{ message: { content: "complete usage" } }],
      usage: {
        prompt_tokens: 30,
        completion_tokens: 20,
        total_tokens: 50,
        prompt_tokens_details: { cached_tokens: 8 },
        completion_tokens_details: { reasoning_tokens: 5 },
        cost: 0.00125,
        currency: "USD"
      }
    }, { "x-request-id": "req-deepseek-123" }).complete(request);

    expect(result).toEqual({
      message: "complete usage",
      toolCalls: [],
      usage: {
        inputTokens: 30,
        outputTokens: 20,
        reasoningTokens: 5,
        cacheReadTokens: 8,
        totalTokens: 50
      },
      providerCost: { amount: 0.00125, currency: "USD" },
      providerRequestId: "req-deepseek-123",
      providerResponseId: "chatcmpl-provider-body-id"
    });
  });

  it("retains only valid OpenAI-compatible usage categories that were reported", async () => {
    const result = await openAIProvider({
      choices: [{ message: { content: "partial usage" } }],
      usage: {
        prompt_tokens: 7,
        completion_tokens: null,
        total_tokens: "unknown",
        prompt_cache_hit_tokens: 3
      }
    }).complete(request);

    expect(result.usage).toEqual({ inputTokens: 7, cacheReadTokens: 3 });
    expect(result.usage).not.toHaveProperty("outputTokens");
    expect(result.usage).not.toHaveProperty("totalTokens");
  });

  it("omits absent and wholly malformed OpenAI-compatible metadata", async () => {
    const absent = await openAIProvider({
      choices: [{ message: { content: "absent usage" } }]
    }).complete(request);
    const malformed = await openAIProvider({
      id: "bad\r\nrequest-id",
      choices: [{ message: { content: "malformed usage" } }],
      usage: { prompt_tokens: -1, completion_tokens: 1.5, total_tokens: "3", cost: -4, currency: "usd" }
    }).complete(request);

    expect(absent).not.toHaveProperty("usage");
    expect(malformed).not.toHaveProperty("usage");
    expect(malformed).not.toHaveProperty("providerCost");
    expect(malformed).not.toHaveProperty("providerRequestId");
  });

  it("normalizes ChatGPT JSON Responses usage without inventing cost", async () => {
    const result = await chatGptProvider(async () => openAIResponse({
      id: "resp-json-123",
      output: [{ type: "message", content: [{ type: "output_text", text: "json response" }] }],
      usage: {
        input_tokens: 40,
        output_tokens: 12,
        total_tokens: 52,
        input_tokens_details: { cached_tokens: 9 },
        output_tokens_details: { reasoning_tokens: 4 }
      }
    })).complete(request);

    expect(result).toEqual({
      message: "json response",
      toolCalls: [],
      usage: {
        inputTokens: 40,
        outputTokens: 12,
        reasoningTokens: 4,
        cacheReadTokens: 9,
        totalTokens: 52
      },
      providerResponseId: "resp-json-123"
    });
    expect(result).not.toHaveProperty("providerCost");
  });

  it("keeps the greatest cumulative ChatGPT SSE snapshot without duplication or stale regression", async () => {
    const completed = {
      id: "resp-sse-123",
      output: [{ type: "message", content: [{ type: "output_text", text: "stream response" }] }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
    };
    const result = await chatGptProvider(async () => eventStream([
      { type: "response.in_progress", response: { id: "resp-sse-123", usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
      { type: "response.completed", response: completed },
      { type: "response.completed", response: completed },
      { type: "response.completed", response: { ...completed, usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 } } }
    ])).complete(request);

    expect(result.message).toBe("stream response");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(result.usage).not.toHaveProperty("reasoningTokens");
    expect(result.providerResponseId).toBe("resp-sse-123");
  });

  it("omits malformed or absent ChatGPT SSE usage instead of fabricating zeroes", async () => {
    const result = await chatGptProvider(async () => eventStream([
      { type: "response.output_text.done", text: "safe" },
      { type: "response.completed", response: { usage: { input_tokens: -1, output_tokens: "2" } } }
    ])).complete(request);

    expect(result).toEqual({ message: "safe", toolCalls: [] });
    expect(result).not.toHaveProperty("usage");
  });

  it("does not retain cumulative usage across separate ChatGPT requests", async () => {
    const responses = [
      eventStream([{
        type: "response.completed",
        response: {
          output: [{ type: "message", content: [{ type: "output_text", text: "first" }] }],
          usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 }
        }
      }]),
      eventStream([{ type: "response.output_text.done", text: "second" }])
    ];
    const provider = chatGptProvider(async () => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected extra request");
      return response;
    });

    const first = await provider.complete(request);
    const second = await provider.complete(request);

    expect(first.usage).toEqual({ inputTokens: 8, outputTokens: 2, totalTokens: 10 });
    expect(second).not.toHaveProperty("usage");
  });

  it("fails on a misleading ChatGPT success prefix and redacts OAuth secrets", async () => {
    const provider = chatGptProvider(async () => eventStream([
      { type: "response.output_text.done", text: "looks successful" },
      { type: "response.failed", response: { error: { message: "Bearer usage-oauth-access was rejected" } } }
    ]));

    const completion = provider.complete(request);

    await expect(completion).rejects.toThrow("Bearer [redacted]");
    await expect(completion).rejects.not.toThrow("usage-oauth-access");
  });
});
