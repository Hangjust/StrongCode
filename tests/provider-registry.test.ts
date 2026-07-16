import { orderedProviders, providerDefaults } from "../src/models/registry";
import { createProviderCatalog } from "../src/models/catalog";
import { ProviderAuthStore } from "../src/models/auth-store";
import { ProviderService } from "../src/models/provider-service";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

describe("provider registry", () => {
  it("orders preferred providers first", () => {
    const ordered = orderedProviders(providerDefaults()).map(provider => provider.id);

    expect(ordered.slice(0, 4)).toEqual(["openai", "kimi", "anthropic", "grok"]);
    expect(ordered).toContain("custom");
  });

  it("builds a provider catalog with auth, models, capabilities, and runtime support", () => {
    const providers = providerDefaults();
    const catalog = createProviderCatalog({
      version: 1 as const,
      workspace: ".",
      dataDir: ".strongcode",
      defaultAgent: "default",
      providers,
      agents: { default: { model: "mock", tools: [] } },
      models: {
        mock: { provider: "mock", model: "mock", displayName: undefined, enabled: true, source: undefined, options: undefined },
        "custom-model": { provider: "custom", model: "custom-model", displayName: undefined, enabled: false, source: "discovered", options: undefined }
      },
      permissions: { tools: {} }
    }, {
      custom: { type: "api", key: "stored-key" }
    });

    const custom = catalog.all.find(provider => provider.id === "custom");
    const anthropic = catalog.all.find(provider => provider.id === "anthropic");

    expect(catalog.defaultProvider).toBe("mock");
    expect(catalog.connected).toContain("custom");
    expect(custom?.authMethods).toEqual(["api_key"]);
    expect(custom?.models.map(model => model.id)).toEqual(["custom-model"]);
    expect(custom?.modelCapabilities["custom-model"]).toEqual(["chat"]);
    expect(custom?.runtimeSupport).toBe("supported");
    expect(anthropic?.runtimeSupport).toBe("supported");
  });

  it("exposes OpenCode-style provider auth methods with API-key fallback", async () => {
    const providers = providerDefaults();
    const config = {
      version: 1 as const,
      workspace: ".",
      dataDir: ".strongcode",
      defaultAgent: "default",
      providers,
      agents: { default: { model: "mock", tools: [] } },
      models: { mock: { provider: "mock", model: "mock", displayName: undefined, enabled: true, source: undefined, options: undefined } },
      permissions: { tools: {} }
    };
    const dataDir = await mkdtemp(path.join(tmpdir(), "strongcode-provider-methods-"));

    const service = new ProviderService(config, new ProviderAuthStore(dataDir));

    expect(service.authMethods().openai).toEqual([{ type: "api", label: "API key" }]);
    expect(service.authMethods().chatgpt).toEqual([
      { id: "browser", type: "oauth", label: "ChatGPT browser login" },
      { id: "device-code", type: "oauth", label: "ChatGPT headless/device-code login" }
    ]);
    expect(service.authMethods().custom).toEqual([{ type: "api", label: "API key" }]);
    expect(service.authMethods().mock).toBeUndefined();
  });

  it("keeps OpenAI API auth separate from native ChatGPT OAuth", () => {
    const providers = providerDefaults();
    const catalog = createProviderCatalog({
      version: 1 as const,
      workspace: ".",
      dataDir: ".strongcode",
      defaultAgent: "default",
      providers,
      agents: { default: { model: "mock", tools: [] } },
      models: { mock: { provider: "mock", model: "mock", displayName: undefined, enabled: true, source: undefined, options: undefined } },
      permissions: { tools: {} }
    }, {
      chatgpt: { type: "oauth", access: "chatgpt-access", refresh: "chatgpt-refresh" }
    });

    const openai = catalog.all.find(provider => provider.id === "openai");
    const chatgpt = catalog.all.find(provider => provider.id === "chatgpt");

    expect(openai?.connected).toBe(false);
    expect(openai?.authMethods).toEqual(["api_key"]);
    expect(chatgpt?.connected).toBe(true);
    expect(chatgpt?.authMethods).toEqual(["oauth"]);
    expect(catalog.connected).toContain("chatgpt");
  });
});
