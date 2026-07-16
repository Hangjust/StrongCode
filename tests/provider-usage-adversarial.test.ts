import { describe, expect, it } from "vitest";
import { StrongCodeError } from "../src/core/errors";
import type { OAuthProviderAuth, ProviderAuth, ProviderAuthReader } from "../src/models/auth-store";
import type { ChatGptOAuthFetch } from "../src/models/chatgpt-oauth";
import { ChatGptModelProvider } from "../src/models/chatgpt-provider";
import { OpenAICompatibleModelProvider, type OpenAICompatibleFetcher } from "../src/models/openai-compatible-provider";
import { providerDefaults } from "../src/models/registry";
import { MAX_COMPLETION_RESPONSE_BYTES } from "../src/models/response-body";

const request = {
  prompt: "Exercise adversarial provider metadata",
  sessionId: "usage-adversarial",
  messages: [],
  tools: []
};

const apiAuthStore: ProviderAuthReader = {
  async get(): Promise<ProviderAuth> {
    return { type: "api", key: "api-secret-adversarial" };
  },
  async all(): Promise<Record<string, ProviderAuth>> {
    return {};
  }
};

class OAuthAuthStore implements ProviderAuthReader {
  readonly auth: OAuthProviderAuth = {
    type: "oauth",
    access: "oauth-secret-adversarial",
    expires: Date.now() + 3_600_000
  };

  async get(): Promise<ProviderAuth> {
    return this.auth;
  }

  async all(): Promise<Record<string, ProviderAuth>> {
    return { chatgpt: this.auth };
  }
}

function openAIProvider(fetcher: OpenAICompatibleFetcher): OpenAICompatibleModelProvider {
  return new OpenAICompatibleModelProvider({
    providerId: "deepseek",
    providerConfig: { ...providerDefaults().deepseek, enabled: true },
    modelId: "deepseek-chat",
    modelConfig: { provider: "deepseek", model: "deepseek-chat", enabled: true },
    authStore: apiAuthStore,
    fetcher
  });
}

function chatGptProvider(fetcher: ChatGptOAuthFetch): ChatGptModelProvider {
  return new ChatGptModelProvider({
    providerId: "chatgpt",
    providerConfig: { ...providerDefaults().chatgpt, enabled: true },
    modelId: "gpt-5.5",
    modelConfig: { provider: "chatgpt", model: "gpt-5.5", enabled: true },
    authStore: new OAuthAuthStore(),
    fetcher,
    timeoutMs: 2_000
  });
}

function sse(events: readonly Readonly<Record<string, unknown>>[]): Response {
  const text = events
    .map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function capturedError(action: Promise<unknown>): Promise<StrongCodeError> {
  try {
    await action;
  } catch (error) {
    if (error instanceof StrongCodeError) return error;
    throw error;
  }
  throw new StrongCodeError("VALIDATION_ERROR", "Expected provider completion to reject");
}

const BODY_READ_FAILED_MESSAGE = "Provider deepseek completion response body read failed";

const bodyReadFailureCarriers = [
  {
    name: "Error",
    code: "MODEL_ERROR",
    create: (message: string): unknown => new Error(message)
  },
  {
    name: "StrongCodeError",
    code: "VALIDATION_ERROR",
    create: (message: string): unknown => new StrongCodeError("VALIDATION_ERROR", message)
  },
  {
    name: "string",
    code: "MODEL_ERROR",
    create: (message: string): unknown => message
  }
] as const;

const bodyReadPayloads = [
  { name: "Basic quoted credential", create: (sentinel: string) => `Authorization: Basic "${sentinel}"` },
  { name: "quoted scheme and credential", create: (sentinel: string) => `Authorization: "Basic ${sentinel}"` },
  { name: "Digest parameters", create: (sentinel: string) => `Authorization: Digest username="${sentinel}", realm="public"` },
  { name: "generated scheme parameters", create: (sentinel: string) => `Authorization: X${sentinel.replaceAll("-", "")} token="${sentinel}",next='second'; escaped=\\"${sentinel}\\"` },
  { name: "CRLF continuation", create: (sentinel: string) => `prefix\r\nAuthorization: Basic ${sentinel}\r\n suffix` },
  { name: "LF continuation", create: (sentinel: string) => `prefix\nAuthorization: Digest token=${sentinel}\n suffix` },
  { name: "lone CR continuation", create: (sentinel: string) => `prefix\rAuthorization: Custom ${sentinel}\r suffix` },
  { name: "inline prefix and suffix", create: (sentinel: string) => `unsafe prefix Authorization: Basic ${sentinel} unsafe suffix` },
  { name: "authorization-like identifiers", create: (sentinel: string) => `notauthorization=${sentinel}; x-authorization=${sentinel}; authorization_identifier=${sentinel}` },
  { name: "body-like JSON", create: (sentinel: string) => JSON.stringify({ error: { authorization: `Digest token=${sentinel}`, body: sentinel } }) },
  { name: "configured key and different sentinel", create: (sentinel: string) => `Authorization: Bearer api-secret-adversarial; runtime=${sentinel}` },
  { name: "spoofed local size message", create: () => "Model completion response exceeded 10 MB" }
] as const;

describe("provider usage adversarial boundaries", () => {
  it("rejects a ChatGPT SSE stream containing only malformed and irrelevant blocks", async () => {
    const body = [
      "event: response.completed\ndata: {not-json}\n\n",
      "event: response.in_progress\ndata: {\"type\":\"response.in_progress\",\"response\":{}}\n\n",
      "data: [DONE]\n\n"
    ].join("");
    const provider = chatGptProvider(async () => new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    }));

    const completion = provider.complete(request);

    await expect(completion).rejects.toThrow("contained no terminal output");
  });

  for (const carrier of bodyReadFailureCarriers) {
    it.each(bodyReadPayloads)(`makes $name opaque for ${carrier.name} body-read failures`, async ({ create }) => {
      const sentinel = `runtime-${crypto.randomUUID()}`;
      const provider = openAIProvider(async () => ({
        ok: true,
        status: 200,
        async text(): Promise<string> {
          return Promise.reject(carrier.create(create(sentinel)));
        }
      }));

      const error = await capturedError(provider.complete(request));

      expect(error.code).toBe(carrier.code);
      expect(error.message).toBe(BODY_READ_FAILED_MESSAGE);
      expect(error.message).not.toContain(sentinel);
      expect(error.message).not.toContain("api-secret-adversarial");
      expect(error.cause).toBeUndefined();
    });

    it(`surfaces identical messages for unrelated ${carrier.name} body-read failures`, async () => {
      const first = await capturedError(openAIProvider(async () => ({
        ok: true,
        status: 200,
        async text(): Promise<string> {
          return Promise.reject(carrier.create(`first-${crypto.randomUUID()}`));
        }
      })).complete(request));
      const second = await capturedError(openAIProvider(async () => ({
        ok: true,
        status: 200,
        async text(): Promise<string> {
          return Promise.reject(carrier.create(`unrelated-${crypto.randomUUID()}`));
        }
      })).complete(request));

      expect(first.code).toBe(carrier.code);
      expect(second.code).toBe(carrier.code);
      expect(first.message).toBe(second.message);
      expect(first.message).toBe(BODY_READ_FAILED_MESSAGE);
    });
  }

  it("lets caller cancellation win over body-read conversion", async () => {
    const controller = new AbortController();
    const cancellation = new StrongCodeError("MODEL_ERROR", "caller cancellation");
    const provider = openAIProvider(async () => ({
      ok: true,
      status: 200,
      async text(): Promise<string> {
        controller.abort(cancellation);
        throw new Error(`body-${crypto.randomUUID()}`);
      }
    }));

    const error = await capturedError(provider.complete({ ...request, signal: controller.signal }));

    expect(error).toBe(cancellation);
  });

  it("preserves the provider-owned response size detail only for an observed local bound", async () => {
    let bodyRead = false;
    const provider = openAIProvider(async () => ({
      ok: true,
      status: 200,
      headers: {
        get(name: string): string | null {
          return name.toLowerCase() === "content-length" ? String(MAX_COMPLETION_RESPONSE_BYTES + 1) : null;
        }
      },
      async text(): Promise<string> {
        bodyRead = true;
        return "{}";
      }
    }));

    const error = await capturedError(provider.complete(request));

    expect(error.code).toBe("MODEL_ERROR");
    expect(error.message).toBe("Model completion response exceeded 10 MB");
    expect(bodyRead).toBe(false);
  });

  it("keeps the established ChatGPT response ID when a stale event arrives later", async () => {
    const current = {
      id: "resp-current",
      output: [{ type: "message", content: [{ type: "output_text", text: "current" }] }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
    };
    const result = await chatGptProvider(async () => sse([
      { type: "response.completed", response: current },
      { type: "response.in_progress", response: { id: "resp-stale", usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 } } }
    ])).complete(request);

    expect(result.providerResponseId).toBe("resp-current");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  });

  it("accepts the maximum safe token count and omits larger integers", async () => {
    const result = await openAIProvider(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "safe integer boundary" } }],
      usage: {
        prompt_tokens: Number.MAX_SAFE_INTEGER,
        completion_tokens: Number.MAX_SAFE_INTEGER + 1,
        total_tokens: 9_007_199_254_740_993
      }
    }), { status: 200 })).complete(request);

    expect(result.usage).toEqual({ inputTokens: Number.MAX_SAFE_INTEGER });
    expect(result.usage).not.toHaveProperty("outputTokens");
    expect(result.usage).not.toHaveProperty("totalTokens");
  });
});
