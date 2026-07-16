#!/usr/bin/env node
import { Command } from "commander";
import { existsSync } from "node:fs";
import { copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_CONFIG_PATH, loadConfig } from "./config/load";
import { ensureStrongCodeHome } from "./config/home";
import { StrongCodeConfig } from "./config/schema";
import { StrongCodeError } from "./core/errors";
import { sanitizeTerminalLine, sanitizeTerminalMultiline } from "./core/terminal-text";
import { SessionStore } from "./sessions/session-store";
import { createRuntimeToolRegistry } from "./mcp/runtime-registry";
import { createRuntimeAuthReader } from "./models/auth-store";
import { requireRuntime, createAgent } from "./runtime/factory";
import { runTui } from "./tui/app";
import { runSetup, shouldRunFirstSetup } from "./setup/wizard";
import { resolveStrongCodeHome } from "./config/paths";
import { loadSetupState } from "./setup/state";
import type { BlenderSetupDependencies } from "./setup/blender/setup";
import { runBlenderSetupFlow } from "./setup/blender/runner";
import type { SetupPrompter } from "./setup/types";

const EXAMPLE_CONFIG = `version: 1
workspace: "."
dataDir: ".strongcode"
defaultAgent: tesla
providers:
  chatgpt:
    type: chatgpt
    displayName: ChatGPT
    enabled: false
  openai:
    type: openai
    displayName: GPT / OpenAI
    apiKeyEnv: OPENAI_API_KEY
    baseUrl: https://api.openai.com/v1
    modelsEndpoint: /models
    enabled: false
  kimi:
    type: openai-compatible
    displayName: Kimi
    apiKeyEnv: MOONSHOT_API_KEY
    baseUrl: https://api.moonshot.ai/v1
    modelsEndpoint: /models
    enabled: false
  anthropic:
    type: anthropic
    displayName: Claude
    apiKeyEnv: ANTHROPIC_API_KEY
    baseUrl: https://api.anthropic.com/v1
    modelsEndpoint: /models
    enabled: false
  grok:
    type: openai-compatible
    displayName: Grok
    apiKeyEnv: XAI_API_KEY
    baseUrl: https://api.x.ai/v1
    modelsEndpoint: /models
    enabled: false
  google:
    type: google
    displayName: Google Gemini
    apiKeyEnv: GEMINI_API_KEY
    baseUrl: https://generativelanguage.googleapis.com/v1beta
    modelsEndpoint: /models
    enabled: false
  deepseek:
    type: openai-compatible
    displayName: DeepSeek
    apiKeyEnv: DEEPSEEK_API_KEY
    baseUrl: https://api.deepseek.com
    modelsEndpoint: /models
    enabled: false
  zhipu:
    type: openai-compatible
    displayName: Z.AI / GLM
    apiKeyEnv: ZAI_API_KEY
    baseUrl: https://api.z.ai/api/paas/v4
    modelsEndpoint: /models
    enabled: false
  ollama:
    type: openai-compatible
    displayName: Ollama (local)
    baseUrl: http://127.0.0.1:11434/v1
    modelsEndpoint: /models
    allowUnauthenticated: true
    enabled: false
  lmstudio:
    type: openai-compatible
    displayName: LM Studio (local)
    baseUrl: http://127.0.0.1:1234/v1
    modelsEndpoint: /models
    allowUnauthenticated: true
    enabled: false
  vllm:
    type: openai-compatible
    displayName: vLLM (local)
    baseUrl: http://127.0.0.1:8000/v1
    modelsEndpoint: /models
    allowUnauthenticated: true
    enabled: false
  mock:
    type: mock
    displayName: Mock
    enabled: true
  custom:
    type: openai-compatible
    displayName: Custom Provider
    apiKeyEnv: CUSTOM_PROVIDER_API_KEY
    modelsEndpoint: /models
    enabled: false
agents:
  tesla:
    model: mock
    tools:
      - list_files
      - read_file
models:
  mock:
    provider: mock
    model: mock
permissions:
  tools:
    list_files: allow
    read_file: allow
`;

interface ConfigOption {
  config?: string;
}

interface RunOptions extends ConfigOption {
  session?: string;
  agent?: string;
}

export interface CliDependencies {
  readonly runSetup?: typeof runSetup;
  readonly blender?: BlenderSetupDependencies;
  readonly setupPrompter?: SetupPrompter;
  readonly homePath?: string;
  readonly workspace?: string;
  readonly isInteractive?: () => boolean;
  readonly shouldRunFirstSetup?: typeof shouldRunFirstSetup;
  readonly runTui?: typeof runTui;
  readonly reportBlenderOfferError?: (message: string) => void;
}

function printError(error: StrongCodeError): void {
  console.error(`${error.code}: ${sanitizeTerminalLine(error.message)}`);
}

function hasNonInteractiveBlenderSetupGuard(argv: string[], interactive: boolean): boolean {
  if (interactive) return false;

  let command: "setup" | "install" | undefined;
  let hasBlenderFlag = false;

  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--" || argument === "--help" || argument === "-h") {
      return false;
    }

    if (argument.startsWith("-")) {
      if (command === undefined) {
        return false;
      }
      if (argument === "--blender") {
        hasBlenderFlag = true;
        continue;
      }
      if (argument === "--force") {
        continue;
      }
      return false;
    }

    if (argument === "setup" || argument === "install") {
      if (command !== undefined) {
        return false;
      }
      command = argument;
      continue;
    }

    if (command === undefined) {
      return false;
    }

    return false;
  }

  return command !== undefined && hasBlenderFlag;
}

function configureCommanderExitHandling(command: Command): void {
  command.exitOverride(error => { throw error; });
  for (const child of command.commands) {
    configureCommanderExitHandling(child);
  }
}

async function requireCompletedSetup(configPath?: string): Promise<void> {
  if (!configPath && await shouldRunFirstSetup()) {
    throw new StrongCodeError("CONFIG_ERROR", "StrongCode setup is incomplete. Run 'strongcode setup' before using the harness.");
  }
}

export function createProgram(dependencies: CliDependencies = {}): Command {
  const program = new Command();
  program.configureOutput({
    writeOut: text => {
      process.stdout.write(sanitizeTerminalMultiline(text));
    },
    writeErr: text => {
      process.stderr.write(sanitizeTerminalMultiline(text));
    },
    outputError: (text, write) => {
      write(sanitizeTerminalMultiline(text));
    }
  });
  program.name("strongcode").description("Secure local agent harness").version("0.1.0");

  program.command("home")
    .description("Create and print the canonical StrongCode home directory")
    .option("--expand", "Update untouched StrongCode starter files to the latest core layout")
    .action(async (options: { expand?: boolean }) => {
      const home = await ensureStrongCodeHome({ expand: options.expand ?? false });
      console.log(sanitizeTerminalLine(home.path));
      if (options.expand) {
        console.log(`Created ${home.createdDirectories.length} directories and ${home.createdFiles.length} files; upgraded ${home.upgradedFiles.length} untouched starter files.`);
      }
      if (home.conflicts.length > 0) {
        for (const conflict of home.conflicts) {
          console.error(`Home conflict: ${sanitizeTerminalLine(conflict.path)} - ${sanitizeTerminalLine(conflict.reason)}`);
        }
      }
    });

  program.command("setup")
    .alias("install")
    .description("Run the secure StrongCode provider and model onboarding")
    .option("--force", "Reconfigure an already completed setup")
    .option("--blender", "Set up only the consent-gated Blender integration")
    .action(async (options: { force?: boolean; blender?: boolean }) => {
      if (!options.blender) {
        await (dependencies.runSetup ?? runSetup)({ force: options.force ?? false });
        return;
      }
      if (!(dependencies.isInteractive?.() ?? (process.stdin.isTTY === true && process.stdout.isTTY === true))) {
        throw new StrongCodeError("CONFIG_ERROR", "strongcode setup --blender requires an interactive TTY for explicit installation consent");
      }
      const homePath = path.resolve(dependencies.homePath ?? resolveStrongCodeHome());
      await ensureStrongCodeHome({ homePath });
      await runBlenderSetupFlow({
        homePath,
        workspace: path.resolve(dependencies.workspace ?? process.cwd()),
        mode: "explicit",
        force: options.force ?? false,
        prompter: dependencies.setupPrompter
      }, dependencies.blender);
    });

  program.command("init")
    .description("Create strongcode.config.yaml in the current directory")
    .action(async () => {
      const target = path.resolve(DEFAULT_CONFIG_PATH);
      if (existsSync(target)) {
        throw new StrongCodeError("CONFIG_ERROR", `${DEFAULT_CONFIG_PATH} already exists`);
      }

      const examplePath = path.resolve("strongcode.config.example.yaml");
      if (existsSync(examplePath)) {
        await copyFile(examplePath, target);
      } else {
        await writeFile(target, EXAMPLE_CONFIG, "utf8");
      }
      console.log(`Created ${DEFAULT_CONFIG_PATH}`);
    });

  const config = program.command("config").description("Manage configuration");
  config.command("validate")
    .description("Validate a config file")
    .option("--config <path>", "Path to config file (project config, otherwise StrongCode home)")
    .action(async (options: ConfigOption) => {
      const loaded = await loadConfig(options.config);
      if (!loaded.ok) {
        throw loaded.error;
      }
      console.log(`Config valid: ${sanitizeTerminalLine(loaded.value.path)}`);
    });

  const tools = program.command("tools").description("Inspect tools");
  tools.command("list")
    .description("List enabled tools for the default agent")
    .option("--config <path>", "Path to config file (project config, otherwise StrongCode home)")
    .action(async (options: ConfigOption) => {
      await requireCompletedSetup(options.config);
      const runtime = await requireRuntime(options.config);
      const registry = await createRuntimeToolRegistry(runtime.context, { allowMcp: runtime.trustedConfig });
      try {
        const agent = runtime.config.agents[runtime.config.defaultAgent];
        for (const tool of registry.resolve(agent.tools)) {
          console.log(`${sanitizeTerminalLine(tool.name)} - ${sanitizeTerminalLine(tool.description)}`);
        }
      } finally {
        await registry.close();
      }
    });

  program.command("run")
    .description("Run an agent with a prompt")
    .argument("<prompt>", "Prompt to send to the agent")
    .option("--config <path>", "Path to config file (project config, otherwise StrongCode home)")
    .option("--session <id>", "Session id", `session-${Date.now()}`)
    .option("--agent <name>", "Agent name")
    .action(async (prompt: string, options: RunOptions) => {
      await requireCompletedSetup(options.config);
      const runtime = await requireRuntime(options.config);
      const agentName = options.agent ?? runtime.config.defaultAgent;
      const authStore = createRuntimeAuthReader(runtime.authDataDir, undefined, { allowEnvironmentContent: runtime.trustedConfig });
      const agent = createAgent(runtime.config, agentName, {
        authStore,
        systemPrompt: runtime.systemPrompt,
        allowEnvironmentCredentials: runtime.trustedConfig,
        allowConfiguredSystemPrompt: runtime.trustedConfig,
        restrictToReadOnlyTools: !runtime.trustedConfig,
        workspaceRoot: runtime.context.workspaceRoot
      });
      const registry = await createRuntimeToolRegistry(runtime.context, { allowMcp: runtime.trustedConfig });
      const runner = runtime.runnerFactory.create({
        sessions: new SessionStore(runtime.context.dataDir),
        tools: registry,
        providerOptions: {
          authStore,
          allowEnvironmentCredentials: runtime.trustedConfig,
          workspaceRoot: runtime.context.workspaceRoot
        }
      });
      try {
        const result = await runner.run(agent, prompt, options.session ?? `session-${Date.now()}`);
        if (!result.ok) throw result.error;
        console.log(sanitizeTerminalMultiline(result.value.response));
      } finally {
        await runner.close();
      }
    });

  const session = program.command("session").description("Inspect sessions");
  session.command("list")
    .description("List sessions")
    .option("--config <path>", "Path to config file (project config, otherwise StrongCode home)")
    .action(async (options: ConfigOption) => {
      await requireCompletedSetup(options.config);
      const runtime = await requireRuntime(options.config);
      const result = await new SessionStore(runtime.context.dataDir).list();
      if (!result.ok) {
        throw result.error;
      }
      console.log(result.value.map(sanitizeTerminalLine).join("\n"));
    });

  session.command("show")
    .description("Show a session JSONL transcript")
    .argument("<id>", "Session id")
    .option("--config <path>", "Path to config file (project config, otherwise StrongCode home)")
    .action(async (id: string, options: ConfigOption) => {
      await requireCompletedSetup(options.config);
      const runtime = await requireRuntime(options.config);
      const result = await new SessionStore(runtime.context.dataDir).read(id);
      if (!result.ok) {
        throw result.error;
      }
      for (const event of result.value.events) {
        console.log(JSON.stringify(event, (_key: string, value: unknown): unknown => (
          typeof value === "string" ? sanitizeTerminalLine(value) : value
        )));
      }
    });

  configureCommanderExitHandling(program);
  return program;
}

export async function main(argv: string[], dependencies: CliDependencies = {}): Promise<void> {
  try {
    if (process.env.STRONGCODE_TUI_BUN === "1" && process.env.STRONGCODE_TUI_PROJECT_CWD) {
      const projectCwd = process.env.STRONGCODE_TUI_PROJECT_CWD;
      delete process.env.STRONGCODE_TUI_PROJECT_CWD;
      if (!path.isAbsolute(projectCwd)) throw new StrongCodeError("CONFIG_ERROR", "StrongCode TUI project directory must be absolute");
      process.chdir(projectCwd);
    }

    const homePath = path.resolve(dependencies.homePath ?? resolveStrongCodeHome());
    const interactive = dependencies.isInteractive?.() ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);

    if (hasNonInteractiveBlenderSetupGuard(argv, interactive)) {
      throw new StrongCodeError("CONFIG_ERROR", "strongcode setup --blender requires an interactive TTY for explicit installation consent");
    }

    await ensureStrongCodeHome({ homePath });
    const runtimeCommand = argv.length === 2 || ["run", "tools", "session"].includes(argv[2] ?? "");
    const explicitConfig = argv.some(argument => argument === "--config" || argument.startsWith("--config="));
    const needsCoreSetup = runtimeCommand
      && !explicitConfig
      && await (dependencies.shouldRunFirstSetup ?? shouldRunFirstSetup)(homePath);
    let firstRunAttemptedBlender = false;
    if (needsCoreSetup) {
      if (!interactive) {
        throw new StrongCodeError("CONFIG_ERROR", "StrongCode setup is incomplete. Run 'strongcode setup' before using the harness.");
      }
      const setup = await (dependencies.runSetup ?? runSetup)({}, {
        homePath,
        interactive,
        workspace: dependencies.workspace,
        prompter: dependencies.setupPrompter,
        blender: dependencies.blender
      });
      firstRunAttemptedBlender = true;
      if (setup.status === "cancelled") return;
    }
    if (argv.length === 2) {
      if (interactive && !explicitConfig && !firstRunAttemptedBlender) {
        const state = await loadSetupState(homePath);
        if (state.completed && !state.blender && (state.blenderOfferVersion ?? 0) < 1) {
          try {
            await runBlenderSetupFlow({
              homePath,
              workspace: path.resolve(dependencies.workspace ?? process.cwd()),
              mode: "automatic",
              prompter: dependencies.setupPrompter
            }, dependencies.blender);
          } catch {
            (dependencies.reportBlenderOfferError ?? console.error)(
              "Optional Blender setup was skipped. Run 'strongcode setup --blender' to retry with diagnostics."
            );
          }
        }
      }
      await (dependencies.runTui ?? runTui)();
      return;
    }

    const program = createProgram(dependencies);
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof StrongCodeError) {
      printError(error);
      process.exitCode = 1;
      return;
    }

    if (error instanceof Error && error.name === "CommanderError") {
      const exitCode = "exitCode" in error && typeof error.exitCode === "number" ? error.exitCode : 1;
      process.exitCode = exitCode;
      return;
    }

    throw error;
  }
}

if (require.main === module) {
  void main(process.argv);
}
