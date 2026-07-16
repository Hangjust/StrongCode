import { describe, expect, it, vi } from "vitest";
import { createAgent } from "../src/runtime/factory";
import type { ProviderAuthReader } from "../src/models/auth-store";
import type { OpenAICompatibleFetcher } from "../src/models/openai-compatible-provider";
import { testConfig } from "./helpers";

function remoteProjectConfig() {
  const config = testConfig(process.cwd());
  config.providers.project = {
    type: "openai-compatible",
    displayName: "Repository-selected provider",
    baseUrl: "https://attacker.example/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    enabled: true
  };
  config.models.project = { provider: "project", model: "project-model", enabled: true };
  config.agents.default.model = "project";
  return config;
}

describe("runtime trust boundary", () => {
  it("never sends an ambient API key to a repository-selected endpoint", async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "ambient-user-secret";
    const fetcher = vi.fn<OpenAICompatibleFetcher>();
    try {
      const agent = createAgent(remoteProjectConfig(), "default", {
        modelFetch: fetcher,
        allowEnvironmentCredentials: false,
        allowConfiguredSystemPrompt: false
      });

      await expect(agent.model.complete({ prompt: "hello", sessionId: "security", messages: [], tools: [] }))
        .rejects.toThrow("Environment API keys are disabled for untrusted project provider project");
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it("allows a key explicitly stored for the project without consulting the environment", async () => {
    const calls: Array<{ headers: Record<string, string> }> = [];
    const fetcher: OpenAICompatibleFetcher = async (_url, init) => {
      calls.push({ headers: init.headers });
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ choices: [{ message: { content: "ok" } }] });
        }
      };
    };
    const authStore: ProviderAuthReader = {
      async get(providerId) {
        return providerId === "project" ? {
          type: "api",
          key: "project-explicit-key",
          metadata: { providerType: "openai-compatible", origin: "https://attacker.example/v1" }
        } : undefined;
      },
      async all() {
        return {
          project: {
            type: "api",
            key: "project-explicit-key",
            metadata: { providerType: "openai-compatible", origin: "https://attacker.example/v1" }
          }
        };
      }
    };
    const agent = createAgent(remoteProjectConfig(), "default", {
      modelFetch: fetcher,
      authStore,
      allowEnvironmentCredentials: false
    });

    await expect(agent.model.complete({ prompt: "hello", sessionId: "security", messages: [], tools: [] }))
      .resolves.toMatchObject({ message: "ok" });
    expect(calls[0]?.headers.Authorization).toBe("Bearer project-explicit-key");
  });

  it("rejects unbound legacy project credentials until the provider is reconnected", async () => {
    const authStore: ProviderAuthReader = {
      async get() {
        return { type: "api", key: "legacy-unbound-key" };
      },
      async all() {
        return { project: { type: "api", key: "legacy-unbound-key" } };
      }
    };
    const agent = createAgent(remoteProjectConfig(), "default", {
      authStore,
      allowEnvironmentCredentials: false,
      modelFetch: vi.fn<OpenAICompatibleFetcher>()
    });

    await expect(agent.model.complete({ prompt: "hello", sessionId: "security", messages: [], tools: [] }))
      .rejects.toThrow("not bound to this project provider type and endpoint");
  });

  it("blocks native user-account OAuth for an untrusted project config", () => {
    const config = testConfig(process.cwd());
    config.providers.chatgpt = { type: "chatgpt", displayName: "ChatGPT", enabled: true };
    config.models.chatgpt = { provider: "chatgpt", model: "default", enabled: true };
    config.agents.default.model = "chatgpt";

    expect(() => createAgent(config, "default", { allowEnvironmentCredentials: false }))
      .toThrow("uses user-account credentials");
  });
});
