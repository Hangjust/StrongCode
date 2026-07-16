import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProgram, type CliDependencies } from "../src/cli";
import type { SetupChoice, SetupPrompter } from "../src/setup/types";
import { loadSetupState, saveSetupState } from "../src/setup/state";
import { ProviderAuthStore, resolveRuntimeAuthDataDir } from "../src/models/auth-store";
import { tempWorkspace, writeOpenAICompatibleTestConfig } from "./helpers";

class BlenderPrompter implements SetupPrompter {
  readonly notes: string[] = [];
  confirmCalls = 0;
  intro(message: string): void { this.notes.push(message); }
  note(message: string): void { this.notes.push(message); }
  outro(message: string): void { this.notes.push(message); }
  close(): void {}
  async select(_message: string, choices: SetupChoice[]): Promise<string> { return choices[0]?.value ?? ""; }
  async multiselect(): Promise<string[]> { return []; }
  async text(): Promise<string> { return ""; }
  async secret(): Promise<string> { return ""; }
  async confirm(): Promise<boolean> { this.confirmCalls += 1; return true; }
}

async function runCli(args: string[], dependencies: CliDependencies = {}): Promise<{ stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = createProgram(dependencies);
  program.configureOutput({
    writeOut: text => stdout.push(text),
    writeErr: text => stderr.push(text)
  });
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (message?: unknown) => stdout.push(String(message ?? ""));
  console.error = (message?: unknown) => stderr.push(String(message ?? ""));
  try {
    await program.parseAsync(["node", "strongcode", ...args]);
    return { stdout, stderr };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

describe("cli", () => {
  it("runs setup --blender without rerunning provider setup", async () => {
    const homePath = await mkdtemp(path.join(tmpdir(), "strongcode-cli-blender-"));
    const prompter = new BlenderPrompter();
    await saveSetupState(homePath, {
      schemaVersion: 2,
      completed: true,
      selectedProviders: [],
      deepSeekConfigured: false,
      gemmaConfigured: false,
      mockOnlyConfirmed: true,
      voiceToText: "no",
      blenderOfferVersion: 1
    });
    let providerSetups = 0;
    let installs = 0;
    const repairs: boolean[] = [];
    const profile = {
      profileId: "blender-cli-profile",
      executable: { canonicalPath: path.resolve("fixtures", "blender.exe"), sha256: "a".repeat(64) },
      version: "4.3.2",
      paths: {
        resources: { local: path.resolve("fixtures", "local"), system: path.resolve("fixtures", "system"), user: path.resolve("fixtures", "user") },
        config: path.resolve("fixtures", "config"),
        scripts: [path.resolve("fixtures", "scripts")]
      },
      sources: ["association" as const]
    };

    await runCli(["setup", "--blender", "--force"], {
      homePath,
      setupPrompter: prompter,
      isInteractive: () => true,
      runSetup: async () => {
        providerSetups += 1;
        throw new Error("provider setup must not run");
      },
      blender: {
        platform: "win32",
        architecture: "x64",
        discover: async () => ({
          profiles: [profile],
          selection: { kind: "selected", profileId: profile.profileId, profile },
          python: {
            executable: { canonicalPath: path.resolve("fixtures", "python.exe"), sha256: "b".repeat(64) },
            implementation: "cpython",
            version: { major: 3, minor: 11, patch: 9 },
            prefix: path.resolve("fixtures", "python"),
            pointerWidth: 64,
            sysconfigPlatform: "win_amd64"
          }
        }),
        install: async options => {
          installs += 1;
          repairs.push(options.repair ?? false);
          return { status: "installed", profileId: options.profile.profileId, receiptPath: path.join(homePath, "mcps", "blender", "installation.json") };
        }
      }
    });

    expect(providerSetups).toBe(0);
    expect(installs).toBe(1);
    expect(repairs).toEqual([true]);
  });

  it("restores missing setup metadata after explicit healthy receipt verification without prompting", async () => {
    const homePath = await mkdtemp(path.join(tmpdir(), "strongcode-cli-blender-restore-"));
    await saveSetupState(homePath, {
      schemaVersion: 2,
      completed: true,
      selectedProviders: [],
      deepSeekConfigured: false,
      gemmaConfigured: false,
      mockOnlyConfirmed: true,
      voiceToText: "no",
      blenderOfferVersion: 0
    });
    const receiptPath = path.join(homePath, "mcps", "blender", "installation.json");
    await mkdir(path.dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, "owned receipt fixture", "utf8");
    const prompter = new BlenderPrompter();
    const repairs: boolean[] = [];
    const profile = {
      profileId: "blender-restored-profile",
      executable: { canonicalPath: path.resolve("fixtures", "restored-blender.exe"), sha256: "a".repeat(64) },
      version: "4.3.2",
      paths: {
        resources: { local: path.resolve("fixtures", "restore-local"), system: path.resolve("fixtures", "restore-system"), user: path.resolve("fixtures", "restore-user") },
        config: path.resolve("fixtures", "restore-config"),
        scripts: [path.resolve("fixtures", "restore-scripts")]
      },
      sources: ["association" as const]
    };

    await runCli(["setup", "--blender"], {
      homePath,
      setupPrompter: prompter,
      isInteractive: () => true,
      blender: {
        platform: "win32",
        architecture: "x64",
        now: () => new Date("2026-07-15T12:00:00.000Z"),
        discover: async () => ({
          profiles: [profile],
          selection: { kind: "selected", profileId: profile.profileId, profile },
          python: {
            executable: { canonicalPath: path.resolve("fixtures", "python.exe"), sha256: "b".repeat(64) },
            implementation: "cpython",
            version: { major: 3, minor: 11, patch: 9 },
            prefix: path.resolve("fixtures", "python"),
            pointerWidth: 64,
            sysconfigPlatform: "win_amd64"
          }
        }),
        install: async options => {
          repairs.push(options.repair ?? false);
          return { status: "already-installed", profileId: options.profile.profileId, receiptPath };
        }
      }
    });

    expect(prompter.confirmCalls).toBe(0);
    expect(repairs).toEqual([false]);
    expect(prompter.notes.join("\n")).toContain("StrongCode Blender integration is already installed, enabled, and verification passed.");
    expect(await loadSetupState(homePath)).toMatchObject({
      blenderOfferVersion: 1,
      blender: {
        profileId: profile.profileId,
        receiptPath,
        installedAt: "2026-07-15T12:00:00.000Z"
      }
    });
  });

  it("fails setup --blender closed in a non-TTY before discovery or installation", async () => {
    let discoveries = 0;
    let installs = 0;

    await expect(runCli(["setup", "--blender"], {
      isInteractive: () => false,
      blender: {
        discover: async () => {
          discoveries += 1;
          return { profiles: [], selection: { kind: "none" } };
        },
        install: async options => {
          installs += 1;
          return { status: "installed", profileId: options.profile.profileId, receiptPath: "unused" };
        }
      }
    })).rejects.toThrow("requires an interactive TTY");

    expect(discoveries).toBe(0);
    expect(installs).toBe(0);
  });

  it("blocks runtime commands until first-run setup is complete unless a config is explicit", async () => {
    const homePath = await mkdtemp(path.join(tmpdir(), "strongcode-cli-unconfigured-"));
    const previousHome = process.env.STRONGCODE_HOME;
    try {
      process.env.STRONGCODE_HOME = homePath;
      await expect(runCli(["run", "hello"])).rejects.toThrow("StrongCode setup is incomplete");
    } finally {
      if (previousHome === undefined) delete process.env.STRONGCODE_HOME;
      else process.env.STRONGCODE_HOME = previousHome;
    }
  });

  it("validates config, lists tools, runs hello, and shows a session", async () => {
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
      - read_file
models:
  mock:
    provider: mock
permissions:
  tools:
    list_files: allow
    read_file: allow
`, "utf8");

    const validate = await runCli(["config", "validate", "--config", configPath]);
    const tools = await runCli(["tools", "list", "--config", configPath]);
    const run = await runCli(["run", "hello", "--config", configPath, "--session", "smoke"]);
    const builtIn = await runCli(["run", "hello", "--config", configPath, "--agent", "Sisyphus", "--session", "tesla-smoke"]);
    const session = await runCli(["session", "show", "smoke", "--config", configPath]);

    expect(validate.stdout.join("")).toContain("Config valid");
    expect(tools.stdout.join("")).toContain("list_files");
    expect(run.stdout.join("")).toContain("Mock response: hello");
    expect(builtIn.stdout.join("")).toContain("Mock response: hello");
    expect(session.stdout.join("")).toContain("hello");
    
    // Verify TUI header is not printed
    expect(validate.stdout.join("")).not.toContain("StrongCode");
  });

  it("runs OpenAI-compatible models with auth.json credentials", async () => {
    const workspace = await tempWorkspace();
    const homePath = await mkdtemp(path.join(tmpdir(), "strongcode-cli-auth-home-"));
    const previousHome = process.env.STRONGCODE_HOME;
    process.env.STRONGCODE_HOME = homePath;
    const configPath = path.join(workspace.root, "strongcode.config.yaml");
    await writeFile(configPath, `version: 1
workspace: "."
dataDir: ".strongcode"
defaultAgent: default
providers:
  custom:
    type: openai-compatible
    displayName: Custom Provider
    apiKeyEnv: STRONGCODE_TEST_API_KEY
    baseUrl: https://example.com/v1
    modelsEndpoint: /models
    enabled: true
agents:
  default:
    model: custom-model
    tools: []
models:
  custom-model:
    provider: custom
    model: provider-model
    enabled: true
permissions:
  tools: {}
`, "utf8");
    await new ProviderAuthStore(resolveRuntimeAuthDataDir(configPath, workspace.context.dataDir, homePath))
      .set("custom", { type: "api", key: "auth-json-key" });

    const originalApiKey = process.env.STRONGCODE_TEST_API_KEY;
    const originalFetch = globalThis.fetch;
    const calls: Array<{ authorization: string | undefined }> = [];
    delete process.env.STRONGCODE_TEST_API_KEY;
    globalThis.fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({ authorization: headers.get("authorization") ?? undefined });
      return new Response(JSON.stringify({ choices: [{ message: { content: "auth store response" } }] }), { status: 200 });
    };

    try {
      const run = await runCli(["run", "hello", "--config", configPath, "--session", "auth-json"]);

      expect(run.stdout.join("")).toContain("auth store response");
      expect(calls).toEqual([{ authorization: "Bearer auth-json-key" }]);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalApiKey === undefined) delete process.env.STRONGCODE_TEST_API_KEY;
      else process.env.STRONGCODE_TEST_API_KEY = originalApiKey;
      if (previousHome === undefined) delete process.env.STRONGCODE_HOME;
      else process.env.STRONGCODE_HOME = previousHome;
    }
  });

  it("prints only final content from OpenAI-compatible reasoning responses", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-cli-reasoning-"));
    const configPath = await writeOpenAICompatibleTestConfig(root);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: "Final answer", reasoning_content: "Private reasoning" } }]
    }), { status: 200 });

    try {
      const run = await runCli(["run", "hello", "--config", configPath, "--session", "reasoning-output"]);
      const stdout = run.stdout.join("");
      const session = await readFile(path.join(root, ".strongcode", "sessions", "reasoning-output.jsonl"), "utf8");

      expect(stdout).toBe("Final answer");
      expect(stdout).not.toContain("Private reasoning");
      expect(stdout).not.toContain("[+] Reasoning");
      expect(stdout).not.toContain("[-] Reasoning");
      expect(session).toContain("Final answer");
      expect(session).not.toContain("Private reasoning");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
