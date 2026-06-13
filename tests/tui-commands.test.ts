import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config/load";
import { handleConnectCommand } from "../src/tui/commands";
import { ProviderAuthStore } from "../src/models/auth-store";

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

  return { configPath, config: loaded.value.config, state, noColor: true, authStore: new ProviderAuthStore(path.join(root, ".strongcode")) };
}

describe("connect tui command", () => {
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

  it("starts ChatGPT browser OAuth without leaking verifier state", async () => {
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

  it("starts ChatGPT headless OAuth with a device code", async () => {
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
});
