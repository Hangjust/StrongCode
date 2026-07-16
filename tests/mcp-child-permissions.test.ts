import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeToolRegistry } from "../src/mcp/runtime-registry";
import { createChildExecutionPolicy } from "../src/tools/child-policy";
import { tempWorkspace } from "./helpers";

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...roots].map(root => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("MCP child permission attenuation", () => {
  it("denies an omitted nested web-search route by default for a child", async () => {
    const workspace = await tempWorkspace();
    roots.add(workspace.root);
    workspace.config.permissions.tools.web_search = "allow";
    workspace.config.permissions.tools.mcp__fixture__search = "allow";
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

      const result = await search.execute(
        { query: "must not run" },
        {
          ...workspace.context,
          taskId: `task-${crypto.randomUUID()}`,
          effectivePermissions: { web_search: "allow" }
        }
      );

      expect(result).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    } finally {
      await registry.close();
    }
  });

  it("denies a raw delegation name through the generic MCP gateway", async () => {
    const workspace = await tempWorkspace();
    roots.add(workspace.root);
    workspace.config.permissions.tools.mcp_call = "allow";
    workspace.config.permissions.tools.mcp__fixture__delegate_task = "allow";
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
        { server: "fixture", tool: "delegate_task", arguments: {} },
        {
          ...workspace.context,
          taskId: `task-${crypto.randomUUID()}`,
          effectivePermissions: {
            mcp_call: "allow",
            mcp__fixture__delegate_task: "allow"
          }
        }
      );

      expect(result).toMatchObject({ ok: false, error: { code: "NESTED_SPAWN_DENIED" } });
    } finally {
      await registry.close();
    }
  });

  it("denies a raw delegation name through a web-search provider", async () => {
    const workspace = await tempWorkspace();
    roots.add(workspace.root);
    workspace.config.permissions.tools.web_search = "allow";
    workspace.config.permissions.tools.mcp__fixture__delegate_task = "allow";
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
        providers: [{ server: "fixture", tool: "delegate_task", queryParameter: "query", enabled: true }]
      }
    }), "utf8");
    const registry = await createRuntimeToolRegistry(workspace.context);
    try {
      const search = registry.get("web_search");
      if (!search) throw new Error("web_search was not registered");

      const result = await search.execute(
        { query: "must not delegate" },
        {
          ...workspace.context,
          taskId: `task-${crypto.randomUUID()}`,
          effectivePermissions: {
            web_search: "allow",
            mcp__fixture__delegate_task: "allow"
          }
        }
      );

      expect(result).toMatchObject({ ok: false, error: { code: "NESTED_SPAWN_DENIED" } });
    } finally {
      await registry.close();
    }
  });

  it("retains the raw name on a directly registered MCP delegation tool", async () => {
    const workspace = await tempWorkspace();
    roots.add(workspace.root);
    const fixture = path.join(process.cwd(), "tests", "fixtures", "mcp-echo.cjs");
    workspace.config.permissions.tools["mcp__fixture__*"] = "allow";
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
          command: [process.execPath, fixture]
        }
      }
    }), "utf8");
    const registry = await createRuntimeToolRegistry(workspace.context);
    try {
      const direct = registry.get("mcp__fixture__delegate_task");
      if (!direct) throw new Error("direct delegation MCP tool was not registered");

      const policy = createChildExecutionPolicy({
        projectTrust: { [direct.name]: "allow" },
        parentPermissions: { [direct.name]: "allow" },
        targetCeiling: [direct.name],
        taskGrants: [direct.name],
        tools: [direct]
      });

      expect(direct.rawName).toBe("delegate_task");
      expect(policy.permissions[direct.name]).toBe("deny");
      expect(policy.tools).toEqual([]);
    } finally {
      await registry.close();
    }
  });
});
