import { describe, expect, it } from "vitest";
import { resolveConfiguredModelRoute } from "../src/agents/model-routing";
import { getPreflightAgentDefinition } from "../src/agents/preflight/roles";
import { resolvePreflightModel } from "../src/agents/preflight/routing";
import type { StrongCodeConfig } from "../src/config/schema";
import { testConfig } from "./helpers";

function configWithModels(models: StrongCodeConfig["models"]): StrongCodeConfig {
  const config = testConfig(process.cwd());
  config.models = models;
  return config;
}

describe("model preference semantic tokens", () => {
  it("keeps fuzzy matching for preferences without required tokens", () => {
    const config = configWithModels({
      fuzzy: { provider: "mock", model: "vendor-gpt-sol-preview", displayName: "Vendor GPT SOL Preview", enabled: true }
    });

    expect(resolveConfiguredModelRoute(config, {
      label: "Generic fuzzy route",
      preferences: [{ label: "GPT SOL", patterns: ["gpt sol"] }],
      allowGenericFallback: false
    })).toMatchObject({ modelId: "fuzzy", provenance: "agent-preference" });
  });

  it.each([
    ["model ID", "DEEPSEEK_v4-FLASH", "tenant-fast"],
    ["configured model value", "flash", "deepseek/v4.flash"]
  ] as const)("collects required tokens from the raw %s", (_source, modelId, model) => {
    const config = configWithModels({
      [modelId]: { provider: "mock", model, displayName: "Tenant Fast", enabled: true }
    });

    expect(resolvePreflightModel(config, "summary")).toMatchObject({
      modelId,
      provenance: "agent-preference",
      preference: "DeepSeek V4 Flash"
    });
  });

  it("copies preflight required-token arrays without aliasing definitions", () => {
    const first = getPreflightAgentDefinition("summary");
    const second = getPreflightAgentDefinition("summary");

    expect(first.modelPreferences[0]?.requiredTokens).toEqual(["deepseek", "v4", "flash"]);
    expect(first.modelPreferences[0]?.requiredTokens).not.toBe(second.modelPreferences[0]?.requiredTokens);
  });
});
