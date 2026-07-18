import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { strongCodeConfigSchema } from "../src/config/schema";
import { createRuntimeContext } from "../src/runtime/context";
import { mcpConfigSchema } from "../src/mcp/config";
import { createRuntimeToolRegistry } from "../src/mcp/runtime-registry";
import { planBlenderPermissionsSource } from "../src/setup/blender/config-merge";
import { AUDITED_READ_ONLY_TOOL_PATTERNS } from "../src/tools/defaults";
import { getToolPermission } from "../src/tools/permissions";
import type { ToolRegistry } from "../src/tools/registry";
import type { Tool } from "../src/tools/tool";
import { tempWorkspace, testConfig } from "./helpers";

const fixture = path.join(process.cwd(), "tests", "fixtures", "mcp-echo.cjs");
const roots = new Set<string>();

type FixtureOptions = {
  readonly marker: string;
  readonly autoStart?: boolean;
  readonly workingDirectory?: "workspace" | "config";
};

async function trackedWorkspace(): Promise<Awaited<ReturnType<typeof tempWorkspace>>> {
  const workspace = await tempWorkspace();
  roots.add(workspace.root);
  return workspace;
}

async function writeFixtureConfig(configDirectory: string, options: FixtureOptions): Promise<void> {
  const workingDirectory = options.workingDirectory === undefined
    ? {}
    : { workingDirectory: options.workingDirectory };
  await writeFile(path.join(configDirectory, "mcp.json"), JSON.stringify({
    version: 1,
    defaults: {
      autoStart: false,
      timeout: { startupMs: 5000, requestMs: 5000 }
    },
    mcpServers: {
      fixture: {
        enabled: true,
        autoStart: options.autoStart ?? false,
        type: "local",
        command: [process.execPath, fixture, options.marker],
        ...workingDirectory
      }
    }
  }), "utf8");
}

function requireDiscoveryTool(registry: ToolRegistry): Tool {
  const tool = registry.get("mcp_list_tools");
  if (!tool) throw new Error("mcp_list_tools was not registered");
  return tool;
}

async function expectMarkerMissing(marker: string): Promise<void> {
  await expect.soft(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
}

afterEach(async () => {
  await Promise.all([...roots].map(root => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("MCP startup security", () => {
  it("keeps every official Blender MCP tool at ask while preserving a managed deny", () => {
    // Given
    const config = testConfig(process.cwd());
    const source = YAML.stringify(config);
    const launch = {
      flavor: "official",
      pythonPath: path.resolve("private", "python"),
      launcherPath: path.resolve("private", "official-blender-mcp.py"),
      privateConfigPath: path.resolve("private", "official.json")
    } as const;

    // When
    const planned = planBlenderPermissionsSource(source, launch);
    const parsed = strongCodeConfigSchema.parse(YAML.parse(planned.content));
    const arbitrary = getToolPermission(parsed, "mcp__blender__render_scene");
    const execute = getToolPermission(parsed, "mcp__blender__execute_blender_code");
    parsed.permissions.tools["mcp__blender__render_scene"] = "deny";

    // Then
    expect(arbitrary).toBe("ask");
    expect(execute).toBe("ask");
    expect(getToolPermission(parsed, "mcp__blender__render_scene")).toBe("deny");
  });

  it("classifies MCP discovery as spawning rather than audited read-only work", async () => {
    // Given
    const workspace = await trackedWorkspace();
    await writeFile(path.join(workspace.root, "mcp.json"), JSON.stringify({ version: 1 }), "utf8");

    // When
    const registry = await createRuntimeToolRegistry(workspace.context);
    try {
      const discovery = requireDiscoveryTool(registry);

      // Then
      expect.soft(discovery.readOnly).toBe(false);
      expect.soft(AUDITED_READ_ONLY_TOOL_PATTERNS.has("mcp_list_tools")).toBe(false);
    } finally {
      await registry.close();
    }
  });

  it("denies explicit discovery before a globally denied MCP namespace starts", async () => {
    // Given
    const workspace = await trackedWorkspace();
    const marker = path.join(workspace.root, "explicit-denied.cwd");
    workspace.config.permissions.tools.mcp_list_tools = "allow";
    workspace.config.permissions.tools["mcp__fixture__*"] = "deny";
    await writeFixtureConfig(workspace.root, { marker });
    const registry = await createRuntimeToolRegistry(workspace.context);
    try {
      // When
      const result = await requireDiscoveryTool(registry).execute({ server: "fixture" }, workspace.context);

      // Then
      expect.soft(result).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
      await expectMarkerMissing(marker);
    } finally {
      await registry.close();
    }
  });

  it("enforces an effective wildcard denial during explicit discovery", async () => {
    // Given
    const workspace = await trackedWorkspace();
    const marker = path.join(workspace.root, "effective-denied.cwd");
    workspace.config.permissions.tools["*"] = "allow";
    await writeFixtureConfig(workspace.root, { marker });
    const registry = await createRuntimeToolRegistry(workspace.context);
    try {
      // When
      const result = await requireDiscoveryTool(registry).execute(
        { server: "fixture" },
        {
          ...workspace.context,
          effectivePermissions: {
            mcp_list_tools: "allow",
            "mcp__fixture__*": "deny"
          }
        }
      );

      // Then
      expect.soft(result).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
      await expectMarkerMissing(marker);
    } finally {
      await registry.close();
    }
  });

  it("does not auto-start or register a globally denied MCP namespace", async () => {
    // Given
    const workspace = await trackedWorkspace();
    const marker = path.join(workspace.root, "autostart-denied.cwd");
    workspace.config.permissions.tools.mcp_list_tools = "allow";
    workspace.config.permissions.tools["mcp__fixture__*"] = "deny";
    await writeFixtureConfig(workspace.root, { marker, autoStart: true });

    // When
    const registry = await createRuntimeToolRegistry(workspace.context);
    try {
      // Then
      await expectMarkerMissing(marker);
      expect(registry.get("mcp__fixture__echo")).toBeUndefined();
    } finally {
      await registry.close();
    }
  });

  it("uses the canonical workspace root when workingDirectory is omitted", async () => {
    // Given
    const workspace = await trackedWorkspace();
    const marker = path.join(workspace.root, "workspace-default.cwd");
    workspace.config.permissions.tools.mcp_list_tools = "allow";
    workspace.config.permissions.tools["mcp__fixture__*"] = "allow";
    await writeFixtureConfig(workspace.root, { marker });
    const registry = await createRuntimeToolRegistry(workspace.context);
    try {
      // When
      const result = await requireDiscoveryTool(registry).execute({ server: "fixture" }, workspace.context);

      // Then
      expect(result.ok).toBe(true);
      await expect(readFile(marker, "utf8")).resolves.toBe(await realpath(workspace.context.workspaceRoot));
    } finally {
      await registry.close();
    }
  });

  it("uses the runtime config directory for the config working-directory policy", async () => {
    // Given
    const workspace = await trackedWorkspace();
    const configDirectory = path.join(workspace.root, "config");
    const workspaceRoot = path.join(workspace.root, "workspace");
    await Promise.all([mkdir(configDirectory), mkdir(workspaceRoot)]);
    const configPath = path.join(configDirectory, "strongcode.config.yaml");
    await writeFile(configPath, "version: 1\n", "utf8");
    const config = testConfig(workspaceRoot);
    config.workspace = workspaceRoot;
    config.permissions.tools.mcp_list_tools = "allow";
    config.permissions.tools["mcp__fixture__*"] = "allow";
    const context = createRuntimeContext(config, configPath, configDirectory);
    const marker = path.join(workspace.root, "config-policy.cwd");
    await writeFixtureConfig(configDirectory, { marker, workingDirectory: "config" });
    const registry = await createRuntimeToolRegistry(context);
    try {
      // When
      const result = await requireDiscoveryTool(registry).execute({ server: "fixture" }, context);

      // Then
      expect(result.ok).toBe(true);
      await expect(readFile(marker, "utf8")).resolves.toBe(path.dirname(configPath));
    } finally {
      await registry.close();
    }
  });

  it("accepts bounded local working-directory policies and rejects other placements", () => {
    // Given
    const localServer = { type: "local", command: ["node"] };

    // When
    const workspace = mcpConfigSchema.safeParse({
      version: 1,
      mcpServers: { fixture: { ...localServer, workingDirectory: "workspace" } }
    });
    const config = mcpConfigSchema.safeParse({
      version: 1,
      mcpServers: { fixture: { ...localServer, workingDirectory: "config" } }
    });
    const traversal = mcpConfigSchema.safeParse({
      version: 1,
      mcpServers: { fixture: { ...localServer, workingDirectory: ".." } }
    });
    const remote = mcpConfigSchema.safeParse({
      version: 1,
      mcpServers: { fixture: { type: "remote", url: "https://example.com/mcp", workingDirectory: "config" } }
    });

    // Then
    expect.soft(workspace.success).toBe(true);
    expect.soft(config.success).toBe(true);
    expect.soft(traversal.success).toBe(false);
    expect.soft(remote.success).toBe(false);
  });
});
