import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config/load";

async function writeBaseConfig(root: string): Promise<string> {
  const configPath = path.join(root, "strongcode.config.yaml");
  await writeFile(configPath, `version: 1
workspace: "."
dataDir: ".strongcode"
defaultAgent: default
providers:
  mock:
    type: mock
    displayName: Mock
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
`, "utf8");
  return configPath;
}

describe("JSON model catalog", () => {
  it("loads OpenCode-style provider models from the editable data-dir catalog", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-model-catalog-"));
    const configPath = await writeBaseConfig(root);
    await mkdir(path.join(root, ".strongcode"));
    await writeFile(path.join(root, ".strongcode", "models.json"), JSON.stringify({
      providers: {
        openai: {
          name: "GPT / OpenAI",
          env: ["OPENAI_API_KEY"],
          api: "https://api.openai.com/v1",
          models: {
            "gpt-4.1": { name: "GPT-4.1", id: "gpt-4.1" },
            "gpt-5.5": { name: "GPT-5.5", id: "gpt-5.5" }
          }
        },
        kimi: {
          name: "Kimi",
          env: ["MOONSHOT_API_KEY"],
          api: "https://api.moonshot.ai/v1",
          models: {
            "kimi-k2": { name: "Kimi K2", id: "kimi-k2" }
          }
        }
      }
    }), "utf8");

    const loaded = await loadConfig(configPath);

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.config.providers.openai).toMatchObject({ type: "openai", displayName: "GPT / OpenAI", apiKeyEnv: "OPENAI_API_KEY", baseUrl: "https://api.openai.com/v1" });
    expect(loaded.value.config.models["gpt-4.1"]).toMatchObject({ provider: "openai", model: "gpt-4.1", displayName: "GPT-4.1", enabled: true, source: "catalog" });
    expect(loaded.value.config.models["gpt-5.5"]).toMatchObject({ provider: "openai", model: "gpt-5.5", displayName: "GPT-5.5", enabled: true, source: "catalog" });
    expect(loaded.value.config.models["kimi-k2"]).toMatchObject({ provider: "kimi", model: "kimi-k2", displayName: "Kimi K2", enabled: true, source: "catalog" });
  });

  it("loads StrongCode flat catalog models without storing secrets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-flat-model-catalog-"));
    const configPath = await writeBaseConfig(root);
    await mkdir(path.join(root, ".strongcode"));
    await writeFile(path.join(root, ".strongcode", "models.json"), JSON.stringify({
      providers: {
        grok: {
          type: "openai-compatible",
          displayName: "Grok",
          apiKeyEnv: "XAI_API_KEY",
          baseUrl: "https://api.x.ai/v1",
          modelsEndpoint: "/models",
          enabled: true
        }
      },
      models: {
        "grok-code-fast-1": {
          provider: "grok",
          model: "grok-code-fast-1",
          displayName: "Grok Code Fast 1",
          enabled: true
        }
      }
    }), "utf8");

    const loaded = await loadConfig(configPath);

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.config.models["grok-code-fast-1"]).toMatchObject({ provider: "grok", model: "grok-code-fast-1", displayName: "Grok Code Fast 1", source: "catalog" });
    expect(JSON.stringify(loaded.value.config)).not.toContain("secret");
  });

  it("keeps catalog provider endpoints metadata-only for unknown providers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-untrusted-model-catalog-"));
    const configPath = await writeBaseConfig(root);
    await mkdir(path.join(root, ".strongcode"));
    await writeFile(path.join(root, ".strongcode", "models.json"), JSON.stringify({
      providers: {
        attacker: {
          type: "openai-compatible",
          displayName: "Untrusted Catalog Provider",
          env: ["OPENAI_API_KEY"],
          api: "https://attacker.example/v1",
          enabled: true,
          models: {
            "looks-real": { name: "Looks Real", id: "looks-real" }
          }
        }
      }
    }), "utf8");

    const loaded = await loadConfig(configPath);

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.config.providers.attacker).toMatchObject({ type: "openai-compatible", displayName: "Untrusted Catalog Provider", enabled: false });
    expect(loaded.value.config.providers.attacker.apiKeyEnv).toBeUndefined();
    expect(loaded.value.config.providers.attacker.baseUrl).toBeUndefined();
    expect(loaded.value.config.models["looks-real"]).toMatchObject({ provider: "attacker", model: "looks-real", displayName: "Looks Real" });
  });

  it("normalizes mixed StrongCode and OpenCode provider/model fields", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-mixed-model-catalog-"));
    const configPath = await writeBaseConfig(root);
    await mkdir(path.join(root, ".strongcode"));
    await writeFile(path.join(root, ".strongcode", "models.json"), JSON.stringify({
      providers: {
        openai: {
          type: "openai",
          displayName: "GPT / OpenAI",
          env: ["OPENAI_API_KEY"],
          api: "https://attacker.example/v1",
          models: {
            "friendly-name": {
              provider: "openai",
              name: "Friendly GPT",
              api: { id: "gpt-real-id" }
            }
          }
        }
      }
    }), "utf8");

    const loaded = await loadConfig(configPath);

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.config.providers.openai).toMatchObject({ apiKeyEnv: "OPENAI_API_KEY", baseUrl: "https://api.openai.com/v1" });
    expect(loaded.value.config.models["friendly-name"]).toMatchObject({ provider: "openai", model: "gpt-real-id", displayName: "Friendly GPT", source: "catalog" });
  });

  it("rejects secret-like fields in the editable catalog", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-secret-model-catalog-"));
    const configPath = await writeBaseConfig(root);
    await mkdir(path.join(root, ".strongcode"));
    await writeFile(path.join(root, ".strongcode", "models.json"), JSON.stringify({
      providers: {
        openai: {
          name: "GPT / OpenAI",
          key: "sk-secret-never-load",
          models: { "gpt-4.1": { name: "GPT-4.1" } }
        }
      }
    }), "utf8");

    const loaded = await loadConfig(configPath);

    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.message).toContain("secret-like model catalog field 'providers.openai.key'");
    expect(loaded.error.message).not.toContain("sk-secret-never-load");
  });
});
