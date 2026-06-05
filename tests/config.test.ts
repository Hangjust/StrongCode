import { writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/config/load";
import { tempWorkspace } from "./helpers";

describe("config", () => {
  it("loads and validates a complete config", async () => {
    const workspace = await tempWorkspace();
    const configPath = path.join(workspace.root, "strongcode.config.yaml");
    await writeFile(configPath, `version: 1
workspace: "."
dataDir: ".strongcode"
defaultAgent: default
agents:
  default:
    model: mock
    tools:
      - list_files
models:
  mock:
    provider: mock
permissions:
  tools:
    list_files: allow
`, "utf8");

    const loaded = await loadConfig(configPath);

    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.config.defaultAgent).toBe("default");
      expect(loaded.value.config.agents.default.tools).toEqual(["list_files"]);
      expect(loaded.value.config.providers.mock.displayName).toBe("Mock");
    }
  });

  it("rejects configs with missing referenced models", async () => {
    const workspace = await tempWorkspace();
    const configPath = path.join(workspace.root, "broken.yaml");
    await writeFile(configPath, `version: 1
workspace: "."
dataDir: ".strongcode"
defaultAgent: default
agents:
  default:
    model: missing
    tools: []
models:
  mock:
    provider: mock
permissions:
  tools: {}
`, "utf8");

    const loaded = await loadConfig(configPath);

    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.message).toContain("missing");
    }
  });

  it("rejects direct provider secrets", async () => {
    const workspace = await tempWorkspace();
    const configPath = path.join(workspace.root, "secret.yaml");
    await writeFile(configPath, `version: 1
workspace: "."
dataDir: ".strongcode"
defaultAgent: default
providers:
  custom:
    type: openai-compatible
    displayName: Custom Provider
    apiKey: should-not-be-here
agents:
  default:
    model: custom-model
    tools: []
models:
  custom-model:
    provider: custom
    model: custom-model
permissions:
  tools: {}
`, "utf8");

    const loaded = await loadConfig(configPath);

    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.message).toContain("apiKey");
    }
  });

  it("rejects direct model secrets", async () => {
    const workspace = await tempWorkspace();
    const configPath = path.join(workspace.root, "model-secret.yaml");
    await writeFile(configPath, `version: 1
workspace: "."
dataDir: ".strongcode"
defaultAgent: default
agents:
  default:
    model: mock
    tools: []
models:
  mock:
    provider: mock
    bearerToken: should-not-be-here
permissions:
  tools: {}
`, "utf8");

    const loaded = await loadConfig(configPath);

    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.message).toContain("bearerToken");
    }
  });

  it("rejects secret aliases nested inside model options arrays", async () => {
    const workspace = await tempWorkspace();
    const configPath = path.join(workspace.root, "nested-secret.yaml");
    await writeFile(configPath, `version: 1
workspace: "."
dataDir: ".strongcode"
defaultAgent: default
agents:
  default:
    model: mock
    tools: []
models:
  mock:
    provider: mock
    options:
      headers:
        - api_key: should-not-be-here
permissions:
  tools: {}
`, "utf8");

    const loaded = await loadConfig(configPath);

    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.message).toContain("api_key");
    }
  });

  it("rejects model providers that are not configured", async () => {
    const workspace = await tempWorkspace();
    const configPath = path.join(workspace.root, "missing-provider.yaml");
    await writeFile(configPath, `version: 1
workspace: "."
dataDir: ".strongcode"
defaultAgent: default
providers:
  mock:
    type: mock
    displayName: Mock
agents:
  default:
    model: custom-model
    tools: []
models:
  custom-model:
    provider: custom
permissions:
  tools: {}
`, "utf8");

    const loaded = await loadConfig(configPath);

    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.message).toContain("custom");
    }
  });

  it("rejects non-local http provider base URLs", async () => {
    const workspace = await tempWorkspace();
    const configPath = path.join(workspace.root, "unsafe-url.yaml");
    await writeFile(configPath, `version: 1
workspace: "."
dataDir: ".strongcode"
defaultAgent: default
providers:
  custom:
    type: openai-compatible
    displayName: Custom Provider
    apiKeyEnv: CUSTOM_PROVIDER_API_KEY
    baseUrl: http://example.com/v1
agents:
  default:
    model: custom-model
    tools: []
models:
  custom-model:
    provider: custom
permissions:
  tools: {}
`, "utf8");

    const loaded = await loadConfig(configPath);

    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.message).toContain("https unless it points to localhost");
    }
  });

  it("rejects provider URL credentials and unsafe model endpoints", async () => {
    const workspace = await tempWorkspace();
    const configPath = path.join(workspace.root, "secret-url.yaml");
    await writeFile(configPath, `version: 1
workspace: "."
dataDir: ".strongcode"
defaultAgent: default
providers:
  custom:
    type: openai-compatible
    displayName: Custom Provider
    apiKeyEnv: CUSTOM_PROVIDER_API_KEY
    baseUrl: https://user:pass@example.com/v1
    modelsEndpoint: //example.com/models
agents:
  default:
    model: custom-model
    tools: []
models:
  custom-model:
    provider: custom
permissions:
  tools: {}
`, "utf8");

    const loaded = await loadConfig(configPath);

    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.message).toContain("username or password");
      expect(loaded.error.message).toContain("stay relative");
    }
  });
});
