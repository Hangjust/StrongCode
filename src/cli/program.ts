import { Command } from "commander";
import { existsSync } from "node:fs";
import { copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureStrongCodeHome } from "../config/home";
import { DEFAULT_CONFIG_PATH, loadConfig } from "../config/load";
import { resolveStrongCodeHome } from "../config/paths";
import { StrongCodeError } from "../core/errors";
import { sanitizeTerminalLine, sanitizeTerminalMultiline } from "../core/terminal-text";
import { createRuntimeToolRegistry } from "../mcp/runtime-registry";
import { createRuntimeAuthReader } from "../models/auth-store";
import { createAgent, requireRuntime } from "../runtime/factory";
import { SessionStore } from "../sessions/session-store";
import { runBlenderSetupFlow } from "../setup/blender/runner";
import { runSetup, shouldRunFirstSetup } from "../setup/wizard";
import { EXAMPLE_CONFIG } from "./example-config";
import type { CliDependencies } from "./types";

interface ConfigOption {
  config?: string;
}

interface RunOptions extends ConfigOption {
  session?: string;
  agent?: string;
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
        const preservedFiles = home.preservedFiles.map(sanitizeTerminalLine).sort();
        const preservedSuffix = preservedFiles.length > 0
          ? `; preserved customized starter files: ${preservedFiles.join(", ")}`
          : "";
        console.log(`Created ${home.createdDirectories.length} directories and ${home.createdFiles.length} files; upgraded ${home.upgradedFiles.length} untouched starter files${preservedSuffix}.`);
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
