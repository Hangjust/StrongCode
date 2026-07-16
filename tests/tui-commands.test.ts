import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config/load";
import { handleConnectCommand } from "../src/tui/commands";
import { ProviderAuthStore, resolveRuntimeAuthDataDir } from "../src/models/auth-store";
import { SetupDiscoveryHttpError } from "../src/setup/discovery";

function visibleLength(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function expectBounded(output: string, width = 80): void {
  output.split("\n").forEach(line => {
    expect(visibleLength(line)).toBeLessThanOrEqual(width);
  });
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
  const root = await mkdtemp(path.join(tmpdir(), "strongcode-connect-"));
  const configPath = path.join(root, "strongcode.config.yaml");
  await writeFile(configPath, baseConfig, "utf8");
  const loaded = await loadConfig(configPath);
  if (!loaded.ok) throw loaded.error;

  const state = {
    provider: "mock",
    defaultAgent: "default",
    configPath,
    configMissing: false,
    workspace: ".",
    dataDir: ".strongcode"
  };

  return {
    configPath,
    config: loaded.value.config,
    state,
    noColor: true,
    trustedConfig: true,
    authStore: new ProviderAuthStore(path.join(root, ".strongcode")),
    discoverModelsForSetup: async () => [{ id: "custom-model", displayName: "Custom Model" }]
  };
}

describe("connect tui command", () => {
  it("renders connect guidance and stores provider auth outside config", async () => {
    const context = await commandContext();

    const guidance = await handleConnectCommand("/connect", context);
    const connected = await handleConnectCommand("/connect custom test-key", context);
    const authFile = await readFile(context.authStore.filePath, "utf8");

    expect(guidance).toContain("/connect <provider-id> <api-key>");
    expect(guidance).toContain("strongcode setup --force");
    expect(connected).toContain("Connected custom to https://example.com");
    expect(connected).toContain("private project vault");
    expect(authFile).toContain("test-key");
    expect(context.config.providers.custom.enabled).toBe(true);
    expect(JSON.stringify(context.config)).not.toContain("test-key");
    expectBounded([guidance, connected].join("\n"));
  });

  it("stores default interactive credentials in an isolated project vault outside the repository", async () => {
    const context = await commandContext();
    const canonicalHome = await mkdtemp(path.join(tmpdir(), "strongcode-connect-home-"));
    const originalHome = process.env.STRONGCODE_HOME;
    delete (context as Partial<typeof context>).authStore;
    process.env.STRONGCODE_HOME = canonicalHome;
    try {
      await handleConnectCommand("/connect custom canonical-key", context);
      const projectDataDir = path.join(path.dirname(context.configPath), ".strongcode");
      const authDataDir = resolveRuntimeAuthDataDir(context.configPath, projectDataDir, canonicalHome);
      expect(await readFile(path.join(authDataDir, "auth.json"), "utf8")).toContain("canonical-key");
      await expect(readFile(path.join(projectDataDir, "auth.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(path.join(canonicalHome, "auth.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (originalHome === undefined) delete process.env.STRONGCODE_HOME;
      else process.env.STRONGCODE_HOME = originalHome;
    }
  });

  it("does not save a provider key rejected during endpoint validation", async () => {
    const context = await commandContext();
    context.discoverModelsForSetup = async () => { throw new SetupDiscoveryHttpError(401); };

    const output = await handleConnectCommand("/connect custom rejected-key", context);

    expect(output).toMatch(/^Error:/);
    expect(output).toContain("rejected that API key (HTTP 401)");
    expect(output).toContain("Nothing was saved");
    expect(await context.authStore.all()).toEqual({});
  });

  it("keeps API providers key-only and separates native ChatGPT OAuth", async () => {
    const context = await commandContext();

    const customGuidance = await handleConnectCommand("/connect custom", context);
    const openaiGuidance = await handleConnectCommand("/connect openai", context);
    const unsupportedAuthArgument = await handleConnectCommand(`/connect custom ${["o", "auth"].join("")}`, context);

    expect(customGuidance).toContain("Auth methods: api_key");
    expect(customGuidance).not.toMatch(/oauth/i);
    expect(openaiGuidance).toContain("Auth methods: api_key");
    expect(openaiGuidance).not.toContain("chatgpt-browser");
    expect(unsupportedAuthArgument).toBe("Usage: /connect custom <api-key>.");
    expect(unsupportedAuthArgument).not.toMatch(/oauth/i);
  });

  it("runs native ChatGPT browser or headless OAuth from the connect popup", async () => {
    const context = await commandContext();
    context.config.providers.chatgpt = { type: "chatgpt", displayName: "ChatGPT", enabled: false };
    context.config.models["gpt-5.5"] = { provider: "chatgpt", model: "gpt-5.5", enabled: true };
    const modes: string[] = [];
    const prompts: string[] = [];

    const response = await handleConnectCommand("/connect chatgpt headless", {
      ...context,
      onAuthPrompt: prompt => prompts.push(`${prompt.userCode} ${prompt.url}`),
      runChatGptLogin: async (mode, authStore, options) => {
        modes.push(mode);
        options?.onPrompt?.({ url: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH", instructions: "Enter the code" });
        const auth = { type: "oauth" as const, access: "chatgpt-access", refresh: "chatgpt-refresh", expires: Date.now() + 3_600_000 };
        await authStore.set("chatgpt", auth);
        return auth;
      }
    });

    expect(modes).toEqual(["device-code"]);
    expect(prompts).toEqual(["ABCD-EFGH https://auth.openai.com/codex/device"]);
    expect(response).toContain("native ChatGPT OAuth");
    await expect(context.authStore.get("chatgpt")).resolves.toMatchObject({ type: "oauth", access: "chatgpt-access" });
  });

  it("does not expose user-account OAuth to an untrusted project config", async () => {
    const context = await commandContext();
    context.config.providers.chatgpt = { type: "chatgpt", displayName: "ChatGPT", enabled: false };
    let loginCalls = 0;

    const response = await handleConnectCommand("/connect chatgpt browser", {
      ...context,
      trustedConfig: false,
      runChatGptLogin: async () => {
        loginCalls += 1;
        throw new Error("must not run");
      }
    });

    expect(response).toContain("untrusted project config");
    expect(loginCalls).toBe(0);
  });

  it("does not send a key to a repository-defined remote endpoint before project trust", async () => {
    const context = await commandContext();
    context.trustedConfig = false;

    const output = await handleConnectCommand("/connect custom must-not-send", context);

    expect(output).toContain("Refusing to send a key");
    expect(output).toContain("https://example.com");
    expect(await context.authStore.all()).toEqual({});
    expectBounded(output);
  });

  it("routes legacy ChatGPT browser commands to native OAuth setup", async () => {
    const context = await commandContext();

    const output = await handleConnectCommand("/connect openai chatgpt-browser", context);

    expect(output).toContain("login is now native");
    expect(output).toContain("strongcode setup --force");
    expectBounded(output);
  });

  it("routes legacy ChatGPT headless commands to native OAuth setup", async () => {
    const context = await commandContext();

    const output = await handleConnectCommand("/connect openai chatgpt-headless", context);

    expect(output).toContain("login is now native");
    expectBounded(output);
  });

  it("removes provider auth", async () => {
    const context = await commandContext();

    await handleConnectCommand("/connect custom test-key", context);
    const removed = await handleConnectCommand("/connect remove custom", context);

    expect(removed).toContain("Removed auth for custom");
    expect(await context.authStore.all()).toEqual({});
  });
});
