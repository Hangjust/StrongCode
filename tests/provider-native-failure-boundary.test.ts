import { StrongCodeError } from "../src/core/errors";
import type { ProviderAuth, ProviderAuthReader } from "../src/models/auth-store";
import { AnthropicModelProvider } from "../src/models/anthropic-provider";
import { GoogleGeminiModelProvider } from "../src/models/google-provider";
import { GoogleVertexModelProvider } from "../src/models/google-vertex-provider";
import type { NativeProviderFetcher } from "../src/models/native-provider-utils";
import type { ModelProvider, ModelRequest } from "../src/models/provider";
import { providerDefaults } from "../src/models/registry";
import { MAX_COMPLETION_RESPONSE_BYTES } from "../src/models/response-body";

vi.mock("../src/models/gcloud-delegated", () => ({
  getGoogleAdcAccessToken: vi.fn(async () => "vertex-boundary-token")
}));

type NativeKind = "anthropic" | "gemini" | "vertex";

const authStore: ProviderAuthReader = {
  async get(): Promise<ProviderAuth> {
    return { type: "api", key: "native-boundary-key" };
  },
  async all(): Promise<Record<string, ProviderAuth>> {
    return {};
  }
};

const request: ModelRequest = { prompt: "failure boundary", sessionId: "native-boundary", messages: [], tools: [] };

const carriers = [
  { name: "Error", create: (sentinel: string): unknown => new Error(sentinel, { cause: new Error(`cause-${sentinel}`) }) },
  { name: "StrongCodeError", create: (sentinel: string): unknown => new StrongCodeError("VALIDATION_ERROR", sentinel) },
  { name: "string", create: (sentinel: string): unknown => sentinel },
  { name: "object", create: (sentinel: string): unknown => ({ message: sentinel, cause: `cause-${sentinel}` }) }
] as const;

function provider(kind: NativeKind, fetcher: NativeProviderFetcher): ModelProvider {
  switch (kind) {
    case "anthropic":
      return new AnthropicModelProvider({
        providerId: "anthropic",
        providerConfig: { ...providerDefaults().anthropic, enabled: true },
        modelId: "claude-test",
        modelConfig: { provider: "anthropic", model: "claude-test", enabled: true },
        authStore,
        fetcher
      });
    case "gemini":
      return new GoogleGeminiModelProvider({
        providerId: "google",
        providerConfig: { ...providerDefaults().google, enabled: true },
        modelId: "gemini-test",
        modelConfig: { provider: "google", model: "gemini-test", enabled: true },
        authStore,
        fetcher
      });
    case "vertex":
      return new GoogleVertexModelProvider({
        providerId: "google-vertex",
        providerConfig: {
          ...providerDefaults()["google-vertex"],
          projectId: "boundary-project",
          location: "europe-west4",
          enabled: true
        },
        modelId: "gemini-test",
        modelConfig: { provider: "google-vertex", model: "gemini-test", enabled: true },
        fetcher
      });
  }
}

function providerId(kind: NativeKind): string {
  if (kind === "anthropic") return "anthropic";
  if (kind === "gemini") return "google";
  return "google-vertex";
}

async function capturedError(action: Promise<unknown>): Promise<StrongCodeError> {
  try {
    await action;
  } catch (error) {
    if (error instanceof StrongCodeError) return error;
    throw error;
  }
  throw new StrongCodeError("VALIDATION_ERROR", "Expected native provider failure");
}

describe("native provider failure opacity", () => {
  it.each(["anthropic", "gemini", "vertex"] as const)("makes every %s fetch source failure opaque", async kind => {
    for (const carrier of carriers) {
      // Given
      const sentinel = `${carrier.name}-fetch-${crypto.randomUUID()}`;
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const fetcher: NativeProviderFetcher = async () => Promise.reject(carrier.create(sentinel));

      // When
      const error = await capturedError(provider(kind, fetcher).complete(request));

      // Then
      expect(error.code).toBe("MODEL_ERROR");
      expect(error.message).toBe(`Provider ${providerId(kind)} completion request failed`);
      expect(error.message).not.toContain(sentinel);
      expect(error.cause).toBeUndefined();
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(errorLog).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    }
  });

  it.each(["anthropic", "gemini", "vertex"] as const)("makes every %s body-read source failure opaque", async kind => {
    for (const carrier of carriers) {
      // Given
      const sentinel = `${carrier.name}-body-${crypto.randomUUID()}`;
      const fetcher: NativeProviderFetcher = async () => ({
        ok: true,
        status: 200,
        async text(): Promise<string> {
          return Promise.reject(carrier.create(sentinel));
        }
      });

      // When
      const error = await capturedError(provider(kind, fetcher).complete(request));

      // Then
      expect(error.code).toBe(carrier.name === "StrongCodeError" ? "VALIDATION_ERROR" : "MODEL_ERROR");
      expect(error.message).toBe(`Provider ${providerId(kind)} completion response failed`);
      expect(error.message).not.toContain(sentinel);
      expect(error.cause).toBeUndefined();
    }
  });

  it.each(["anthropic", "gemini", "vertex"] as const)("lets exact abort identity win over a %s body-read race", async kind => {
    // Given
    const controller = new AbortController();
    const reason = new StrongCodeError("CANCELLED", `${kind} exact abort`);
    const fetcher: NativeProviderFetcher = async () => ({
      ok: true,
      status: 200,
      async text(): Promise<string> {
        controller.abort(reason);
        throw new Error(`source-${crypto.randomUUID()}`);
      }
    });

    // When
    const completion = provider(kind, fetcher).complete({ ...request, signal: controller.signal });

    // Then
    await expect(completion).rejects.toBe(reason);
  });

  it.each(["anthropic", "gemini", "vertex"] as const)("preserves only a locally proven %s bounded-body error", async kind => {
    // Given
    const genuine: NativeProviderFetcher = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => String(MAX_COMPLETION_RESPONSE_BYTES + 1) },
      async text(): Promise<string> { return ""; }
    });
    const impersonated: NativeProviderFetcher = async () => ({
      ok: true,
      status: 200,
      async text(): Promise<string> {
        throw new StrongCodeError("MODEL_ERROR", "Model completion response exceeded 10 MB");
      }
    });

    // When
    const genuineError = await capturedError(provider(kind, genuine).complete(request));
    const impersonatedError = await capturedError(provider(kind, impersonated).complete(request));

    // Then
    expect(genuineError.message).toBe("Model completion response exceeded 10 MB");
    expect(impersonatedError.message).toBe(`Provider ${providerId(kind)} completion response failed`);
  });
});
