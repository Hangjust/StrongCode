import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { ensureStrongCodeHome } from "../src/config/home";
import { loadMcpConfig, mcpConfigSchema } from "../src/mcp/config";
import { createRuntimeToolRegistry } from "../src/mcp/runtime-registry";
import { createOAuthCallbackServer } from "../src/mcp/oauth";
import { DEFAULT_AGENT_TOOLS, DEFAULT_TOOL_PERMISSIONS } from "../src/tools/defaults";
import { namespacedMcpToolName } from "../src/mcp/names";
import { withComputerUseEnabled } from "../src/tools/computer-use-policy";
import { tempWorkspace } from "./helpers";

const roots = new Set<string>();

async function mcpHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "strongcode-mcp-home-"));
  roots.add(home);
  return home;
}

async function trackedWorkspace(): Promise<Awaited<ReturnType<typeof tempWorkspace>>> {
  const workspace = await tempWorkspace();
  roots.add(workspace.root);
  return workspace;
}

afterEach(async () => {
  await Promise.all([...roots].map(root => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("MCP runtime", () => {
  it("ships a valid default MCP catalog without literal credentials", async () => {
    // Given / When / Then a default home layout is generated and loaded
    const home = await mcpHome();
    await ensureStrongCodeHome({ homePath: home });
    const config = await loadMcpConfig(path.join(home, "mcp.json"));

    // Given / When / Then: the shipped MCP catalog defaults are exact and safe
    expect(config).toBeDefined();
    expect(config?.mcpServers.playwright).toEqual({
      enabled: true,
      autoStart: false,
      type: "local",
      description: "Isolated headless browser automation through Microsoft's Playwright MCP.",
      readOnly: false,
      workingDirectory: "config",
      inheritDefaultEnvironment: true,
      requiredFiles: [],
      requiredEnv: [],
      environmentFromEnv: [],
      timeout: { startupMs: 60000, requestMs: 60000 },
      command: ["npx", "--registry", "https://registry.npmjs.org/", "-y", "@playwright/mcp@0.0.78", "--headless", "--isolated", "--block-service-workers", "--image-responses", "omit", "--output-dir", "cache/playwright-mcp"]
    });
    expect(config?.mcpServers.playwright).not.toHaveProperty("tokenSaver");
    expect(config?.mcpServers.chrome_devtools).toEqual({
      enabled: true,
      autoStart: false,
      type: "local",
      description: "Isolated headless Chrome debugging and performance analysis through Chrome DevTools MCP.",
      readOnly: false,
      workingDirectory: "config",
      inheritDefaultEnvironment: true,
      requiredFiles: [],
      requiredEnv: [],
      environmentFromEnv: [],
      timeout: { startupMs: 60000, requestMs: 60000 },
      command: ["npx", "--registry", "https://registry.npmjs.org/", "-y", "chrome-devtools-mcp@1.6.0", "--headless", "--isolated", "--no-usage-statistics", "--no-performance-crux"]
    });
    expect(config?.mcpServers.chrome_devtools).not.toHaveProperty("tokenSaver");
    expect(config?.defaults.environment.allowlist).toEqual(["PATH", "HOME", "USERPROFILE", "LANG", "LC_ALL", "TERM", "TMP", "TEMP"]);

    // Then: base server presence and security checks still hold
    expect(config?.mcpServers.context7.enabled).toBe(true);
    expect(config?.mcpServers.grep_app.enabled).toBe(true);
    expect(config?.mcpServers.exa.enabled).toBe(true);
    expect(config?.mcpServers.tinyfish.enabled).toBe(true);
    expect(config?.webSearch.providers.filter(provider => provider.enabled).map(provider => provider.server)).toEqual(["exa", "tinyfish"]);
    expect(JSON.stringify(config)).not.toMatch(/(?:apiKey|token)\s*[:=]\s*["'][^"']+/i);
  });

  it("rejects literal child environment maps", () => {
    const parsed = mcpConfigSchema.safeParse({
      version: 1,
      mcpServers: {
        unsafe: { type: "local", command: ["node"], env: { API_KEY: "secret" } }
      }
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects MCP server IDs with colliding normalized namespaces", () => {
    const parsed = mcpConfigSchema.safeParse({
      version: 1,
      mcpServers: {
        "fixture.echo": { type: "local", command: ["node"] },
        fixture_echo: { type: "local", command: ["node"] }
      }
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map(issue => issue.message).join("\n")).toContain("normalized namespace");
    }
  });

  it("keeps namespaced MCP tool names within provider limits", () => {
    // Given / When / Then: namespace generation and default permissions stay aligned
    const name = namespacedMcpToolName("very-long-server-name-".repeat(4), "very-long-tool-name-".repeat(4));
    expect(namespacedMcpToolName("chrome_devtools", "click")).toBe("mcp__chrome_devtools__click");
    expect(DEFAULT_AGENT_TOOLS.filter(tool => tool === "mcp__chrome_devtools__*")).toHaveLength(1);
    expect(DEFAULT_TOOL_PERMISSIONS["mcp__chrome_devtools__*"]).toBe("allow");
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toMatch(/^[a-z0-9_-]+$/);
  });

  it("denies generic MCP calls when the nested namespaced tool is denied", async () => {
    const workspace = await trackedWorkspace();
    workspace.config.permissions.tools.mcp_call = "allow";
    workspace.config.permissions.tools.mcp__fixture__echo = "deny";
    await writeFile(path.join(workspace.root, "mcp.json"), JSON.stringify({
      version: 1,
      mcpServers: {
        fixture: {
          enabled: true,
          autoStart: false,
          type: "local",
          command: ["strongcode-command-that-must-not-run"]
        }
      }
    }), "utf8");

    const registry = await createRuntimeToolRegistry(workspace.context);
    try {
      const gateway = registry.get("mcp_call");
      if (!gateway) throw new Error("mcp_call was not registered");

      const result = await gateway.execute({ server: "fixture", tool: "echo", arguments: {} }, workspace.context);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("PERMISSION_DENIED");
    } finally {
      await registry.close();
    }
  });

  it("applies child effective permissions to nested generic MCP calls", async () => {
    const workspace = await trackedWorkspace();
    workspace.config.permissions.tools.mcp_call = "allow";
    workspace.config.permissions.tools.mcp__fixture__echo = "allow";
    await writeFile(path.join(workspace.root, "mcp.json"), JSON.stringify({
      version: 1,
      mcpServers: {
        fixture: {
          enabled: true,
          autoStart: false,
          type: "local",
          command: ["strongcode-command-that-must-not-run"]
        }
      }
    }), "utf8");
    const registry = await createRuntimeToolRegistry(workspace.context);
    try {
      const gateway = registry.get("mcp_call");
      if (!gateway) throw new Error("mcp_call was not registered");

      const result = await gateway.execute(
        { server: "fixture", tool: "echo", arguments: {} },
        {
          ...workspace.context,
          taskId: `task-${crypto.randomUUID()}`,
          effectivePermissions: { mcp_call: "allow", mcp__fixture__echo: "deny" }
        }
      );

      expect(result).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    } finally {
      await registry.close();
    }
  });

  it("keeps unknown and disabled safe MCP targets as tool errors", async () => {
    // Given
    const workspace = await trackedWorkspace();
    workspace.config.permissions.tools["mcp__unknown_safe__*"] = "allow";
    workspace.config.permissions.tools["mcp__disabled_safe__*"] = "allow";
    await writeFile(path.join(workspace.root, "mcp.json"), JSON.stringify({
      version: 1,
      mcpServers: {
        disabled_safe: {
          enabled: false,
          autoStart: false,
          type: "local",
          command: ["strongcode-command-that-must-not-run"]
        }
      }
    }), "utf8");
    const registry = await createRuntimeToolRegistry(workspace.context);

    try {
      const listGateway = registry.get("mcp_list_tools");
      const callGateway = registry.get("mcp_call");
      if (!listGateway || !callGateway) throw new Error("MCP gateway tools were not registered");

      // When
      const results = await Promise.all([
        listGateway.execute({ server: "unknown_safe" }, workspace.context),
        callGateway.execute({ server: "unknown_safe", tool: "echo", arguments: {} }, workspace.context),
        listGateway.execute({ server: "disabled_safe" }, workspace.context),
        callGateway.execute({ server: "disabled_safe", tool: "echo", arguments: {} }, workspace.context)
      ]);

      // Then
      for (const result of results) {
        expect(result).toMatchObject({ ok: false, error: { code: "TOOL_ERROR" } });
      }
    } finally {
      await registry.close();
    }
  });

  it("denies web-search routes whose nested MCP tool is denied", async () => {
    const workspace = await trackedWorkspace();
    workspace.config.permissions.tools.web_search = "allow";
    workspace.config.permissions.tools.mcp__fixture__search = "deny";
    await writeFile(path.join(workspace.root, "mcp.json"), JSON.stringify({
      version: 1,
      mcpServers: {
        fixture: {
          enabled: true,
          autoStart: false,
          type: "local",
          command: ["strongcode-command-that-must-not-run"]
        }
      },
      webSearch: {
        providers: [{ server: "fixture", tool: "search", queryParameter: "query", enabled: true }]
      }
    }), "utf8");
    const registry = await createRuntimeToolRegistry(workspace.context);
    try {
      const search = registry.get("web_search");
      if (!search) throw new Error("web_search was not registered");

      const result = await search.execute({ query: "must not run" }, workspace.context);

      expect(result).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    } finally {
      await registry.close();
    }
  });

  it("builds fresh immutable web-search descriptions in configured visible fallback order", async () => {
    // Given
    const workspace = await trackedWorkspace();
    await writeFile(path.join(workspace.root, "mcp.json"), JSON.stringify({
      version: 1,
      mcpServers: {
        open_computer_use: {
          enabled: true,
          autoStart: false,
          type: "local",
          command: ["ocu-package-must-not-launch"]
        },
        safe_alpha: {
          enabled: true,
          autoStart: false,
          type: "local",
          command: ["safe-alpha-must-not-launch"]
        },
        safe_zeta: {
          enabled: true,
          autoStart: false,
          type: "local",
          command: ["safe-zeta-must-not-launch"]
        }
      },
      webSearch: {
        providers: [
          { server: "open_computer_use", tool: "search", queryParameter: "query", enabled: true },
          { server: "safe_zeta", tool: "search", queryParameter: "query", enabled: true },
          { server: "safe_alpha", tool: "search", queryParameter: "query", enabled: true }
        ]
      }
    }), "utf8");
    const registry = await createRuntimeToolRegistry(workspace.context);

    try {
      const search = registry.get("web_search");
      if (!search) throw new Error("web_search was not registered");

      // When
      const ordinaryView = search.modelView?.(workspace.context);
      const repeatedOrdinaryView = search.modelView?.(workspace.context);
      const explicitView = search.modelView?.(withComputerUseEnabled(workspace.context));

      // Then
      expect(ordinaryView?.description).toBe(
        "Search the current web with automatic provider fallback (safe_zeta -> safe_alpha)."
      );
      expect(explicitView?.description).toBe(
        "Search the current web with automatic provider fallback (open_computer_use -> safe_zeta -> safe_alpha)."
      );
      expect(repeatedOrdinaryView).not.toBe(ordinaryView);
      expect(Object.isFrozen(ordinaryView)).toBe(true);
      expect(Object.isFrozen(repeatedOrdinaryView)).toBe(true);
      expect(Object.isFrozen(explicitView)).toBe(true);
    } finally {
      await registry.close();
    }
  });

  it("calls stdio MCP tools through direct and permitted generic routes plus the web fallback route", async () => {
    const workspace = await trackedWorkspace();
    const fixture = path.join(process.cwd(), "tests", "fixtures", "mcp-echo.cjs");
    workspace.config.permissions.tools.mcp_call = "allow";
    workspace.config.permissions.tools["mcp__fixture__*"] = "allow";
    workspace.config.permissions.tools["mcp__desktop_control__*"] = "allow";
    workspace.config.permissions.tools.mcp__fixture__echo = "allow";
    workspace.config.permissions.tools.mcp__fixture__search = "allow";
    await writeFile(path.join(workspace.root, "mcp.json"), JSON.stringify({
      version: 1,
      defaults: {
        autoStart: false,
        timeout: { startupMs: 5000, requestMs: 5000 },
        environment: { inherit: false, allowlist: ["PATH", "HOME", "USERPROFILE", "TEMP", "TMP"] }
      },
      mcpServers: {
        fixture: {
          enabled: true,
          autoStart: true,
          type: "local",
          readOnly: true,
          command: [process.execPath, fixture]
        },
        desktop_control: {
          enabled: true,
          autoStart: true,
          type: "local",
          readOnly: false,
          command: [process.execPath, fixture, "open-computer-use@0.2.0"]
        }
      },
      webSearch: {
        providers: [{ server: "fixture", tool: "search", queryParameter: "query", enabled: true }]
      }
    }), "utf8");

    const registry = await createRuntimeToolRegistry(workspace.context);
    try {
      const listGateway = registry.get("mcp_list_tools");
      const gateway = registry.get("mcp_call");
      if (!listGateway || !gateway) throw new Error("MCP gateway tools were not registered");
      const ordinaryViews = [
        listGateway.modelView?.(workspace.context),
        gateway.modelView?.(workspace.context)
      ];
      const explicitContext = withComputerUseEnabled(workspace.context);
      const explicitViews = [
        listGateway.modelView?.(explicitContext),
        gateway.modelView?.(explicitContext)
      ];
      expect(JSON.stringify(ordinaryViews)).not.toContain("desktop_control");
      for (const view of ordinaryViews) {
        expect(view?.description).toContain("fixture");
        expect(view?.inputJsonSchema).toMatchObject({
          properties: { server: { enum: ["fixture"] } }
        });
      }
      for (const view of explicitViews) {
        expect(view?.description).toContain("desktop_control, fixture");
        expect(view?.inputJsonSchema).toMatchObject({
          properties: { server: { enum: ["desktop_control", "fixture"] } }
        });
      }
      const repeatedView = gateway.modelView?.(workspace.context);
      expect(repeatedView).not.toBe(ordinaryViews[1]);
      expect(repeatedView?.inputJsonSchema).not.toBe(ordinaryViews[1]?.inputJsonSchema);
      expect(registry.get("mcp__desktop_control__echo")).toBeUndefined();

      const direct = registry.get("mcp__fixture__echo");
      expect(direct?.description).toContain("Echo input");
      expect(direct?.inputJsonSchema).toMatchObject({ required: ["value"] });
      if (!direct) throw new Error("direct MCP tool was not registered");
      const echoed = await direct.execute({ value: "hello" }, workspace.context);
      expect(echoed).toMatchObject({ ok: true, value: { content: "hello" } });

      const gatewayEchoed = await gateway.execute({ server: "fixture", tool: "echo", arguments: { value: "gateway" } }, workspace.context);
      expect(gatewayEchoed).toMatchObject({ ok: true, value: { content: "gateway" } });

      const search = registry.get("web_search");
      if (!search) throw new Error("web_search was not registered");
      const searched = await search.execute({ query: "current docs" }, workspace.context);
      expect(registry.get("web_search")?.effect).toBe("unclassified");
      expect(searched).toMatchObject({ ok: true });
      if (searched.ok) expect(searched.value.content).toContain("result:current docs");
    } finally {
      await registry.close();
    }
  });

  it("accepts OAuth loopback callbacks only when state matches", async () => {
    const callback = await createOAuthCallbackServer();
    try {
      const code = callback.waitForCode("expected-state", 5000);
      const response = await fetch(`${callback.redirectUrl}?code=test-code&state=expected-state`);
      expect(response.ok).toBe(true);
      await expect(code).resolves.toBe("test-code");
    } finally {
      await callback.close();
    }
  });
});
