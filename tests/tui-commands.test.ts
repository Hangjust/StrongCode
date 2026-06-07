import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config/load";
import { handleConnectCommand, handleModelCommand, handleProviderCommand } from "../src/tui/commands";
import { DiscoveryFetcher } from "../src/models/discovery";
import { ProviderAuthStore } from "../src/models/auth-store";

function visibleLength(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function expectBounded(output: string, width = 80): void {
  output.split("\n").forEach(line => {
    expect(visibleLength(line)).toBeLessThanOrEqual(width);
  });
}

function expectStrongCodeSurface(output: string): void {
  expect(output).toMatch(/strongcode/i);
}

function expectNoControlSequences(output: string): void {
  // Allow UI control sequences (colors, borders)
  // But disallow malicious ones like OSC 52 (clipboard)
  expect(output).not.toMatch(/\x1b\]52/);
  // Allow ESC (\x1b) but disallow other control characters
  expect(output).not.toMatch(/[\x00-\x09\x0B\x0C\x0E-\x1A\x1C-\x1F\x7F-\x9F]/);
}

async function withEnv(name: string, value: string, run: () => Promise<void>): Promise<void> {
  const original = process.env[name];
  process.env[name] = value;
  try {
    await run();
  } finally {
    if (original === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = original;
    }
  }
}

const baseConfig = `version: 1
workspace: "."
dataDir: ".strongcode"
defaultAgent: default
providers:
  openai:
    type: openai
    displayName: GPT / OpenAI
    apiKeyEnv: OPENAI_API_KEY
    baseUrl: https://api.openai.com/v1
    modelsEndpoint: /models
    enabled: false
  mock:
    type: mock
    displayName: Mock
    enabled: true
  custom:
    type: openai-compatible
    displayName: Custom Provider
    apiKeyEnv: CUSTOM_PROVIDER_API_KEY
    baseUrl: https://example.com/v1
    modelsEndpoint: /models
    enabled: true
agents:
  default:
    model: mock
    tools: []
models:
  mock:
    provider: mock
    model: mock
    enabled: true
permissions:
  tools: {}
`;

async function commandContext() {
  const root = await mkdtemp(path.join(tmpdir(), "strongcode-provider-"));
  const configPath = path.join(root, "strongcode.config.yaml");
  await writeFile(configPath, baseConfig, "utf8");
  const loaded = await loadConfig(configPath);
  if (!loaded.ok) {
    throw loaded.error;
  }

  const state = {
    provider: "mock",
    defaultAgent: "default",
    configPath,
    configMissing: false,
    workspace: ".",
    dataDir: ".strongcode"
  };

  return { configPath, config: loaded.value.config, state, noColor: true, authStore: new ProviderAuthStore(path.join(root, ".strongcode")) };
}

describe("provider tui commands", () => {
  it("renders provider list without secrets", async () => {
    const context = await commandContext();
    context.config.providers.custom.displayName = "Custom Provider With A Very Long Display Name That Must Be Clipped";

    const output = await handleProviderCommand("/provider list", context);

    expect(output).toContain("Custom Provider With");
    expect(output).toContain("env CUSTOM_PROVIDER_API_KEY");
    expect(output).not.toContain("should-not-be-here");
    expectStrongCodeSurface(output);
    expectBounded(output);
  });

  it("renders provider details and custom setup guidance", async () => {
    const context = await commandContext();
    context.config.providers.custom.baseUrl = undefined;

    const details = await handleProviderCommand("/provider", context);
    const guidance = await handleProviderCommand("/provider models custom", context);

    expect(details).toContain("Current provider  mock (Mock)");
    expect(guidance).toContain("providers.custom.baseUrl");
    expect(guidance).not.toContain("CUSTOM_PROVIDER_API_KEY=");
    expectBounded(details);
    expectStrongCodeSurface(details);
  });

  it("renders connect guidance and stores provider auth outside config", async () => {
    const context = await commandContext();

    const guidance = await handleConnectCommand("/connect", context);
    const connected = await handleConnectCommand("/connect custom test-key", context);
    const authFile = await readFile(context.authStore.filePath, "utf8");

    expect(guidance).toContain("/connect <provider-id> <api-key>");
    expect(guidance).toContain("/connect openai chatgpt-browser");
    expect(connected).toContain("Connected custom; credentials saved in auth.json");
    expect(authFile).toContain("test-key");
    expect(context.config.providers.custom.enabled).toBe(true);
    expect(JSON.stringify(context.config)).not.toContain("test-key");
    expectBounded([guidance, connected].join("\n"));
  });

  it("keeps custom connect guidance API-key only and shows ChatGPT methods for OpenAI", async () => {
    const context = await commandContext();

    const customGuidance = await handleConnectCommand("/connect custom", context);
    const openaiGuidance = await handleConnectCommand("/connect openai", context);
    const unsupportedAuthArgument = await handleConnectCommand(`/connect custom ${["o", "auth"].join("")}`, context);

    expect(customGuidance).toContain("Auth methods: api_key");
    expect(customGuidance).not.toMatch(/oauth/i);
    expect(openaiGuidance).toContain("Auth methods: api_key, oauth");
    expect(openaiGuidance).toContain("chatgpt-browser");
    expect(unsupportedAuthArgument).toBe("Usage: /connect custom <api-key>.");
    expect(unsupportedAuthArgument).not.toMatch(/oauth/i);
  });

  it("starts ChatGPT browser OAuth through the connect command without leaking verifier state", async () => {
    const context = await commandContext();

    const output = await handleConnectCommand("/connect openai chatgpt-browser", {
      ...context,
      oauthOptions: {
        openUrl: async () => false,
        callbackTimeoutMs: 10
      }
    });

    expect(output).toContain("Started ChatGPT browser login for openai");
    expect(output).toContain("https://auth.openai.com/oauth/authorize");
    expect(output).not.toContain("code_verifier");
    expect(output).not.toContain("refresh");
    expectBounded(output);
  });

  it("starts ChatGPT headless OAuth through the connect command with a device code", async () => {
    const context = await commandContext();

    const output = await handleConnectCommand("/connect openai chatgpt-headless", {
      ...context,
      oauthOptions: {
        callbackTimeoutMs: 0,
        fetcher: async () => ({
          ok: true,
          status: 200,
          async json() {
            return { device_auth_id: "device-123", user_code: "ABCD-EFGH", interval: "1" };
          }
        })
      }
    });

    expect(output).toContain("Started ChatGPT headless login for openai");
    expect(output).toContain("Enter code: ABCD-EFGH");
    expect(output).toContain("https://auth.openai.com/codex/device");
    expect(output).not.toContain("device-123");
    expectBounded(output);
  });

  it("removes provider auth", async () => {
    const context = await commandContext();

    await handleConnectCommand("/connect custom test-key", context);
    const removed = await handleConnectCommand("/connect remove custom", context);

    expect(removed).toContain("Removed auth for custom");
    expect(await context.authStore.all()).toEqual({});
  });

  it("discovers custom models and enables a selected model", async () => {
    await withEnv("CUSTOM_PROVIDER_API_KEY", "test-key", async () => {
      const context = await commandContext();
      const fetcher: DiscoveryFetcher = async () => ({
        ok: true,
        status: 200,
        async json() {
          return { data: [{ id: "custom-model" }] };
        }
      });

      const commandContextWithFetcher = { ...context, discoverFetcher: fetcher };
      const discovered = await handleProviderCommand("/provider models custom", commandContextWithFetcher);
      expect(discovered).toContain("custom-model");
      expectBounded(discovered);

      const enabled = await handleProviderCommand("/provider enable model custom-model", commandContextWithFetcher);
      expect(enabled).toContain("Enabled model custom-model");
    });
  });

  it("uses auth storage for provider model discovery", async () => {
    const context = await commandContext();
    await handleConnectCommand("/connect custom stored-key", context);
    const fetcher: DiscoveryFetcher = async (_url, init) => ({
      ok: true,
      status: 200,
      async json() {
        expect(init.headers).toEqual({ Authorization: "Bearer stored-key" });
        return { data: [{ id: "custom-auth-model" }] };
      }
    });

    const discovered = await handleProviderCommand("/provider models custom", { ...context, discoverFetcher: fetcher });

    expect(discovered).toContain("custom-auth-model");
  });

  it("preserves enabled model state when rediscovering", async () => {
    await withEnv("CUSTOM_PROVIDER_API_KEY", "test-key", async () => {
      const context = await commandContext();
      context.config.models["custom-model"] = {
        provider: "custom",
        model: "custom-model",
        enabled: true,
        displayName: "Keep Enabled",
        source: "discovered",
        options: { temperature: 0 }
      };
      const fetcher: DiscoveryFetcher = async () => ({
        ok: true,
        status: 200,
        async json() {
          return { data: [{ id: "custom-model" }] };
        }
      });

      await handleProviderCommand("/provider models custom", { ...context, discoverFetcher: fetcher });

      expect(context.config.models["custom-model"]?.enabled).toBe(true);
      expect(context.config.models["custom-model"]?.displayName).toBe("Keep Enabled");
      expect(context.config.models["custom-model"]?.options).toEqual({ temperature: 0 });
    });
  });

  it("configures the custom OpenAI-compatible provider safely", async () => {
    const context = await commandContext();
    context.config.providers.custom.baseUrl = undefined;
    context.config.providers.custom.apiKeyEnv = undefined;

    const configured = await handleProviderCommand("/provider configure custom http://localhost:11434/v1 LOCAL_MODEL_API_KEY", context);

    expect(configured).toContain("Configured custom provider with LOCAL_MODEL_API_KEY");
    expect(context.config.providers.custom.type).toBe("openai-compatible");
    expect(context.config.providers.custom.baseUrl).toBe("http://localhost:11434/v1");
    expect(context.config.providers.custom.apiKeyEnv).toBe("LOCAL_MODEL_API_KEY");
    expect(configured).not.toContain("=");
    expectBounded(configured);
  });

  it("rejects unsafe custom provider configure inputs", async () => {
    const context = await commandContext();

    const invalidEnv = await handleProviderCommand("/provider configure custom https://example.com/v1 AWS_SECRET_ACCESS_KEY", context);
    const invalidUrl = await handleProviderCommand("/provider configure custom http://example.com/v1 CUSTOM_PROVIDER_API_KEY", context);

    expect(invalidEnv).toContain("Invalid api-key-env");
    expect(invalidUrl).toContain("https unless it points to localhost");
    expect(context.config.providers.custom.baseUrl).toBe("https://example.com/v1");
    expectBounded([invalidEnv, invalidUrl].join("\n"));
  });

  it("discovers models for any OpenAI-compatible provider", async () => {
    await withEnv("OPENAI_API_KEY", "test-key", async () => {
      const context = await commandContext();
      context.config.providers.openai = {
        type: "openai",
        displayName: "GPT / OpenAI",
        apiKeyEnv: "OPENAI_API_KEY",
        baseUrl: "https://api.openai.test/v1",
        modelsEndpoint: "/models",
        enabled: false
      };
      const fetcher: DiscoveryFetcher = async (url, init) => ({
        ok: true,
        status: 200,
        async json() {
          expect(url).toBe("https://api.openai.test/v1/models");
          expect(init.headers).toEqual({ Authorization: "Bearer test-key" });
          return { data: [{ id: "gpt-test" }] };
        }
      });

      const contextWithFetcher = { ...context, discoverFetcher: fetcher };
      const discovered = await handleProviderCommand("/provider models openai", contextWithFetcher);

      expect(discovered).toContain("gpt-test");
      expect(contextWithFetcher.config.models["gpt-test"]?.provider).toBe("openai");
      expect(contextWithFetcher.config.models["gpt-test"]?.enabled).toBe(false);
      expectBounded(discovered);
    });
  });

  it("selects an enabled provider model", async () => {
    const context = await commandContext();
    context.config.models["custom-model"] = {
      provider: "custom",
      model: "custom-model",
      enabled: true,
      displayName: "Custom Model",
      source: "manual",
      options: undefined
    };

    const selected = await handleProviderCommand("/provider select custom", context);

    expect(selected).toContain("Selected custom using model custom-model");
    expect(context.config.agents.default.model).toBe("custom-model");
  });

  it("gives actionable guidance when provider selection has no enabled model", async () => {
    const context = await commandContext();

    const output = await handleProviderCommand("/provider select custom", context);

    expect(output).toContain("No enabled model for custom");
    expect(output).toContain("/provider enable model <model-id>");
    expectBounded(output);
  });

  it("selects a provider with shorthand syntax", async () => {
    const context = await commandContext();
    context.config.models["custom-model"] = {
      provider: "custom",
      model: "custom-model",
      enabled: true,
      displayName: "Custom Model",
      source: "manual",
      options: undefined
    };

    const selected = await handleProviderCommand("/provider custom", context);

    expect(selected).toContain("Selected custom using model custom-model");
    expect(context.config.agents.default.model).toBe("custom-model");
  });

  it("lists and selects models with the model command", async () => {
    const context = await commandContext();
    context.config.models["custom-model"] = {
      provider: "custom",
      model: "custom-model",
      enabled: false,
      displayName: "Custom Model",
      source: "manual",
      options: undefined
    };

    context.state.provider = "custom";
    const list = await handleModelCommand("/model", context);
    const selected = await handleModelCommand("/model custom-model", context);

    expect(list).toContain("custom-model");
    expect(selected).toContain("Selected model custom-model using provider custom");
    expect(context.config.agents.default.model).toBe("custom-model");
    expect(context.config.models["custom-model"]?.enabled).toBe(true);
    expect(context.config.providers.custom.enabled).toBe(true);
    expect(context.config.providers.mock.enabled).toBe(false);
  });

  it("bounds provider panels with long model and provider names", async () => {
    const context = await commandContext();
    const longModelId = "custom-model-with-a-very-long-name-that-should-be-clipped-in-panels-and-lists";
    context.config.agents.default.model = longModelId;
    context.config.models[longModelId] = {
      provider: "mock",
      model: longModelId,
      enabled: true,
      displayName: "Custom Model",
      source: "manual",
      options: undefined
    };
    context.config.providers.custom.displayName = "Custom Provider With A Very Long Display Name That Must Be Clipped";

    const details = await handleProviderCommand("/provider", context);
    const models = await handleProviderCommand("/provider models mock", context);

    expect(details).toContain("Current provider  mock (Mock)");
    expect(models).toContain("custom-model-with-a-very-long-name");
    expectBounded(details);
    expectBounded(models);
    expectStrongCodeSurface(details);
    expectStrongCodeSurface(models);
  });

  it("strips terminal control sequences from provider and model display values", async () => {
    const context = await commandContext();
    const maliciousModelId = "custom-model\u001b]52;c;clipboard\u0007\u001b[31mred";
    context.config.providers.mock.displayName = "Mock\u001b[2JProvider";
    context.config.providers.mock.apiKeyEnv = "MOCK_KEY\u001b[?25l";
    context.config.models[maliciousModelId] = {
      provider: "mock",
      model: maliciousModelId,
      enabled: true,
      displayName: "Malicious Model",
      source: "manual",
      options: undefined
    };
    context.config.agents.default.model = maliciousModelId;

    const details = await handleProviderCommand("/provider", context);
    const list = await handleProviderCommand("/provider list", context);
    const models = await handleProviderCommand("/provider models mock", context);

    const output = [details, list, models].join("\n");
    expect(output).toContain("MockProvider");
    expect(output).toContain("custom-modelred");
    expect(output).not.toContain("clipboard");
    expectNoControlSequences(output);
    expectBounded(output);
  });

  it("sanitizes dynamic provider command response text", async () => {
    const context = await commandContext();
    const maliciousModelId = "custom-model\u001b]52;c;clipboard\u0007\u001b[31mred";
    context.config.models[maliciousModelId] = {
      provider: "custom",
      model: maliciousModelId,
      enabled: true,
      displayName: "Custom Model",
      source: "manual",
      options: undefined
    };

    const selected = await handleProviderCommand("/provider select custom", context);
    const enabled = await handleProviderCommand(`/provider enable model ${maliciousModelId}`, context);
    const unknownProvider = await handleProviderCommand("/provider select bad\u001b]52;c;steal\u0007\u001b[31mred", context);
    const unknownModel = await handleProviderCommand("/provider enable model bad\u001b]52;c;steal\u0007\u001b[31mred", context);

    const output = [selected, enabled, unknownProvider, unknownModel].join("\n");
    expect(output).toContain("Selected custom using model custom-modelred.");
    expect(output).toContain("Enabled model custom-modelred.");
    expect(output).toContain("Unknown provider: badred");
    expect(output).toContain("Unknown model: badred");
    expect(output).not.toContain("clipboard");
    expect(output).not.toContain("steal");
    expectNoControlSequences(output);
    expectBounded(output);
  });

  it("sanitizes discovery error output", async () => {
    await withEnv("CUSTOM_PROVIDER_API_KEY", "test-key", async () => {
      const context = await commandContext();
      const fetcher: DiscoveryFetcher = async () => {
        throw new Error("boom\u001b]52;c;steal\u0007\u001b[31mred " + "x".repeat(120));
      };

      const output = await handleProviderCommand("/provider models custom", { ...context, discoverFetcher: fetcher });

      expect(output).toContain("Discovery failed: boomred");
      expect(output).not.toContain("steal");
      expectNoControlSequences(output);
      expectBounded(output);
    });
  });
});
