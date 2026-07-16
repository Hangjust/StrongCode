import type { ProviderAuthReader } from "../src/models/auth-store";
import { createModelProvider } from "../src/models/factory";
import { MAX_COMPLETION_RESPONSE_BYTES } from "../src/models/response-body";

vi.mock("../src/models/gcloud-delegated", () => ({
  getGoogleAdcAccessToken: vi.fn(async () => "vertex-bounded-token")
}));

const authStore: ProviderAuthReader = {
  async get() {
    return { type: "api", key: "bounded-test-key" };
  },
  async all() {
    return {};
  }
};

function model(provider: string) {
  return {
    provider,
    model: "bounded-test-model",
    displayName: "Bounded Test Model",
    enabled: true,
    source: "configured" as const
  };
}

describe("provider completion response limits", () => {
  it("enforces the shared body cap in every HTTP completion adapter", async () => {
    let fallbackReads = 0;
    const fetcher = async () => ({
      ok: true,
      status: 200,
      headers: {
        get(name: string) {
          return name.toLowerCase() === "content-length" ? String(MAX_COMPLETION_RESPONSE_BYTES + 1) : null;
        }
      },
      async text() {
        fallbackReads += 1;
        return "{}";
      }
    });

    const providers = [
      createModelProvider({
        providerId: "openai",
        providerConfig: {
          type: "openai",
          displayName: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          modelsEndpoint: "/models",
          enabled: true
        },
        modelId: "bounded-test-model",
        modelConfig: model("openai"),
        authStore,
        fetcher
      }),
      createModelProvider({
        providerId: "anthropic",
        providerConfig: {
          type: "anthropic",
          displayName: "Anthropic",
          baseUrl: "https://api.anthropic.com/v1",
          modelsEndpoint: "/models",
          enabled: true
        },
        modelId: "bounded-test-model",
        modelConfig: model("anthropic"),
        authStore,
        fetcher
      }),
      createModelProvider({
        providerId: "google",
        providerConfig: {
          type: "google",
          displayName: "Google Gemini",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          modelsEndpoint: "/models",
          enabled: true
        },
        modelId: "bounded-test-model",
        modelConfig: model("google"),
        authStore,
        fetcher
      }),
      createModelProvider({
        providerId: "google-vertex",
        providerConfig: {
          type: "google-vertex",
          displayName: "Google Vertex AI",
          baseUrl: "https://europe-west4-aiplatform.googleapis.com",
          projectId: "bounded-project",
          location: "europe-west4",
          enabled: true
        },
        modelId: "bounded-test-model",
        modelConfig: model("google-vertex"),
        fetcher
      })
    ];

    for (const provider of providers) {
      await expect(provider.complete({
        prompt: "hello",
        sessionId: "bounded-response",
        messages: [],
        tools: []
      })).rejects.toThrow("exceeded 10 MB");
    }
    expect(fallbackReads).toBe(0);
  });
});
