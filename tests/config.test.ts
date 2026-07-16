import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, resolveConfigPath } from "../src/config/load";
import { tempWorkspace } from "./helpers";

let previousStrongCodeHome: string | undefined;

beforeEach(async () => {
  previousStrongCodeHome = process.env.STRONGCODE_HOME;
  process.env.STRONGCODE_HOME = await mkdtemp(path.join(os.tmpdir(), "strongcode-config-home-"));
});

afterEach(() => {
  if (previousStrongCodeHome === undefined) delete process.env.STRONGCODE_HOME;
  else process.env.STRONGCODE_HOME = previousStrongCodeHome;
});

describe("config", () => {
  it("does not let a stale config in the OS home shadow completed global setup", async () => {
    const fakeHome = await tempWorkspace();
    const globalHome = path.join(fakeHome.root, ".config", "strongcode");
    const stale = path.join(fakeHome.root, "strongcode.config.yaml");
    const global = path.join(globalHome, "strongcode.config.yaml");
    await mkdir(globalHome, { recursive: true });
    await writeFile(stale, "stale", "utf8");
    await writeFile(global, "global", "utf8");

    expect(resolveConfigPath(undefined, {
      cwd: fakeHome.root,
      homeDirectory: fakeHome.root,
      strongCodeHome: global
    })).toBe(global);
  });

  it("continues to prefer a config inside an actual project directory", async () => {
    const fakeHome = await tempWorkspace();
    const project = await tempWorkspace();
    const local = path.join(project.root, "strongcode.config.yaml");
    const global = path.join(fakeHome.root, "strongcode.config.yaml");
    await writeFile(local, "local", "utf8");
    await writeFile(global, "global", "utf8");

    expect(resolveConfigPath(undefined, {
      cwd: project.root,
      homeDirectory: fakeHome.root,
      strongCodeHome: global
    })).toBe(local);
  });

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

  it("rejects credentialless configuration for non-loopback providers", async () => {
    const workspace = await tempWorkspace();
    const configPath = path.join(workspace.root, "unauthenticated-remote.yaml");
    await writeFile(configPath, `version: 1
workspace: "."
dataDir: ".strongcode"
defaultAgent: default
providers:
  custom:
    type: openai-compatible
    displayName: Custom Provider
    baseUrl: https://example.com/v1
    allowUnauthenticated: true
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
    if (!loaded.ok) expect(loaded.error.message).toContain("only on localhost");
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

  it("loads agent prompt metadata and validates configured fallback models", async () => {
    const workspace = await tempWorkspace();
    const configPath = path.join(workspace.root, "agent-metadata.yaml");
    await writeFile(configPath, `version: 1
workspace: "."
dataDir: ".strongcode"
defaultAgent: tesla
providers:
  mock:
    type: mock
    displayName: Mock
    enabled: true
agents:
  tesla:
    model: mock
    tools: []
    displayName: Custom Tesla
    mode: primary
    systemPrompt: Preserve the user's local conventions.
    fallbackModels: [missing]
    skills: [planning]
models:
  mock:
    provider: mock
    enabled: true
permissions:
  tools: {}
`, "utf8");

    const invalid = await loadConfig(configPath);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.message).toContain("Fallback model 'missing' is not defined");

    await writeFile(configPath, (await readFile(configPath, "utf8")).replace("fallbackModels: [missing]", "fallbackModels: [mock]"), "utf8");
    const valid = await loadConfig(configPath);
    expect(valid.ok).toBe(true);
    if (valid.ok) expect(valid.value.config.agents.tesla).toMatchObject({
      displayName: "Custom Tesla",
      mode: "primary",
      systemPrompt: "Preserve the user's local conventions.",
      fallbackModels: ["mock"],
      skills: ["planning"]
    });
  });
});
