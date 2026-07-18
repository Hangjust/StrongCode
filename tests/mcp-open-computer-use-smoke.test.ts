import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureStrongCodeHome } from "../src/config/home";
import { loadMcpConfig, mcpConfigSchema } from "../src/mcp/config";
import { McpManager } from "../src/mcp/client";
import { withComputerUseEnabled } from "../src/tools/computer-use-policy";
import { createRuntimeContext } from "../src/runtime/context";
import { testConfig } from "./helpers";

const REAL_SMOKE_ENABLED = process.env.STRONGCODE_REAL_OPEN_COMPUTER_USE_SMOKE === "1";
const realSmokeIt = REAL_SMOKE_ENABLED ? it : it.skip;
const SUPPORTED_TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64"
] as const;
const EXPECTED_TOOL_NAMES = [
  "click",
  "drag",
  "get_app_state",
  "list_apps",
  "perform_secondary_action",
  "press_key",
  "scroll",
  "set_value",
  "type_text"
] as const;
const EXPECTED_COMMAND = [
  "npx",
  "--registry",
  "https://registry.npmjs.org/",
  "--yes",
  "open-computer-use@0.2.0",
  "mcp"
] as const;
const DISABLE_APP_AGENT_PROXY_ENV = "OPEN_COMPUTER_USE_DISABLE_APP_AGENT_PROXY";

function restoreEnvironment(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

describe("Open Computer Use real MCP smoke", () => {
  realSmokeIt("initializes and lists the nine canonical tools without invoking desktop control", async () => {
    // Given
    const target = `${process.platform}-${process.arch}`;
    expect(SUPPORTED_TARGETS).toContain(target);
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-open-computer-use-smoke-"));
    const homePath = path.join(root, "home");
    const npmCachePath = path.join(root, "npm-cache");
    const previousHome = process.env.STRONGCODE_HOME;
    const previousNpmCache = process.env.NPM_CONFIG_CACHE;
    const previousDisableAppAgentProxy = process.env[DISABLE_APP_AGENT_PROXY_ENV];
    process.env.STRONGCODE_HOME = homePath;
    process.env.NPM_CONFIG_CACHE = npmCachePath;
    if (process.platform === "darwin") process.env[DISABLE_APP_AGENT_PROXY_ENV] = "1";
    let manager: McpManager | undefined;

    try {
      await ensureStrongCodeHome({ homePath });
      const configPath = path.join(homePath, "strongcode.config.yaml");
      const generatedMcp = await loadMcpConfig(path.join(homePath, "mcp.json"));
      if (generatedMcp === undefined) throw new Error("Generated MCP catalog was not created");
      const generatedServer = generatedMcp.mcpServers.open_computer_use;
      if (generatedServer?.type !== "local") throw new Error("Generated Open Computer Use server is not local");
      expect(generatedServer.command).toEqual(EXPECTED_COMMAND);
      const smokeMcp = mcpConfigSchema.parse({
        ...generatedMcp,
        mcpServers: {
          ...generatedMcp.mcpServers,
          open_computer_use: {
            ...generatedServer,
            environmentFromEnv: process.platform === "darwin"
              ? [...generatedServer.environmentFromEnv, DISABLE_APP_AGENT_PROXY_ENV]
              : generatedServer.environmentFromEnv
          }
        },
        defaults: {
          ...generatedMcp.defaults,
          environment: {
            ...generatedMcp.defaults.environment,
            allowlist: [...generatedMcp.defaults.environment.allowlist, "NPM_CONFIG_CACHE"]
          }
        }
      });
      const runtimeConfig = testConfig(homePath);
      runtimeConfig.permissions.tools["mcp__open_computer_use__*"] = "allow";
      const runtimeContext = createRuntimeContext(runtimeConfig, configPath, homePath);
      manager = new McpManager(runtimeContext, smokeMcp);

      // When
      const tools = await manager.listTools("open_computer_use", withComputerUseEnabled(runtimeContext));

      // Then
      expect(tools.map(tool => tool.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
    } finally {
      try {
        await manager?.close();
      } finally {
        restoreEnvironment("STRONGCODE_HOME", previousHome);
        restoreEnvironment("NPM_CONFIG_CACHE", previousNpmCache);
        restoreEnvironment(DISABLE_APP_AGENT_PROXY_ENV, previousDisableAppAgentProxy);
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 360_000);
});
