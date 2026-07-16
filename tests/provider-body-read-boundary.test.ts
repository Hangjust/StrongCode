import { describe, expect, it } from "vitest";
import { StrongCodeError } from "../src/core/errors";
import type { ProviderAuth, ProviderAuthReader } from "../src/models/auth-store";
import { OpenAICompatibleModelProvider, type OpenAICompatibleFetcher } from "../src/models/openai-compatible-provider";
import { providerDefaults } from "../src/models/registry";
import { MAX_COMPLETION_RESPONSE_BYTES } from "../src/models/response-body";

const request = {
  prompt: "Exercise the body-read trust boundary",
  sessionId: "body-read-boundary",
  messages: [],
  tools: []
};

const authStore: ProviderAuthReader = {
  async get(): Promise<ProviderAuth> {
    return { type: "api", key: "configured-boundary-key" };
  },
  async all(): Promise<Record<string, ProviderAuth>> {
    return {};
  }
};

function provider(fetcher: OpenAICompatibleFetcher): OpenAICompatibleModelProvider {
  return new OpenAICompatibleModelProvider({
    providerId: "deepseek",
    providerConfig: { ...providerDefaults().deepseek, enabled: true },
    modelId: "deepseek-chat",
    modelConfig: { provider: "deepseek", model: "deepseek-chat", enabled: true },
    authStore,
    fetcher
  });
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
const RESPONSE_TOO_LARGE_MESSAGE = "Model completion response exceeded 10 MB";

describe("OpenAI-compatible body-read trust boundary", () => {
  it("preserves the local size condition for a text-only oversized body", async () => {
    const error = await capturedError(provider(async () => ({
      ok: true,
      status: 200,
      async text(): Promise<string> {
        return "x".repeat(MAX_COMPLETION_RESPONSE_BYTES + 1);
      }
    })).complete(request));

    expect(error.code).toBe("MODEL_ERROR");
    expect(error.message).toBe(RESPONSE_TOO_LARGE_MESSAGE);
  });

  it("preserves the local size condition for an oversized streamed body", async () => {
    const response = new Response("x".repeat(MAX_COMPLETION_RESPONSE_BYTES + 1), { status: 200 });

    const error = await capturedError(provider(async () => response).complete(request));

    expect(error.code).toBe("MODEL_ERROR");
    expect(error.message).toBe(RESPONSE_TOO_LARGE_MESSAGE);
  });

  it("makes a throwing response header accessor opaque", async () => {
    const sentinel = `header-${crypto.randomUUID()}`;
    const error = await capturedError(provider(async () => ({
      ok: true,
      status: 200,
      headers: {
        get(): string | null {
          throw new Error(sentinel, { cause: new Error(`cause-${sentinel}`) });
        }
      },
      async text(): Promise<string> {
        return "{}";
      }
    })).complete(request));

    expect(error.code).toBe("MODEL_ERROR");
    expect(error.message).toBe(BODY_READ_FAILED_MESSAGE);
    expect(error.message).not.toContain(sentinel);
    expect(error.cause).toBeUndefined();
  });

  it("reads declared length once so a changing header cannot spoof the local size condition", async () => {
    let headerReads = 0;
    const sentinel = `body-${crypto.randomUUID()}`;
    const error = await capturedError(provider(async () => ({
      ok: true,
      status: 200,
      headers: {
        get(): string | null {
          headerReads += 1;
          return headerReads === 1 ? null : String(MAX_COMPLETION_RESPONSE_BYTES + 1);
        }
      },
      async text(): Promise<string> {
        throw new Error(sentinel);
      }
    })).complete(request));

    expect(error.code).toBe("MODEL_ERROR");
    expect(error.message).toBe(BODY_READ_FAILED_MESSAGE);
    expect(error.message).not.toContain(sentinel);
    expect(headerReads).toBe(1);
  });

  it("uses the bounded reader's integer parsing for a declared oversized body", async () => {
    let bodyRead = false;
    const error = await capturedError(provider(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => `${MAX_COMPLETION_RESPONSE_BYTES + 1}x` },
      async text(): Promise<string> {
        bodyRead = true;
        return "{}";
      }
    })).complete(request));

    expect(error.code).toBe("MODEL_ERROR");
    expect(error.message).toBe(RESPONSE_TOO_LARGE_MESSAGE);
    expect(bodyRead).toBe(false);
  });

  it("does not treat exponent-form header text as a local size condition", async () => {
    const sentinel = `body-${crypto.randomUUID()}`;
    const error = await capturedError(provider(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "1e100" },
      async text(): Promise<string> {
        throw new StrongCodeError("VALIDATION_ERROR", sentinel);
      }
    })).complete(request));

    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.message).toBe(BODY_READ_FAILED_MESSAGE);
    expect(error.message).not.toContain(sentinel);
  });
});
