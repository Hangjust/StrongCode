import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ensureStrongCodeHome } from "../src/config/home";
import { loadMcpConfig } from "../src/mcp/config";
import { AUDITED_READ_ONLY_TOOL_PATTERNS, DEFAULT_AGENT_TOOLS, DEFAULT_TOOL_PERMISSIONS } from "../src/tools/defaults";
import { namespacedMcpToolPattern } from "../src/mcp/names";

const DISABLE_APP_AGENT_PROXY_ENV = "OPEN_COMPUTER_USE_DISABLE_APP_AGENT_PROXY";

describe("Open Computer Use MCP catalog", () => {
  it("ships exact default catalog metadata and command for Open Computer Use", async () => {
    // Given / When / Then
    const home = await mkdtemp(path.join(tmpdir(), "strongcode-mcp-open-computer-use-catalog-"));
    try {
      await ensureStrongCodeHome({ homePath: home });
      const config = await loadMcpConfig(path.join(home, "mcp.json"));

      expect(config).toBeDefined();
      expect(config?.mcpServers.open_computer_use).toEqual({
        enabled: true,
        autoStart: false,
        type: "local",
        description: "Cross-platform desktop inspection and UI automation through Open Computer Use's bundled native runtime.",
        readOnly: false,
        workingDirectory: "config",
        inheritDefaultEnvironment: true,
        requiredFiles: [],
        requiredEnv: [],
        environmentFromEnv: [],
        timeout: { startupMs: 180000, requestMs: 120000 },
        command: ["npx", "--registry", "https://registry.npmjs.org/", "--yes", "open-computer-use@0.2.0", "mcp"]
      });
      expect(config?.mcpServers.open_computer_use).not.toHaveProperty("tokenSaver");
      expect(config?.mcpServers.open_computer_use?.type === "local"
        ? config.mcpServers.open_computer_use.environmentFromEnv
        : []).not.toContain(DISABLE_APP_AGENT_PROXY_ENV);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("enforces one unique Open Computer Use namespace with allow permission", () => {
    // Given / When / Then
    const namespace = namespacedMcpToolPattern("open_computer_use");
    const namespacedDefaults = DEFAULT_AGENT_TOOLS.filter(tool => tool.startsWith("mcp__open_computer_use__"));

    expect(namespace).toBe("mcp__open_computer_use__*");
    expect(namespacedDefaults).toEqual([namespace]);
    expect(new Set(namespacedDefaults).size).toBe(1);
    expect(DEFAULT_TOOL_PERMISSIONS[namespace]).toBe("allow");
    expect(AUDITED_READ_ONLY_TOOL_PATTERNS.has(namespace)).toBe(false);
  });
});
