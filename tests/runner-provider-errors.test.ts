import { AgentRunner } from "../src/agents/runner";
import type { Agent } from "../src/agents/agent";
import { ProviderAuthStore } from "../src/models/auth-store";
import type { ProviderAuthReader } from "../src/models/auth-store";
import { GoogleGeminiModelProvider } from "../src/models/google-provider";
import type { NativeProviderFetcher } from "../src/models/native-provider-utils";
import type { OpenAICompatibleFetcher } from "../src/models/openai-compatible-provider";
import { createAgent } from "../src/runtime/factory";
import { SessionStore } from "../src/sessions/session-store";
import { createDefaultToolRegistry } from "../src/tools/registry";
import { tempWorkspace } from "./helpers";
import { openAIChatGptConfig, openAICompatibleConfig } from "./runner-config-fixtures";

describe("runner provider errors", () => {
  it("returns MODEL_ERROR for unavailable provider completion", async () => {
    const workspace = await tempWorkspace();
    const config = {
      ...workspace.config,
      providers: {
        ...workspace.config.providers,
        anthropic: {
          type: "anthropic" as const,
          displayName: "Claude",
          apiKeyEnv: "ANTHROPIC_API_KEY",
          baseUrl: undefined,
          modelsEndpoint: undefined,
          enabled: true
        }
      },
      agents: {
        ...workspace.config.agents,
        default: { ...workspace.config.agents.default, model: "claude-model" }
      },
      models: {
        ...workspace.config.models,
        "claude-model": {
          provider: "anthropic",
          model: "claude-model",
          displayName: "Claude Model",
          enabled: true,
          source: "configured" as const,
          options: undefined
        }
      }
    };
    const runner = new AgentRunner(workspace.context, new SessionStore(workspace.context.dataDir), createDefaultToolRegistry());

    const result = await runner.run(createAgent(config, "default"), "hello", "unsupported");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("MODEL_ERROR");
  });

  it("returns MODEL_ERROR when provider apiKeyEnv is missing at runtime", async () => {
    const workspace = await tempWorkspace();
    const originalApiKey = process.env.STRONGCODE_TEST_API_KEY;
    delete process.env.STRONGCODE_TEST_API_KEY;
    try {
      const fetcher: OpenAICompatibleFetcher = async () => { throw new Error("fetch should not run"); };
      const agent = createAgent(openAICompatibleConfig(workspace), "default", { modelFetch: fetcher });
      const runner = new AgentRunner(workspace.context, new SessionStore(workspace.context.dataDir), createDefaultToolRegistry());

      const result = await runner.run(agent, "hello", "missing-env");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject({ code: "MODEL_ERROR", message: "Primary provider failed" });
        expect(result.error.message).not.toContain("STRONGCODE_TEST_API_KEY");
      }
    } finally {
      if (originalApiKey === undefined) delete process.env.STRONGCODE_TEST_API_KEY;
      else process.env.STRONGCODE_TEST_API_KEY = originalApiKey;
    }
  });

  it("rejects OAuth on the OpenAI API provider and directs users to native ChatGPT login", async () => {
    const workspace = await tempWorkspace();
    const originalApiKey = process.env.STRONGCODE_TEST_OPENAI_API_KEY;
    delete process.env.STRONGCODE_TEST_OPENAI_API_KEY;
    const authStore = new ProviderAuthStore(workspace.context.dataDir);
    await authStore.set("openai", {
      type: "oauth",
      access: "oauth-access",
      refresh: "oauth-refresh",
      expires: Date.now() + 60_000,
      accountId: "account-123"
    });
    try {
      const fetcher: OpenAICompatibleFetcher = async () => new Response("unexpected");
      const agent = createAgent(openAIChatGptConfig(workspace), "default", { modelFetch: fetcher, authStore });
      const runner = new AgentRunner(workspace.context, new SessionStore(workspace.context.dataDir), createDefaultToolRegistry());

      const result = await runner.run(agent, "hello", "openai-oauth");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject({ code: "MODEL_ERROR", message: "Primary provider failed" });
        expect(result.error.message).not.toContain("ChatGPT browser or headless login");
      }
    } finally {
      if (originalApiKey === undefined) delete process.env.STRONGCODE_TEST_OPENAI_API_KEY;
      else process.env.STRONGCODE_TEST_OPENAI_API_KEY = originalApiKey;
    }
  });

  it("redacts provider HTTP errors", async () => {
    const workspace = await tempWorkspace();
    const originalApiKey = process.env.STRONGCODE_TEST_API_KEY;
    process.env.STRONGCODE_TEST_API_KEY = "super-secret-key";
    try {
      const fetcher: OpenAICompatibleFetcher = async () => new Response(JSON.stringify({
        error: { message: "Authorization Bearer super-secret-key is invalid" }
      }), { status: 401, statusText: "Unauthorized" });
      const agent = createAgent(openAICompatibleConfig(workspace), "default", { modelFetch: fetcher });
      const runner = new AgentRunner(workspace.context, new SessionStore(workspace.context.dataDir), createDefaultToolRegistry());

      const result = await runner.run(agent, "hello", "http-error");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject({ code: "MODEL_ERROR", message: "Primary provider failed" });
        expect(result.error.message).not.toContain("HTTP 401");
        expect(result.error.message).not.toContain("Bearer");
        expect(result.error.message).not.toContain("super-secret-key");
      }
    } finally {
      if (originalApiKey === undefined) delete process.env.STRONGCODE_TEST_API_KEY;
      else process.env.STRONGCODE_TEST_API_KEY = originalApiKey;
    }
  });

  it("returns a redacted Google provider HTTP failure to the runner caller", async () => {
    // Given
    const workspace = await tempWorkspace();
    const authStore: ProviderAuthReader = {
      async get() {
        return { type: "api", key: "google-test-key" };
      },
      async all() {
        return {};
      }
    };
    const fetcher: NativeProviderFetcher = async () => ({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      async text() {
        return JSON.stringify({ error: { message: "Authorization Bearer google-test-key is invalid" } });
      }
    });
    const agent: Agent = {
      name: "default",
      config: { ...workspace.config.agents.default, tools: [] },
      model: new GoogleGeminiModelProvider({
        providerId: "google",
        providerConfig: {
          type: "google",
          displayName: "Google Gemini",
          apiKeyEnv: "GOOGLE_TEST_API_KEY",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          modelsEndpoint: "/models",
          enabled: true
        },
        modelId: "gemini-test",
        modelConfig: { provider: "google", model: "gemini-test", enabled: true },
        authStore,
        fetcher
      })
    };
    const runner = new AgentRunner(workspace.context, new SessionStore(workspace.context.dataDir), createDefaultToolRegistry());

    // When
    const result = await runner.run(agent, "hello", "google-http-error");

    // Then
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: "MODEL_ERROR",
        message: "Provider google completion failed with HTTP 429: Authorization Bearer [redacted] is invalid"
      });
      expect(result.error.message).not.toContain("google-test-key");
    }
  });
});
