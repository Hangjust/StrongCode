import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpManager } from "../src/mcp/client";
import {
  isOpenComputerUseServer,
  mcpServerVisibleInTurn,
  visibleMcpServerIds
} from "../src/mcp/computer-use-server";
import { mcpConfigSchema, type McpConfig } from "../src/mcp/config";
import { withComputerUseEnabled } from "../src/tools/computer-use-policy";
import { tempWorkspace } from "./helpers";

const roots = new Set<string>();

async function trackedWorkspace(): Promise<Awaited<ReturnType<typeof tempWorkspace>>> {
  const workspace = await tempWorkspace();
  roots.add(workspace.root);
  return workspace;
}

afterEach(async () => {
  await Promise.all([...roots].map(root => rm(root, { recursive: true, force: true })));
  roots.clear();
});

function canonicalComputerUseConfig(): McpConfig {
  return mcpConfigSchema.parse({
    version: 1,
    mcpServers: {
      open_computer_use: {
        enabled: true,
        autoStart: true,
        type: "local",
        command: ["strongcode-command-that-must-not-run"]
      }
    }
  });
}

function safeServerConfig(): McpConfig {
  return mcpConfigSchema.parse({
    version: 1,
    mcpServers: {
      safe_zeta: {
        enabled: true,
        type: "local",
        command: ["safe-zeta-command"]
      },
      safe_alpha: {
        enabled: true,
        type: "local",
        command: ["safe-alpha-command"]
      },
      safe_disabled: {
        enabled: false,
        type: "local",
        command: ["disabled-command"]
      }
    }
  });
}

function contextualServerConfig(serverId: string, command: readonly string[]): McpConfig {
  return mcpConfigSchema.parse({
    version: 1,
    mcpServers: {
      safe_server: {
        enabled: true,
        type: "local",
        command: ["safe-command"]
      },
      open_computer_use_docs: {
        enabled: true,
        type: "local",
        command: ["npx", "open-computer-use-helper@0.2.0"]
      },
      disabled_control: {
        enabled: false,
        type: "local",
        command: ["npx", "open-computer-use@0.2.0", "mcp"]
      },
      [serverId]: {
        enabled: true,
        type: "local",
        command: [...command]
      }
    }
  });
}

describe("Computer Use MCP server", () => {
  it("denies an ordinary canonical connection before launch", async () => {
    // Given
    const workspace = await trackedWorkspace();
    const manager = new McpManager(workspace.context, canonicalComputerUseConfig());

    // When
    const connection = manager.connect("open_computer_use");

    // Then
    await expect(connection).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      message: "Open Computer Use requires an explicit request in the current user turn or /computer use"
    });
  });

  it("does not attempt canonical Computer Use during automatic startup", async () => {
    // Given
    const workspace = await trackedWorkspace();
    const manager = new McpManager(workspace.context, canonicalComputerUseConfig());
    const connect = vi.spyOn(manager, "connect");

    // When
    const started = await manager.autoStart();

    // Then
    expect(started).toEqual([]);
    expect(connect).not.toHaveBeenCalled();
  });

  it("enumerates only enabled safe servers in sorted order", async () => {
    // Given
    const workspace = await trackedWorkspace();
    const manager = new McpManager(workspace.context, safeServerConfig());

    // When
    const serverIds = manager.serverIds();

    // Then
    expect(serverIds).toEqual(["safe_alpha", "safe_zeta"]);
  });

  it.each([
    {
      identity: "canonical server ID",
      serverId: "open_computer_use",
      command: ["canonical-command"]
    },
    {
      identity: "command-based alias",
      serverId: "desktop_control",
      command: ["npx", "open-computer-use@0.2.0", "mcp"]
    }
  ] as const)("derives $identity visibility from each request context", async ({ serverId, command }) => {
    // Given
    const workspace = await trackedWorkspace();
    const manager = new McpManager(workspace.context, contextualServerConfig(serverId, command));
    const enabledContext = withComputerUseEnabled(workspace.context);
    const delegatedContext = { ...workspace.context, taskId: "delegated-computer-use" };
    const safeServerIds = ["open_computer_use_docs", "safe_server"];
    const enabledServerIds = [...safeServerIds, serverId].sort();
    const connect = vi.spyOn(manager, "connect");

    // When
    const visibleServerIds = [
      manager.serverIds(workspace.context),
      manager.serverIds(enabledContext),
      manager.serverIds(delegatedContext),
      manager.serverIds(enabledContext),
      manager.serverIds(workspace.context)
    ];

    // Then
    expect(visibleServerIds).toEqual([
      safeServerIds,
      enabledServerIds,
      safeServerIds,
      enabledServerIds,
      safeServerIds
    ]);
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([
    ["open_computer_use", ["canonical-command"]],
    ["desktop_control", ["npx", "open-computer-use", "mcp"]],
    ["desktop_control", ["npx", "open-computer-use@0.2.0", "mcp"]]
  ] as const)("recognizes exact Computer Use identity for %s with %j", async (serverId, command) => {
    // Given
    const workspace = await trackedWorkspace();
    const config = contextualServerConfig(serverId, command);
    const server = config.mcpServers[serverId];
    if (!server) throw new Error(`Missing test server: ${serverId}`);

    // When
    const recognized = isOpenComputerUseServer(serverId, server);
    const ordinaryVisible = mcpServerVisibleInTurn(serverId, server, workspace.context);
    const explicitVisible = mcpServerVisibleInTurn(
      serverId,
      server,
      withComputerUseEnabled(workspace.context)
    );

    // Then
    expect(recognized).toBe(true);
    expect(ordinaryVisible).toBe(false);
    expect(explicitVisible).toBe(true);
  });

  it.each([
    "my-open-computer-use",
    "open-computer-use-helper"
  ])("does not overmatch unrelated command argument %s", commandArgument => {
    // Given
    const config = contextualServerConfig("unrelated", ["npx", commandArgument]);
    const server = config.mcpServers.unrelated;
    if (!server) throw new Error("Missing unrelated test server");

    // When
    const recognized = isOpenComputerUseServer("unrelated", server);

    // Then
    expect(recognized).toBe(false);
  });
});
