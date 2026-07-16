import { discoverAnthropicModels, discoverOpenAICompatibleModels, discoverProviderModels, DiscoveryFetcher, globalFetchTransport } from "../src/models/discovery";
import { ProviderAuthStore } from "../src/models/auth-store";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

describe("model discovery", () => {
  it("caps aggregate discovery model counts", async () => {
    await expect(discoverOpenAICompatibleModels({
      id: "custom",
      type: "openai-compatible",
      displayName: "Oversized Catalog",
      baseUrl: "https://example.com/v1",
      modelsEndpoint: "/models"
    }, async () => ({
      ok: true,
      status: 200,
      async json() {
        return { data: Array.from({ length: 10_001 }, (_, index) => ({ id: `model-${index}` })) };
      }
    }))).rejects.toThrow("model count limit");
  });

  it("caps paginated discovery before an unbounded provider can continue", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-discovery-pages-"));
    const authStore = new ProviderAuthStore(root);
    await authStore.set("anthropic", { type: "api", key: "anthropic-page-key" });
    let pages = 0;

    await expect(discoverAnthropicModels({
      id: "anthropic",
      type: "anthropic",
      displayName: "Anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      modelsEndpoint: "/models",
      authStore
    }, async () => {
      pages += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            data: [{ id: `claude-page-${pages}` }],
            has_more: true,
            last_id: `claude-page-${pages}`
          };
        }
      };
    })).rejects.toThrow("page limit");

    expect(pages).toBe(25);
  });

  it("caps aggregate bytes across individually bounded discovery pages", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-discovery-bytes-"));
    const authStore = new ProviderAuthStore(root);
    await authStore.set("anthropic", { type: "api", key: "anthropic-byte-key" });
    let pages = 0;

    await expect(discoverAnthropicModels({
      id: "anthropic",
      type: "anthropic",
      displayName: "Anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      modelsEndpoint: "/models",
      authStore
    }, async () => {
      pages += 1;
      return {
        ok: true,
        status: 200,
        responseBytes: 4 * 1024 * 1024,
        async json() {
          return {
            data: [{ id: `claude-byte-page-${pages}` }],
            has_more: true,
            last_id: `claude-byte-page-${pages}`
          };
        }
      };
    })).rejects.toThrow("aggregate response limit");

    expect(pages).toBe(6);
  });

  it("dispatches native provider discovery instead of assuming OpenAI compatibility", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-discovery-google-"));
    const authStore = new ProviderAuthStore(root);
    await authStore.set("google", { type: "api", key: "google-discovery-key" });

    const result = await discoverProviderModels({
      id: "google",
      type: "google",
      displayName: "Google Gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      modelsEndpoint: "/models",
      authStore
    }, async (url, init) => {
      expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models");
      expect(init.headers).toEqual({ "x-goog-api-key": "google-discovery-key" });
      return {
        ok: true,
        status: 200,
        async json() {
          return { models: [{ name: "models/gemini-native", displayName: "Gemini Native" }] };
        }
      };
    });

    expect(result).toEqual([expect.objectContaining({ id: "gemini-native", provider: "google" })]);
  });

  it("stops streaming a discovery response as soon as it exceeds 5 MB", async () => {
    const originalFetch = globalThis.fetch;
    let pulls = 0;
    let cancelled = false;
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() {
        cancelled = true;
      }
    }), { status: 200 })) as typeof fetch;

    try {
      await expect(globalFetchTransport()("https://example.com/v1/models", { method: "GET", headers: {} }))
        .rejects.toThrow("exceeded 5 MB");
      expect(pulls).toBeLessThanOrEqual(7);
      expect(cancelled).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("discovers OpenAI-compatible model ids with an injected fetcher", async () => {
    const calls: string[] = [];
    const fetcher: DiscoveryFetcher = async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: [{ id: "custom-a" }, { id: "custom-b" }] };
        }
      };
    };

    const result = await discoverOpenAICompatibleModels({
      type: "openai-compatible",
      displayName: "Custom Provider",
      baseUrl: "https://example.com/v1",
      modelsEndpoint: "/models",
      enabled: true,
      id: "custom"
    }, fetcher);

    expect(calls).toEqual(["https://example.com/v1/models"]);
    expect(result.map(model => model.id)).toEqual(["custom-a", "custom-b"]);
    expect(result[0].enabled).toBe(false);
  });

  it("filters unsafe model IDs and sanitizes remote display metadata", async () => {
    const result = await discoverOpenAICompatibleModels({
      type: "openai-compatible",
      displayName: "Custom Provider",
      baseUrl: "https://example.com/v1",
      modelsEndpoint: "/models",
      id: "custom"
    }, async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          data: [
            { id: "safe-model", display_name: "Safe\u001b[31m\nModel" },
            { id: "bad\nmodel" },
            { id: "x".repeat(257) },
            null
          ]
        };
      }
    }));

    expect(result).toEqual([expect.objectContaining({ id: "safe-model", displayName: "Safe Model" })]);
  });

  it("sends authorization for model discovery when apiKeyEnv is configured", async () => {
    const originalApiKey = process.env.CUSTOM_PROVIDER_API_KEY;
    process.env.CUSTOM_PROVIDER_API_KEY = "discovery-key";

    try {
      const result = await discoverOpenAICompatibleModels({
        type: "openai-compatible",
        displayName: "Custom Provider",
        apiKeyEnv: "CUSTOM_PROVIDER_API_KEY",
        baseUrl: "https://example.com/v1",
        modelsEndpoint: "/models",
        id: "custom"
      }, async (_url, init) => {
        expect(init.headers).toEqual({ Authorization: "Bearer discovery-key" });
        return {
          ok: true,
          status: 200,
          async json() {
            return { data: [{ id: "custom-auth" }] };
          }
        };
      });

      expect(result[0].id).toBe("custom-auth");
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.CUSTOM_PROVIDER_API_KEY;
      } else {
        process.env.CUSTOM_PROVIDER_API_KEY = originalApiKey;
      }
    }
  });

  it("rejects legacy ChatGPT OAuth tokens instead of sending them to the OpenAI API", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-discovery-oauth-"));
    const authStore = new ProviderAuthStore(root);
    await authStore.set("openai", { type: "oauth", access: "oauth-access", refresh: "oauth-refresh", expires: Date.now() + 60_000, accountId: "account-123" });
    await expect(discoverOpenAICompatibleModels({
      type: "openai",
      displayName: "GPT / OpenAI",
      apiKeyEnv: "OPENAI_API_KEY",
      baseUrl: "https://api.openai.com/v1",
      modelsEndpoint: "/models",
      id: "openai",
      authStore
    }, async () => {
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: [{ id: "gpt-test" }] };
        }
      };
    })).rejects.toThrow("ChatGPT browser or headless login");
  });

  it("rejects unsafe model endpoint values", async () => {
    await expect(discoverOpenAICompatibleModels({
      type: "openai-compatible",
      displayName: "Custom Provider",
      baseUrl: "http://localhost:11434/v1",
      modelsEndpoint: "//example.com/models",
      id: "custom"
    }, async () => ({
      ok: true,
      status: 200,
      async json() {
        return { data: [] };
      }
    }))).rejects.toThrow("stay relative");

    await expect(discoverOpenAICompatibleModels({
      type: "openai-compatible",
      displayName: "Custom Provider",
      baseUrl: "https://example.com/v1",
      modelsEndpoint: "/models?api_key=secret",
      id: "custom"
    }, async () => ({
      ok: true,
      status: 200,
      async json() {
        return { data: [] };
      }
    }))).rejects.toThrow("query string");
  });

  it("rejects non-local http provider URLs", async () => {
    await expect(discoverOpenAICompatibleModels({
      type: "openai-compatible",
      displayName: "Custom Provider",
      apiKeyEnv: "CUSTOM_PROVIDER_API_KEY",
      baseUrl: "http://example.com/v1",
      modelsEndpoint: "/models",
      enabled: true,
      id: "custom"
    }, async () => ({
      ok: true,
      status: 200,
      async json() {
        return { data: [] };
      }
    }))).rejects.toThrow("https");
  });

  it("allows localhost http provider URLs", async () => {
    const calls: string[] = [];

    await discoverOpenAICompatibleModels({
      type: "openai-compatible",
      displayName: "Local Provider",
      baseUrl: "http://localhost:11434/v1",
      modelsEndpoint: "/models",
      id: "custom"
    }, async url => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: [{ id: "local-model" }] };
        }
      };
    });

    expect(calls).toEqual(["http://localhost:11434/v1/models"]);
  });

  it("allows IPv6 localhost http provider URLs", async () => {
    const calls: string[] = [];

    await discoverOpenAICompatibleModels({
      type: "openai-compatible",
      displayName: "Local Provider",
      baseUrl: "http://[::1]:11434/v1",
      modelsEndpoint: "/models",
      id: "custom"
    }, async url => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: [{ id: "local-model" }] };
        }
      };
    });

    expect(calls).toEqual(["http://[::1]:11434/v1/models"]);
  });

  it("rejects malformed discovery payloads", async () => {
    await expect(discoverOpenAICompatibleModels({
      type: "openai-compatible",
      displayName: "Custom Provider",
      baseUrl: "https://example.com/v1",
      modelsEndpoint: "/models",
      id: "custom"
    }, async () => ({
      ok: true,
      status: 200,
      async json() {
        return { object: "list" };
      }
    }))).rejects.toThrow("data array");
  });

  it("reports HTTP discovery failures", async () => {
    await expect(discoverOpenAICompatibleModels({
      type: "openai-compatible",
      displayName: "Custom Provider",
      baseUrl: "https://example.com/v1",
      modelsEndpoint: "/models",
      id: "custom"
    }, async () => ({
      ok: false,
      status: 500,
      async json() {
        return {};
      }
    }))).rejects.toThrow("HTTP 500");
  });
});
