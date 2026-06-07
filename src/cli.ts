#!/usr/bin/env node
import { Command } from "commander";
import { existsSync } from "node:fs";
import { copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_CONFIG_PATH, loadConfig } from "./config/load";
import { StrongCodeConfig } from "./config/schema";
import { StrongCodeError } from "./core/errors";
import { AgentRunner } from "./agents/runner";
import { SessionStore } from "./sessions/session-store";
import { createDefaultToolRegistry } from "./tools/registry";
import { ProviderAuthStore } from "./models/auth-store";
import { requireRuntime, createAgent } from "./runtime/factory";
import { runTui } from "./tui/app";

const EXAMPLE_CONFIG = `version: 1
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
    enabled: false
  grok:
    type: openai-compatible
    displayName: Grok
    apiKeyEnv: XAI_API_KEY
    baseUrl: https://api.x.ai/v1
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
    modelsEndpoint: /models
    enabled: false
agents:
  default:
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

function printError(error: StrongCodeError): void {
  console.error(`${error.code}: ${error.message}`);
}

export function createProgram(): Command {
  const program = new Command();
  program.name("strongcode").description("Minimal local agent harness").version("0.1.0");

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
    .option("--config <path>", "Path to config file", DEFAULT_CONFIG_PATH)
    .action(async (options: ConfigOption) => {
      const loaded = await loadConfig(options.config ?? DEFAULT_CONFIG_PATH);
      if (!loaded.ok) {
        throw loaded.error;
      }
      console.log(`Config valid: ${loaded.value.path}`);
    });

  const tools = program.command("tools").description("Inspect tools");
  tools.command("list")
    .description("List enabled tools for the default agent")
    .option("--config <path>", "Path to config file", DEFAULT_CONFIG_PATH)
    .action(async (options: ConfigOption) => {
      const runtime = await requireRuntime(options.config);
      const registry = createDefaultToolRegistry();
      const agent = runtime.config.agents[runtime.config.defaultAgent];
      for (const toolName of agent.tools) {
        const tool = registry.get(toolName);
        const description = tool ? tool.description : "not registered";
        console.log(`${toolName} - ${description}`);
      }
    });

  program.command("run")
    .description("Run an agent with a prompt")
    .argument("<prompt>", "Prompt to send to the agent")
    .option("--config <path>", "Path to config file", DEFAULT_CONFIG_PATH)
    .option("--session <id>", "Session id", `session-${Date.now()}`)
    .option("--agent <name>", "Agent name")
    .action(async (prompt: string, options: RunOptions) => {
      const runtime = await requireRuntime(options.config);
      const agentName = options.agent ?? runtime.config.defaultAgent;
      const agent = createAgent(runtime.config, agentName, { authStore: new ProviderAuthStore(runtime.context.dataDir) });
      const runner = new AgentRunner(runtime.context, new SessionStore(runtime.context.dataDir), createDefaultToolRegistry());
      const result = await runner.run(agent, prompt, options.session ?? `session-${Date.now()}`);
      if (!result.ok) {
        throw result.error;
      }
      console.log(result.value.response);
    });

  const session = program.command("session").description("Inspect sessions");
  session.command("list")
    .description("List sessions")
    .option("--config <path>", "Path to config file", DEFAULT_CONFIG_PATH)
    .action(async (options: ConfigOption) => {
      const runtime = await requireRuntime(options.config);
      const result = await new SessionStore(runtime.context.dataDir).list();
      if (!result.ok) {
        throw result.error;
      }
      console.log(result.value.join("\n"));
    });

  session.command("show")
    .description("Show a session JSONL transcript")
    .argument("<id>", "Session id")
    .option("--config <path>", "Path to config file", DEFAULT_CONFIG_PATH)
    .action(async (id: string, options: ConfigOption) => {
      const runtime = await requireRuntime(options.config);
      const result = await new SessionStore(runtime.context.dataDir).read(id);
      if (!result.ok) {
        throw result.error;
      }
      for (const event of result.value.events) {
        console.log(JSON.stringify(event));
      }
    });

  program.exitOverride();
  return program;
}

export async function main(argv: string[]): Promise<void> {
  if (argv.length === 2) {
    await runTui();
    return;
  }
  const program = createProgram();
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof StrongCodeError) {
      printError(error);
      process.exitCode = 1;
      return;
    }

    if (error instanceof Error && error.name === "CommanderError") {
      process.exitCode = 1;
      return;
    }

    throw error;
  }
}

if (require.main === module) {
  void main(process.argv);
}
