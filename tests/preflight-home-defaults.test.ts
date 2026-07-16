import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import { ensureStrongCodeHome } from "../src/config/home";
import { loadConfig } from "../src/config/load";
import { strongCodeConfigSchema } from "../src/config/schema";
import { globalConfigPath } from "../src/setup/config";
import { withGeneratedPreflightDefaults } from "../src/setup/preflight-defaults";
import { runSetup } from "../src/setup/wizard";
import { effectiveConfiguredTools } from "../src/tools/capability-policy";
import { PreflightSetupPrompter } from "./fixtures/preflight-setup-prompter";

const SECRET_SENTINEL = "sk-task-10-secret";
const SAFE_TOOLS = ["list_files", "read_file", "find_files", "ripgrep", "web_search"];

async function setupWithModel(provider: "deepseek" | "google" | "openai", modelId: string) {
  const homePath = await mkdtemp(path.join(tmpdir(), `strongcode-preflight-${provider}-`));
  const prompter = new PreflightSetupPrompter();
  prompter.multiselections.push([provider]);
  prompter.selections.push(...(provider === "google" ? ["api-key", "enter"] : provider === "openai" ? ["api-key", "enter"] : ["enter"]), "no");
  prompter.secrets.push(SECRET_SENTINEL);
  prompter.confirmations.push(false, false);
  const result = await runSetup({}, {
    homePath,
    prompter,
    interactive: false,
    discovery: {
      fetcher: async () => new Response(JSON.stringify(provider === "google"
        ? { models: [{ name: `models/${modelId}`, displayName: modelId }] }
        : { data: [{ id: modelId, displayName: modelId }] }), { status: 200 })
    }
  });
  const loaded = await loadConfig(globalConfigPath(homePath));
  if (!loaded.ok) throw loaded.error;
  return { config: loaded.value.config, homePath, resultConfig: result.config };
}

function arbitraryConfig() {
  return {
    version: 1,
    workspace: ".",
    dataDir: ".strongcode",
    defaultAgent: "tesla",
    providers: { tenant: { type: "openai-compatible", displayName: "Tenant", enabled: true } },
    agents: { tesla: { model: "primary", tools: ["write_file"] } },
    models: {
      primary: { provider: "tenant", model: "tenant-primary", enabled: true },
      summary: { provider: "tenant", model: "tenant-summary", enabled: true },
      analysis: { provider: "tenant", model: "tenant-analysis", enabled: true },
      explorer: { provider: "tenant", model: "tenant-explorer", enabled: true }
    },
    permissions: { tools: { write_file: "allow" } }
  };
}

describe("generated preflight defaults", () => {
  it("writes discovered DeepSeek V4 Flash to every optional hidden route", async () => {
    const { config, homePath, resultConfig } = await setupWithModel("deepseek", "deepseek-v4-flash");

    expect(config.preflight).toEqual({
      enabled: true,
      summary: { model: "deepseek-v4-flash", fallbackModels: [], tools: SAFE_TOOLS },
      analysis: { model: "deepseek-v4-flash", fallbackModels: [], tools: SAFE_TOOLS },
      explorer: { model: "deepseek-v4-flash", fallbackModels: [], tools: SAFE_TOOLS }
    });
    expect(resultConfig?.preflight).toEqual(config.preflight);
    for (const file of ["strongcode.config.yaml", "agents.json", "providers.json", "models.json", "README.md"]) {
      expect(await readFile(path.join(homePath, file), "utf8")).not.toContain(SECRET_SENTINEL);
    }
  });

  it("falls back to discovered Gemma when Flash is unavailable", async () => {
    const { config } = await setupWithModel("google", "gemma-4-it");

    expect(config.preflight?.summary.model).toBe("gemma-4-it");
    expect(config.preflight?.analysis?.model).toBe("gemma-4-it");
    expect(config.preflight?.explorer?.model).toBe("gemma-4-it");
  });

  it("leaves hidden routes unset when no eligible model was discovered", async () => {
    const { config } = await setupWithModel("openai", "gpt-primary");

    expect(config.preflight).toBeUndefined();
  });

  it.each(["NotGemma", "Gemmatic Pro", "Acme Gemmaish"])(
    "does not generate hidden routes for the non-Gemma identity %s",
    displayName => {
      const input = arbitraryConfig();
      const config = strongCodeConfigSchema.parse({
        ...input,
        models: {
          ...input.models,
          candidate: { provider: "tenant", model: "tenant-candidate", displayName, enabled: true }
        }
      });

      expect(withGeneratedPreflightDefaults(config).preflight).toBeUndefined();
    }
  );

  it("accepts arbitrary configured replacements while rejecting broadening fields", () => {
    const input = arbitraryConfig();
    const configured = strongCodeConfigSchema.parse({
      ...input,
      preflight: {
        enabled: true,
        summary: { model: "summary", tools: ["read_file", "write_file"] },
        analysis: { model: "analysis" },
        explorer: { model: "explorer" }
      }
    });

    expect(configured.preflight?.summary.model).toBe("summary");
    expect(configured.preflight?.analysis?.model).toBe("analysis");
    expect(configured.preflight?.explorer?.model).toBe("explorer");
    expect(effectiveConfiguredTools("summary", configured.preflight?.summary.tools ?? [])).toEqual(["read_file"]);
    for (const preflight of [
      { enabled: true, summary: { model: "summary", mode: "primary" } },
      { enabled: true, summary: { model: "summary" }, maxConcurrentChildren: 26 },
      { enabled: true, summary: { model: "summary", tools: Array.from({ length: 129 }, (_, index) => `read_${index}`) } }
    ]) {
      expect(strongCodeConfigSchema.safeParse({ ...input, preflight }).success).toBe(false);
    }
  });

  it("adds only routes without changing an unrelated primary or provider selection", () => {
    const input = arbitraryConfig();
    const config = strongCodeConfigSchema.parse({
      ...input,
      models: {
        ...input.models,
        flash: { provider: "tenant", model: "tenant-flash", displayName: "DeepSeek V4 Flash", enabled: true }
      }
    });

    const generated = withGeneratedPreflightDefaults(config);

    expect(generated.agents.tesla.model).toBe("primary");
    expect(generated.providers).toEqual(config.providers);
    expect(generated.preflight?.summary.model).toBe("flash");
  });

  it("keeps customized starter files byte-identical during monotonic bootstrap", async () => {
    const homePath = await mkdtemp(path.join(tmpdir(), "strongcode-preflight-custom-"));
    const configPath = globalConfigPath(homePath);
    const readmePath = path.join(homePath, "README.md");
    const customConfig = "custom: config bytes\n";
    const customReadme = "# Custom operator notes\n";
    await writeFile(configPath, customConfig, "utf8");
    await writeFile(readmePath, customReadme, "utf8");

    await ensureStrongCodeHome({ homePath });

    expect(await readFile(configPath, "utf8")).toBe(customConfig);
    expect(await readFile(readmePath, "utf8")).toBe(customReadme);
  });
});

describe("preflight operator artifacts", () => {
  it("keeps the published example valid and documents every host-owned guarantee", async () => {
    const example = await readFile(path.join(process.cwd(), "strongcode.config.example.yaml"), "utf8");
    const readme = await readFile(path.join(process.cwd(), "README.md"), "utf8");
    const homePath = await mkdtemp(path.join(tmpdir(), "strongcode-preflight-docs-"));
    await ensureStrongCodeHome({ homePath });
    const generatedReadme = await readFile(path.join(homePath, "README.md"), "utf8");

    expect(() => strongCodeConfigSchema.parse(YAML.parse(example))).not.toThrow();
    for (const phrase of [
      "first meaningful prompt", "title", "general summary", "requested items", "0-25", "depth-one",
      "25 concurrent", "90 seconds", "30 seconds", "5-second finalizer reserve", "read/search/read-only-web",
      "shell", "worker", "recursive", "unclassified MCP", "failed-open", "cancellation",
      "provider-reported", "exact original prompt"
    ]) {
      expect(readme.toLowerCase()).toContain(phrase.toLowerCase());
    }
    expect(example).toContain("preflight:");
    expect(generatedReadme.toLowerCase()).toContain("preflight");
    expect(generatedReadme).toContain("strongcode.config.yaml");
    expect(readme).toContain("host-owned and cannot be configured");
    expect(readme).not.toContain("Configuration may narrow these limits");
    expect(example).not.toContain(SECRET_SENTINEL);
  });
});
