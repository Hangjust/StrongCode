import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StrongCodeConfig } from "../src/config/schema";
import { ProviderAuthStore } from "../src/models/auth-store";
import { discoverAuthenticatedProviderModels } from "../src/models/model-availability";
import { DiscoveryFetcher } from "../src/models/discovery";

function configWithProviders(providers: StrongCodeConfig["providers"]): StrongCodeConfig {
  return {
    version: 1,
    workspace: ".",
    dataDir: ".strongcode",
    defaultAgent: "default",
    providers,
    agents: {
      default: {
        model: "mock",
        tools: []
      }
    },
    models: {
      mock: {
        provider: "mock",
        model: "mock",
        displayName: undefined,
        enabled: true,
        source: undefined,
        options: undefined
      }
    },
    permissions: {
      tools: {}
    }
  };
}

describe("authenticated model availability", () => {
  it("discovers selectable models for env-authenticated providers without exposing the key", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-model-availability-env-"));
    const store = new ProviderAuthStore(root);
    const original = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test-secret-never-render";
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetcher: DiscoveryFetcher = async (url, init) => {
      calls.push({ url, headers: init.headers });
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: [{ id: "gpt-test" }, { id: "gpt-mini" }] };
        }
      };
    };

    try {
      const result = await discoverAuthenticatedProviderModels(configWithProviders({
        openai: {
          type: "openai",
          displayName: "GPT / OpenAI",
          apiKeyEnv: "OPENAI_API_KEY",
          baseUrl: "https://api.openai.com/v1",
          modelsEndpoint: "/models",
          enabled: false
        },
        mock: {
          type: "mock",
          displayName: "Mock",
          apiKeyEnv: undefined,
          baseUrl: undefined,
          modelsEndpoint: undefined,
          enabled: true
        }
      }), store, fetcher);

      expect(calls).toEqual([{ url: "https://api.openai.com/v1/models", headers: { Authorization: "Bearer sk-test-secret-never-render" } }]);
      expect(result.changed).toBe(true);
      expect(result.config.models["gpt-test"]).toMatchObject({ provider: "openai", model: "gpt-test", enabled: true, source: "discovered" });
      expect(result.config.models["gpt-mini"]).toMatchObject({ provider: "openai", model: "gpt-mini", enabled: true, source: "discovered" });
      expect(JSON.stringify(result.config)).not.toContain("sk-test-secret-never-render");
      expect(JSON.stringify(result.config)).not.toContain("Authorization");
      expect(JSON.stringify(result.config)).not.toContain("Bearer");
    } finally {
      if (original === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = original;
    }
  });

  it("discovers models for providers authenticated through auth.json", async () => {
    const original = process.env.MOONSHOT_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-model-availability-auth-"));
    const store = new ProviderAuthStore(root);
    await store.set("kimi", { type: "api", key: "moonshot-secret-never-render" });
    const fetcher: DiscoveryFetcher = async (_url, init) => {
      expect(init.headers).toEqual({ Authorization: "Bearer moonshot-secret-never-render" });
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: [{ id: "kimi-k2" }] };
        }
      };
    };

    try {
      const result = await discoverAuthenticatedProviderModels(configWithProviders({
        kimi: {
          type: "openai-compatible",
          displayName: "Kimi",
          apiKeyEnv: "MOONSHOT_API_KEY",
          baseUrl: "https://api.moonshot.ai/v1",
          modelsEndpoint: "/models",
          enabled: false
        },
        mock: {
          type: "mock",
          displayName: "Mock",
          apiKeyEnv: undefined,
          baseUrl: undefined,
          modelsEndpoint: undefined,
          enabled: true
        }
      }), store, fetcher);

      expect(result.config.models["kimi-k2"]).toMatchObject({ provider: "kimi", model: "kimi-k2", enabled: true });
      expect(JSON.stringify(result.config)).not.toContain("moonshot-secret-never-render");
    } finally {
      if (original === undefined) delete process.env.MOONSHOT_API_KEY;
      else process.env.MOONSHOT_API_KEY = original;
    }
  });

  it("skips unauthenticated and unsupported providers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-model-availability-skip-"));
    const store = new ProviderAuthStore(root);
    await store.set("anthropic", { type: "api", key: "anthropic-secret-never-render" });
    const fetcher: DiscoveryFetcher = async () => {
      throw new Error("fetch should not run for unauthenticated or unsupported providers");
    };

    const result = await discoverAuthenticatedProviderModels(configWithProviders({
      openai: {
        type: "openai",
        displayName: "GPT / OpenAI",
        apiKeyEnv: "OPENAI_API_KEY",
        baseUrl: "https://api.openai.com/v1",
        modelsEndpoint: "/models",
        enabled: false
      },
      anthropic: {
        type: "anthropic",
        displayName: "Claude",
        apiKeyEnv: "ANTHROPIC_API_KEY",
        baseUrl: undefined,
        modelsEndpoint: undefined,
        enabled: false
      },
      mock: {
        type: "mock",
        displayName: "Mock",
        apiKeyEnv: undefined,
        baseUrl: undefined,
        modelsEndpoint: undefined,
        enabled: true
      }
    }), store, fetcher);

    expect(result.changed).toBe(false);
    expect(Object.keys(result.config.models)).toEqual(["mock"]);
    expect(JSON.stringify(result.config)).not.toContain("anthropic-secret-never-render");
  });
});
