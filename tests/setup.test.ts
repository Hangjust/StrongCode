import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config/load";
import { globalConfigPath } from "../src/setup/config";
import { runSetup, shouldRunFirstSetup } from "../src/setup/wizard";
import { loadSetupState, updateSetupState } from "../src/setup/state";
import { SetupCancelledError, type SetupChoice, type SetupPrompter } from "../src/setup/types";
import type { InstallBlenderIntegrationOptions } from "../src/setup/blender/install";
import type { BlenderSetupDiscovery } from "../src/setup/blender/types";
import { VOICE_BLOCK_START, VOICE_TO_TEXT_INSTRUCTIONS } from "../src/setup/voice-instructions";

class FakePrompter implements SetupPrompter {
  readonly output: string[] = [];
  readonly selections: string[] = [];
  readonly multiselections: string[][] = [];
  readonly texts: string[] = [];
  readonly secrets: string[] = [];
  readonly confirmations: boolean[] = [];
  readonly confirmCalls: Array<{ message: string; initialValue: boolean | undefined }> = [];
  readonly multiselectCalls: Array<{ message: string; choices: SetupChoice[]; initialValues: string[] }> = [];
  calls = 0;

  intro(message: string): void { this.output.push(message); }
  note(message: string): void { this.output.push(message); }
  outro(message: string): void { this.output.push(message); }
  close(): void {}
  async select(_message: string, _choices: SetupChoice[]): Promise<string> { this.calls += 1; return this.selections.shift()!; }
  async multiselect(message: string, choices: SetupChoice[], initialValues: string[] = []): Promise<string[]> {
    this.calls += 1;
    this.multiselectCalls.push({ message, choices, initialValues });
    return this.multiselections.shift() ?? [];
  }
  async text(): Promise<string> { this.calls += 1; return this.texts.shift()!; }
  async secret(): Promise<string> { this.calls += 1; return this.secrets.shift() ?? ""; }
  async confirm(message: string, initialValue?: boolean): Promise<boolean> {
    this.calls += 1;
    this.output.push(message);
    this.confirmCalls.push({ message, initialValue });
    return this.confirmations.shift() ?? false;
  }
}

async function tempHome(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

const blenderProfile = {
  profileId: "blender-test-profile",
  executable: { canonicalPath: path.resolve("fixtures", "blender.exe"), sha256: "a".repeat(64) },
  version: "4.3.2",
  paths: {
    resources: {
      local: path.resolve("fixtures", "blender", "local"),
      system: path.resolve("fixtures", "blender", "system"),
      user: path.resolve("fixtures", "blender", "user")
    },
    config: path.resolve("fixtures", "blender", "config"),
    scripts: [path.resolve("fixtures", "blender", "scripts")]
  },
  sources: ["association" as const]
};

const blenderPython = {
  executable: { canonicalPath: path.resolve("fixtures", "python.exe"), sha256: "b".repeat(64) },
  implementation: "cpython" as const,
  version: { major: 3, minor: 11, patch: 9 },
  prefix: path.resolve("fixtures", "python"),
  pointerWidth: 64 as const,
  sysconfigPlatform: "win_amd64" as const
};

function blenderDiscovery(overrides: Partial<BlenderSetupDiscovery> = {}): BlenderSetupDiscovery {
  return {
    profiles: [blenderProfile],
    selection: { kind: "selected", profileId: blenderProfile.profileId, profile: blenderProfile },
    python: blenderPython,
    ...overrides
  };
}

describe("first-run setup", () => {
  it("migrates schema-v1 setup state in memory without changing core completion", async () => {
    const homePath = await tempHome("strongcode-setup-v1-");
    await writeFile(path.join(homePath, "setup.json"), `${JSON.stringify({
      schemaVersion: 1,
      completed: true,
      completedAt: "2026-07-09T12:00:00.000Z",
      selectedProviders: [],
      deepSeekConfigured: false,
      gemmaConfigured: false,
      mockOnlyConfirmed: true,
      voiceToText: "no"
    })}\n`, "utf8");

    const state = await loadSetupState(homePath);

    expect(state).toMatchObject({ schemaVersion: 3, completed: true, mockOnlyConfirmed: true, blenderOfferVersion: 0 });
    expect(state.blender).toBeUndefined();
    expect(JSON.parse(await readFile(path.join(homePath, "setup.json"), "utf8")).schemaVersion).toBe(1);
  });

  it("reports malformed setup state as a configuration error", async () => {
    const homePath = await tempHome("strongcode-setup-malformed-");
    await writeFile(path.join(homePath, "setup.json"), "{not-json\n", "utf8");

    await expect(loadSetupState(homePath)).rejects.toMatchObject({
      name: "StrongCodeError",
      code: "CONFIG_ERROR"
    });
  });

  it("installs Blender only after explicit default-false consent and records schema-v2 metadata", async () => {
    const homePath = await tempHome("strongcode-setup-blender-consent-");
    const prompts = new FakePrompter();
    prompts.multiselections.push([]);
    prompts.confirmations.push(true, false, false, true);
    prompts.selections.push("no");
    const installs: InstallBlenderIntegrationOptions[] = [];

    const result = await runSetup({}, {
      homePath,
      prompter: prompts,
      interactive: true,
      now: () => new Date("2026-07-09T12:00:00.000Z"),
      blender: {
        platform: "win32",
        architecture: "x64",
        discover: async () => blenderDiscovery(),
        install: async options => {
          installs.push(options);
          return { status: "installed", profileId: options.selection.profile.profileId, receiptPath: path.join(homePath, "mcps", "blender", "installation.json") };
        }
      }
    });

    expect(installs).toHaveLength(1);
    expect(installs[0]).toMatchObject({ selection: { flavor: "legacy", profile: blenderProfile }, python: blenderPython, platform: "win32", architecture: "x64" });
    expect(prompts.confirmCalls.at(-1)?.initialValue).toBe(false);
    expect(prompts.output.join("\n")).toContain("blender-mcp 1.6.4");
    expect(prompts.output.join("\n")).toContain("execute_blender_code");
    expect(prompts.output.join("\n")).toContain("rollback");
    expect(result.state).toMatchObject({
      schemaVersion: 3,
      completed: true,
      blenderOfferVersion: 2,
      blender: {
        profileId: blenderProfile.profileId,
        version: blenderProfile.version,
        executablePath: blenderProfile.executable.canonicalPath,
        installedAt: "2026-07-09T12:00:00.000Z"
      }
    });
  });

  it("does not call the Blender installer when consent is declined", async () => {
    const homePath = await tempHome("strongcode-setup-blender-decline-");
    const prompts = new FakePrompter();
    prompts.multiselections.push([]);
    prompts.confirmations.push(true, false, false, false);
    prompts.selections.push("no");
    let installs = 0;

    const result = await runSetup({}, {
      homePath,
      prompter: prompts,
      interactive: true,
      blender: {
        platform: "win32",
        architecture: "x64",
        discover: async () => blenderDiscovery(),
        install: async options => {
          installs += 1;
          return { status: "installed", profileId: options.selection.profile.profileId, receiptPath: "unused" };
        }
      }
    });

    expect(installs).toBe(0);
    expect(result.state.completed).toBe(true);
    expect(result.state.blender).toBeUndefined();
    expect(result.state.blenderOfferVersion).toBe(2);
  });

  it("reports the exact Python prerequisite without prompting or mutating Blender", async () => {
    const homePath = await tempHome("strongcode-setup-blender-python-");
    const prompts = new FakePrompter();
    prompts.multiselections.push([]);
    prompts.confirmations.push(true, false, false);
    prompts.selections.push("no");
    let installs = 0;

    const result = await runSetup({}, {
      homePath,
      prompter: prompts,
      interactive: true,
      blender: {
        platform: "win32",
        architecture: "x64",
        discover: async () => blenderDiscovery({ python: undefined }),
        install: async options => {
          installs += 1;
          return { status: "installed", profileId: options.selection.profile.profileId, receiptPath: "unused" };
        }
      }
    });

    expect(installs).toBe(0);
    expect(prompts.output.join("\n")).toContain("CPython 3.11 win_amd64");
    expect(prompts.confirmCalls).toHaveLength(3);
    expect(result.state.completed).toBe(true);
    expect(result.state.blenderOfferVersion).toBe(0);
  });

  it("keeps core setup complete and returns a clear failure when Blender installation fails", async () => {
    const homePath = await tempHome("strongcode-setup-blender-failure-");
    const prompts = new FakePrompter();
    prompts.multiselections.push([]);
    prompts.confirmations.push(true, false, false, true);
    prompts.selections.push("no");

    await expect(runSetup({}, {
      homePath,
      prompter: prompts,
      interactive: true,
      blender: {
        platform: "win32",
        architecture: "x64",
        discover: async () => blenderDiscovery(),
        install: async () => { throw new Error("installer fixture failed"); }
      }
    })).rejects.toThrow("Core setup completed, but Blender integration failed: installer fixture failed");

    const state = await loadSetupState(homePath);
    expect(state.completed).toBe(true);
    expect(state.blender).toBeUndefined();
    expect(await shouldRunFirstSetup(homePath)).toBe(false);
  });

  it("merges core completion without clobbering Blender fields written after the initial read", async () => {
    const homePath = await tempHome("strongcode-setup-concurrent-blender-");
    const prompts = new FakePrompter();
    prompts.multiselections.push([]);
    prompts.confirmations.push(true, false, false);
    const baseSelect = prompts.select.bind(prompts);
    prompts.selections.push("no");
    prompts.select = async (message, choices) => {
      if (message.startsWith("Voice-to-text")) {
        await updateSetupState(homePath, () => ({
          blenderOfferVersion: 1,
          blender: {
            flavor: "legacy",
            profileId: blenderProfile.profileId,
            version: blenderProfile.version,
            executablePath: blenderProfile.executable.canonicalPath,
            receiptPath: path.join(homePath, "mcps", "blender", "installation.json"),
            installedAt: "2026-07-15T10:00:00.000Z"
          }
        }));
      }
      return baseSelect(message, choices);
    };

    const result = await runSetup({}, { homePath, prompter: prompts, interactive: false });

    expect(result.state).toMatchObject({
      completed: true,
      mockOnlyConfirmed: true,
      blenderOfferVersion: 1,
      blender: { profileId: blenderProfile.profileId }
    });
  });

  it("persists a one-time completion marker and idempotent voice instructions", async () => {
    const homePath = await tempHome("strongcode-setup-voice-");
    const prompts = new FakePrompter();
    prompts.multiselections.push([]);
    prompts.confirmations.push(true, false, false);
    prompts.selections.push("yes");

    const result = await runSetup({}, { homePath, prompter: prompts, now: () => new Date("2026-07-09T12:00:00.000Z") });
    expect(result.status).toBe("completed");
    expect(result.state.completedAt).toBe("2026-07-09T12:00:00.000Z");
    expect(result.state.voiceToText).toBe("yes");
    expect(prompts.multiselectCalls[0]?.initialValues).toEqual(["openai"]);
    expect(prompts.multiselectCalls[0]?.choices.filter(choice => choice.value === "openai")).toEqual([
      { value: "openai", label: "OpenAI / ChatGPT", hint: "Browser login · API key" }
    ]);
    expect(prompts.multiselectCalls[0]?.choices.some(choice => choice.value === "chatgpt")).toBe(false);

    const agents = await readFile(path.join(homePath, "AGENTS.md"), "utf8");
    expect(agents).toContain("## Branch Names");
    expect(agents).toContain(VOICE_TO_TEXT_INSTRUCTIONS);
    expect(agents.match(new RegExp(VOICE_BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(1);

    const secondPrompts = new FakePrompter();
    const second = await runSetup({}, { homePath, prompter: secondPrompts });
    expect(second.status).toBe("already-complete");
    expect(secondPrompts.calls).toBe(0);
  });

  it("discovers a custom provider while keeping its API key out of config", async () => {
    const homePath = await tempHome("strongcode-setup-custom-");
    const prompts = new FakePrompter();
    prompts.multiselections.push(["custom"], ["custom-large"]);
    prompts.selections.push("openai-compatible", "no");
    prompts.texts.push("Acme Models", "https://models.example.com/v1");
    prompts.secrets.push("secret-never-in-config");
    prompts.confirmations.push(false, false);

    const result = await runSetup({}, {
      homePath,
      prompter: prompts,
      discovery: {
        fetcher: async () => new Response(JSON.stringify({ data: [{ id: "custom-large" }, { id: "custom-small" }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      }
    });

    expect(result.status).toBe("completed");
    const loaded = await loadConfig(globalConfigPath(homePath));
    if (!loaded.ok) throw loaded.error;
    expect(loaded.value.config.providers["acme-models"].baseUrl).toBe("https://models.example.com/v1");
    expect(loaded.value.config.providers["acme-models"].modelsEndpoint).toBe("/models");
    expect(loaded.value.config.models["custom-large"]).toMatchObject({ provider: "acme-models", model: "custom-large", enabled: true });
    expect(await readFile(path.join(homePath, "auth.json"), "utf8")).toContain("secret-never-in-config");
    expect(await readFile(globalConfigPath(homePath), "utf8")).not.toContain("secret-never-in-config");
    expect(await readFile(path.join(homePath, "providers.json"), "utf8")).not.toContain("secret-never-in-config");
  });

  it("performs native ChatGPT OAuth and persists the account for one-time setup", async () => {
    const homePath = await tempHome("strongcode-setup-chatgpt-");
    const prompts = new FakePrompter();
    prompts.multiselections.push(["openai"], ["gpt-codex-test"]);
    prompts.selections.push("browser", "no");
    prompts.confirmations.push(false, false);
    const loginModes: string[] = [];

    const result = await runSetup({}, {
      homePath,
      prompter: prompts,
      runChatGptLogin: async (mode, authStore) => {
        loginModes.push(mode);
        const auth = { type: "oauth" as const, access: "oauth-access", refresh: "oauth-refresh", expires: Date.now() + 3_600_000 };
        await authStore.set("chatgpt", auth);
        return auth;
      },
      listChatGptModels: async () => [{ id: "gpt-codex-test", displayName: "GPT Codex Test", isDefault: true }]
    });

    expect(loginModes).toEqual(["browser"]);
    expect(result.config?.providers.chatgpt.type).toBe("chatgpt");
    expect(result.config?.models["gpt-codex-test"]).toMatchObject({ provider: "chatgpt" });
    const auth = JSON.parse(await readFile(path.join(homePath, "auth.json"), "utf8"));
    expect(auth.chatgpt).toMatchObject({ type: "oauth", access: "oauth-access", refresh: "oauth-refresh" });

    const repeat = new FakePrompter();
    repeat.multiselections.push(["openai"]);
    repeat.selections.push("existing-chatgpt", "no");
    repeat.confirmations.push(false, false);
    const repeated = await runSetup({ force: true }, {
      homePath,
      prompter: repeat,
      runChatGptLogin: async mode => { throw new Error(`unexpected repeated login: ${mode}`); },
      listChatGptModels: async () => [{ id: "gpt-codex-test", displayName: "GPT Codex Test", isDefault: true }]
    });

    expect(loginModes).toEqual(["browser"]);
    expect(repeated.config?.providers.chatgpt.enabled).toBe(true);
    expect(repeated.config?.providers.openai.enabled).toBe(false);
    expect(repeat.multiselectCalls[0]?.initialValues).toContain("openai");
    expect(repeat.multiselectCalls[0]?.choices.some(choice => choice.value === "chatgpt")).toBe(false);
  });

  it("falls back from unavailable browser login to an OpenAI API key instead of mock", async () => {
    const homePath = await tempHome("strongcode-setup-chatgpt-fallback-");
    const prompts = new FakePrompter();
    prompts.multiselections.push(["openai"]);
    prompts.selections.push("browser", "enter", "no");
    prompts.secrets.push("openai-fallback-key");
    prompts.confirmations.push(true, false, false);

    const result = await runSetup({}, {
      homePath,
      prompter: prompts,
      runChatGptLogin: async () => { throw new Error("browser login is unavailable"); },
      discovery: {
        fetcher: async () => new Response(JSON.stringify({ data: [{ id: "gpt-api-test" }] }), { status: 200 })
      }
    });

    expect(result.config?.providers.openai.enabled).toBe(true);
    expect(result.config?.providers.chatgpt.enabled).toBe(false);
    expect(result.config?.agents[result.config.defaultAgent].model).toBe("gpt-api-test");
    expect(prompts.output.join("\n")).toContain("Use an OpenAI API key instead?");
  });

  it("delegates Google headless login to gcloud ADC for Vertex AI", async () => {
    const homePath = await tempHome("strongcode-setup-google-adc-");
    const prompts = new FakePrompter();
    prompts.multiselections.push(["google"]);
    prompts.selections.push("adc-headless", "no");
    prompts.texts.push("example-project", "europe-west4", "gemini-vertex-test");
    prompts.confirmations.push(false, false);
    const modes: string[] = [];

    const result = await runSetup({}, {
      homePath,
      prompter: prompts,
      runGoogleAdcLogin: async mode => { modes.push(mode); }
    });

    expect(modes).toEqual(["headless"]);
    expect(result.config?.providers["google-vertex"]).toMatchObject({
      type: "google-vertex",
      projectId: "example-project",
      location: "europe-west4"
    });
    const auth = JSON.parse(await readFile(path.join(homePath, "auth.json"), "utf8"));
    expect(auth["google-vertex"]).toMatchObject({ type: "delegated", provider: "gcloud" });
  });

  it("imports credentialless models from a detected loopback server", async () => {
    const homePath = await tempHome("strongcode-setup-local-");
    const prompts = new FakePrompter();
    prompts.multiselections.push(["local"], ["local-model"]);
    prompts.selections.push("ollama", "no");
    prompts.confirmations.push(false, false);

    const result = await runSetup({}, {
      homePath,
      prompter: prompts,
      scanLocalProviders: async () => [{
        id: "ollama",
        label: "Ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        modelsEndpoint: "/models",
        nativeUrl: "http://127.0.0.1:11434/api/tags",
        models: [{ id: "local-model", displayName: "Local Model" }]
      }]
    });

    expect(result.config?.providers.ollama).toMatchObject({
      allowUnauthenticated: true,
      baseUrl: "http://127.0.0.1:11434/v1"
    });
    expect(result.config?.models["local-model"]).toMatchObject({ provider: "ollama" });
  });

  it("offers only the missing Gemma counterpart after DeepSeek is configured", async () => {
    const homePath = await tempHome("strongcode-setup-deepseek-");
    const prompts = new FakePrompter();
    prompts.multiselections.push(["deepseek"], ["deepseek-chat"]);
    prompts.selections.push("enter", "no");
    prompts.secrets.push("deepseek-secret");
    prompts.confirmations.push(false);

    const result = await runSetup({}, {
      homePath,
      prompter: prompts,
      discovery: {
        fetcher: async () => new Response(JSON.stringify({ data: [{ id: "deepseek-chat" }] }), { status: 200 })
      }
    });

    expect(result.state.deepSeekConfigured).toBe(true);
    expect(result.state.gemmaConfigured).toBe(false);
    expect(prompts.confirmations).toHaveLength(0);
    expect(prompts.output.join("\n")).toContain("DeepSeek is configured");
  });

  it("rejects an invalid provider key without saving it or asking for a manual model ID", async () => {
    const homePath = await tempHome("strongcode-setup-rejected-key-");
    const prompts = new FakePrompter();
    prompts.multiselections.push(["deepseek"]);
    prompts.selections.push("enter", "no");
    prompts.secrets.push("rejected-deepseek-key");
    prompts.confirmations.push(true, false, false);

    const result = await runSetup({}, {
      homePath,
      prompter: prompts,
      discovery: {
        fetcher: async () => new Response(JSON.stringify({ error: "invalid key" }), { status: 401 })
      }
    });

    expect(result.status).toBe("completed");
    expect(result.state.deepSeekConfigured).toBe(false);
    expect(result.config?.agents[result.config.defaultAgent].model).toBe("mock");
    expect(prompts.output.join("\n")).toContain("rejected the API key (HTTP 401)");
    expect(prompts.texts).toEqual([]);
    expect(JSON.parse(await readFile(path.join(homePath, "auth.json"), "utf8"))).toEqual({});
  });

  it("ranks chat models ahead of embeddings and persists the explicitly chosen default", async () => {
    const homePath = await tempHome("strongcode-setup-default-");
    const prompts = new FakePrompter();
    prompts.multiselections.push(["openai"], ["text-embedding-3-large", "gpt-chat-test"]);
    prompts.selections.push("api-key", "enter", "gpt-chat-test", "no");
    prompts.secrets.push("openai-test-secret");
    prompts.confirmations.push(false, false);

    const result = await runSetup({}, {
      homePath,
      prompter: prompts,
      discovery: {
        fetcher: async () => new Response(JSON.stringify({
          data: [{ id: "text-embedding-3-large" }, { id: "gpt-chat-test" }]
        }), { status: 200 })
      }
    });

    expect(result.config?.agents[result.config.defaultAgent].model).toBe("gpt-chat-test");
  });

  it("disables providers deselected during forced setup and falls back to mock deliberately", async () => {
    const homePath = await tempHome("strongcode-setup-force-");
    const first = new FakePrompter();
    first.multiselections.push(["openai"], ["gpt-test"]);
    first.selections.push("api-key", "enter", "no");
    first.secrets.push("openai-test-secret");
    first.confirmations.push(false, false);
    await runSetup({}, {
      homePath,
      prompter: first,
      discovery: { fetcher: async () => new Response(JSON.stringify({ data: [{ id: "gpt-test" }] }), { status: 200 }) }
    });

    const forced = new FakePrompter();
    forced.multiselections.push([]);
    forced.confirmations.push(true, false, false);
    forced.selections.push("no");
    const result = await runSetup({ force: true }, { homePath, prompter: forced });

    expect(result.config?.providers.openai.enabled).toBe(false);
    expect(result.config?.agents[result.config.defaultAgent].model).toBe("mock");
    expect(result.state.selectedProviders).toEqual([]);
  });

  it("disables models deselected during forced setup and switches to the new provider default", async () => {
    const homePath = await tempHome("strongcode-setup-force-model-");
    const discovery = {
      fetcher: async () => new Response(JSON.stringify({ data: [{ id: "gpt-old" }, { id: "gpt-new" }] }), { status: 200 })
    };
    const first = new FakePrompter();
    first.multiselections.push(["openai"], ["gpt-old", "gpt-new"]);
    first.selections.push("api-key", "enter", "gpt-old", "no");
    first.secrets.push("openai-test-secret");
    first.confirmations.push(false, false);
    await runSetup({}, { homePath, prompter: first, discovery });

    const forced = new FakePrompter();
    forced.multiselections.push(["openai"], ["gpt-new"]);
    forced.selections.push("api-key", "existing", "no");
    forced.confirmations.push(false, false);
    const result = await runSetup({ force: true }, { homePath, prompter: forced, discovery });

    expect(result.config?.models["gpt-old"].enabled).toBe(false);
    expect(result.config?.models["gpt-new"].enabled).toBe(true);
    expect(result.config?.agents[result.config.defaultAgent].model).toBe("gpt-new");
  });

  it("does not mark an unset API-key environment variable as a configured provider", async () => {
    const homePath = await tempHome("strongcode-setup-missing-env-");
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const prompts = new FakePrompter();
    prompts.multiselections.push(["openai"]);
    prompts.selections.push("api-key", "environment", "no");
    prompts.confirmations.push(true, false, false);
    try {
      const result = await runSetup({}, { homePath, prompter: prompts });
      expect(result.config?.providers.openai.enabled).toBe(false);
      expect(result.config?.agents[result.config.defaultAgent].model).toBe("mock");
      expect(result.state.selectedProviders).toEqual([]);
      expect(prompts.output.join("\n")).toContain("OPENAI_API_KEY is not set");
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it("requires setup repair when the active environment credential disappears", async () => {
    const homePath = await tempHome("strongcode-setup-env-removed-");
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "temporary-openai-key";
    const prompts = new FakePrompter();
    prompts.multiselections.push(["openai"], ["gpt-test"]);
    prompts.selections.push("api-key", "environment", "no");
    prompts.confirmations.push(false, false);
    try {
      await runSetup({}, {
        homePath,
        prompter: prompts,
        discovery: { fetcher: async () => new Response(JSON.stringify({ data: [{ id: "gpt-test" }] }), { status: 200 }) }
      });
      expect(await shouldRunFirstSetup(homePath)).toBe(false);
      delete process.env.OPENAI_API_KEY;
      expect(await shouldRunFirstSetup(homePath)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it("repairs a completion marker whose global runtime config is no longer runnable", async () => {
    const homePath = await tempHome("strongcode-setup-repair-");
    const prompts = new FakePrompter();
    prompts.multiselections.push([]);
    prompts.confirmations.push(true, false, false);
    prompts.selections.push("no");
    await runSetup({}, { homePath, prompter: prompts });
    expect(await shouldRunFirstSetup(homePath)).toBe(false);

    await writeFile(globalConfigPath(homePath), "not: a-valid-strongcode-config\n", "utf8");
    expect(await shouldRunFirstSetup(homePath)).toBe(true);
    const retry = new FakePrompter();
    await expect(runSetup({}, { homePath, prompter: retry })).rejects.toThrow();
    expect(retry.output.join("\n")).not.toContain("harness is ready");
  });

  it("rolls back API credentials when the user cancels before setup completes", async () => {
    const homePath = await tempHome("strongcode-setup-cancel-");
    const prompts = new FakePrompter();
    prompts.multiselections.push(["openai"], ["gpt-test"]);
    prompts.selections.push("api-key", "enter");
    prompts.secrets.push("must-be-rolled-back");
    prompts.confirmations.push(false, false);
    const baseSelect = prompts.select.bind(prompts);
    prompts.select = async (message, choices) => {
      if (message.startsWith("Voice-to-text")) throw new SetupCancelledError();
      return baseSelect(message, choices);
    };

    const result = await runSetup({}, {
      homePath,
      prompter: prompts,
      discovery: { fetcher: async () => new Response(JSON.stringify({ data: [{ id: "gpt-test" }] }), { status: 200 }) }
    });

    expect(result.status).toBe("cancelled");
    await expect(readFile(path.join(homePath, "auth.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await shouldRunFirstSetup(homePath)).toBe(true);
  });
});
