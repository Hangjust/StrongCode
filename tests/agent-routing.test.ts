import { describe, expect, it } from "vitest";
import type { StrongCodeConfig } from "../src/config/schema";
import { getAgentDefinition } from "../src/agents/registry";
import { resolveAgentModel, resolveAgentModelSet } from "../src/agents/model-routing";
import { resolvePreflightModel } from "../src/agents/preflight/routing";
import { modelReferenceSchema } from "../src/agents/preflight/text";
import { selectModel } from "../src/config/save";
import { testConfig } from "./helpers";

function routingConfig(): StrongCodeConfig {
  const config = testConfig(process.cwd());
  config.providers = {
    ...config.providers,
    openai: { ...config.providers.openai, enabled: true },
    anthropic: { ...config.providers.anthropic, enabled: true },
    google: { ...config.providers.google, enabled: true },
    grok: { ...config.providers.grok, enabled: true }
  };
  config.models = {
    mock: config.models.mock,
    sol: { provider: "openai", model: "gpt-5.6-sol", displayName: "GPT 5.6 SOL", enabled: true },
    terra: { provider: "openai", model: "gpt-5.6-terra", displayName: "GPT 5.6 Terra", enabled: true },
    gemini: { provider: "google", model: "gemini-3.1-pro-preview", displayName: "Gemini 3.1 Pro Preview", enabled: true },
    opus48: { provider: "anthropic", model: "claude-opus-4.8", displayName: "Claude Opus 4.8", enabled: true },
    opus46: { provider: "anthropic", model: "claude-opus-4.6-max", displayName: "Claude Opus 4.6 Max", enabled: true },
    grok: { provider: "grok", model: "grok-build", displayName: "Grok Build", enabled: true }
  };
  return config;
}

function requiredAgentDefinition(name: string) {
  const definition = getAgentDefinition(name);
  if (!definition) throw new Error(`Missing test agent definition: ${name}`);
  return definition;
}

describe("agent model routing", () => {
  it("uses each role's ordered preference chain", () => {
    const config = routingConfig();
    expect(resolveAgentModel(config, requiredAgentDefinition("tesla")).modelId).toBe("sol");
    expect(resolveAgentModel(config, requiredAgentDefinition("hood")).modelId).toBe("gemini");
    expect(resolveAgentModel(config, requiredAgentDefinition("meta")).modelId).toBe("opus48");
  });

  it("honors an explicit runnable override before built-in preferences", () => {
    const config = routingConfig();
    config.agents.tesla = { model: "terra", tools: [] };
    expect(resolveAgentModel(config, requiredAgentDefinition("sisyphus"))).toMatchObject({
      modelId: "terra",
      provenance: "agent-override"
    });
  });

  it("skips disabled or unconnected preferred providers and falls back safely", () => {
    const config = routingConfig();
    config.models.sol.enabled = false;
    expect(resolveAgentModel(config, requiredAgentDefinition("tesla")).modelId).toBe("terra");
    expect(resolveAgentModel(config, requiredAgentDefinition("meta"), { connectedProviderIds: ["openai"] })).toMatchObject({
      modelId: "mock",
      provenance: "configured-default"
    });
  });

  it("requires four distinct available models for Hood Research Department", () => {
    const config = routingConfig();
    const hood = requiredAgentDefinition("hood");
    const panel = resolveAgentModelSet(config, hood);
    expect(panel).toHaveLength(5);
    expect(new Set(panel.map(model => model.modelId)).size).toBe(panel.length);

    const tooSmall = testConfig(process.cwd());
    expect(() => resolveAgentModelSet(tooSmall, hood)).toThrow("requires at least 4 distinct enabled models");
  });

  it("falls back to the configured model when future preferred names are unavailable", () => {
    const config = testConfig(process.cwd());
    expect(resolveAgentModel(config, requiredAgentDefinition("newton"))).toMatchObject({
      modelId: "mock",
      provenance: "configured-default"
    });
  });

  it("stores a model choice for the active built-in without disabling other providers", () => {
    const config = routingConfig();
    const updated = selectModel(config, "opus48", "newton");
    expect(updated.agents.newton.model).toBe("opus48");
    expect(updated.providers.anthropic.enabled).toBe(true);
    expect(updated.providers.openai.enabled).toBe(true);
    expect(resolveAgentModel(updated, requiredAgentDefinition("newton"))).toMatchObject({ modelId: "opus48", provenance: "agent-override" });
  });

  it("prefers configured DeepSeek V4 Flash then Gemma for hidden runtime roles", () => {
    const config = routingConfig();
    config.models.flash = { provider: "openai", model: "tenant-cheap-a", displayName: "DeepSeek V4 Flash", enabled: true };
    config.models.gemma = { provider: "google", model: "tenant-cheap-b", displayName: "Gemma 4 Fast", enabled: true };

    expect(resolvePreflightModel(config, "summary")).toMatchObject({
      modelId: "flash",
      provenance: "agent-preference",
      preference: "DeepSeek V4 Flash"
    });

    config.models.flash.enabled = false;
    expect(resolvePreflightModel(config, "analysis")).toMatchObject({
      modelId: "gemma",
      provenance: "agent-preference",
      preference: "Gemma"
    });
  });

  it.each([
    "DeepSeek V4",
    "NotDeepSeek V4 Flash",
    "DeepSeek V4 Flashlight",
    "Acme V4 Flash",
    "Nova V4 Flash",
    "Deep Search V4 Flash"
  ])(
    "does not treat unrelated %s as DeepSeek V4 Flash",
    displayName => {
      const config = routingConfig();
      config.models = {
        primary: { provider: "openai", model: "tenant-primary", displayName: "Primary GPT", enabled: true },
        nearMatch: { provider: "openai", model: "tenant-near-match", displayName, enabled: true },
        gemma: { provider: "google", model: "gemma-4-fast", displayName: "Gemma 4 Fast", enabled: true }
      };
      config.agents[config.defaultAgent].model = "primary";

      expect(resolvePreflightModel(config, "summary")).toMatchObject({
        modelId: "gemma",
        provenance: "agent-preference",
        preference: "Gemma"
      });
    }
  );

  it("matches V4 Flash when the configured provider is DeepSeek", () => {
    const config = routingConfig();
    config.providers.deepseek = {
      type: "openai-compatible",
      displayName: "DeepSeek",
      enabled: true
    };
    config.models = {
      flash: { provider: "deepseek", model: "V4 Flash", displayName: "V4 Flash", enabled: true }
    };

    expect(resolvePreflightModel(config, "summary")).toMatchObject({
      modelId: "flash",
      provenance: "agent-preference",
      preference: "DeepSeek V4 Flash"
    });
  });

  it.each(["DeepSeek V4 Flash", "DEEPSEEK_v4-FLASH", "deepseek/v4.flash"])(
    "matches a custom-provider model identified as %s",
    displayName => {
      const config = routingConfig();
      config.providers.custom = {
        type: "openai-compatible",
        displayName: "Custom",
        enabled: true
      };
      config.models = {
        flash: { provider: "custom", model: "tenant-fast", displayName, enabled: true }
      };

      expect(resolvePreflightModel(config, "explorer")).toMatchObject({
        modelId: "flash",
        provenance: "agent-preference",
        preference: "DeepSeek V4 Flash"
      });
    }
  );

  it("replaces hidden role defaults with arbitrary configured route references", () => {
    const config = routingConfig();
    config.preflight = {
      enabled: true,
      summary: { model: modelReferenceSchema.parse("opus48"), fallbackModels: [modelReferenceSchema.parse("terra")] },
      analysis: { model: modelReferenceSchema.parse("grok"), fallbackModels: [] },
      explorer: { model: modelReferenceSchema.parse("gemini"), fallbackModels: [] }
    };

    expect(resolvePreflightModel(config, "summary")).toMatchObject({ modelId: "opus48", provenance: "agent-override" });
    expect(resolvePreflightModel(config, "analysis")).toMatchObject({ modelId: "grok", provenance: "agent-override" });
    expect(resolvePreflightModel(config, "explorer")).toMatchObject({ modelId: "gemini", provenance: "agent-override" });
  });

  it("applies connected-provider filtering before hidden route fallbacks", () => {
    const config = routingConfig();
    config.preflight = {
      enabled: true,
      summary: {
        model: modelReferenceSchema.parse("opus48"),
        fallbackModels: [modelReferenceSchema.parse("terra")]
      }
    };

    expect(resolvePreflightModel(config, "summary", { connectedProviderIds: ["openai"] })).toMatchObject({
      modelId: "terra",
      provenance: "user-fallback"
    });
  });

  it("leaves a hidden role unavailable when only an unrelated primary model exists", () => {
    const config = routingConfig();
    config.models = {
      primary: { provider: "openai", model: "tenant-primary", displayName: "Primary GPT", enabled: true }
    };
    config.agents[config.defaultAgent].model = "primary";

    expect(() => resolvePreflightModel(config, "summary")).toThrowError(expect.objectContaining({ code: "MODEL_ERROR" }));
  });

  it("uses an explicit hidden fallback when the explicit model is unavailable", () => {
    const config = routingConfig();
    config.models.opus48.enabled = false;
    config.preflight = {
      enabled: true,
      summary: {
        model: modelReferenceSchema.parse("opus48"),
        fallbackModels: [modelReferenceSchema.parse("terra")]
      }
    };

    expect(resolvePreflightModel(config, "summary")).toMatchObject({
      modelId: "terra",
      provenance: "user-fallback"
    });
  });

  it("does not replace an exhausted explicit route with preferences or generic defaults", () => {
    const config = routingConfig();
    config.models.opus48.enabled = false;
    config.models.terra.enabled = false;
    config.models.flash = { provider: "openai", model: "tenant-flash", displayName: "DeepSeek V4 Flash", enabled: true };
    config.preflight = {
      enabled: true,
      summary: {
        model: modelReferenceSchema.parse("opus48"),
        fallbackModels: [modelReferenceSchema.parse("terra")]
      }
    };

    expect(() => resolvePreflightModel(config, "summary")).toThrowError(expect.objectContaining({ code: "MODEL_ERROR" }));
  });

  it("keeps hidden route exhaustion typed for later automatic fail-open", () => {
    const config = routingConfig();
    for (const model of Object.values(config.models)) model.enabled = false;

    expect(() => resolvePreflightModel(config, "summary")).toThrowError(expect.objectContaining({ code: "MODEL_ERROR" }));
  });
});
