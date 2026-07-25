import type { ToolInvocationContext } from "../runtime/context";
import {
  computerUseEnabled,
  OPEN_COMPUTER_USE_SERVER_ID
} from "../tools/computer-use-policy";
import type { McpConfig, McpServerConfig } from "./config";

const OPEN_COMPUTER_USE_PACKAGE = /^open-computer-use(?:@[^@\s]+)?$/iu;

export function isOpenComputerUseServer(
  serverId: string,
  server: McpServerConfig
): boolean {
  return serverId === OPEN_COMPUTER_USE_SERVER_ID
    || (
      (server.type === "local" || server.type === "stdio")
      && server.command.some(argument => OPEN_COMPUTER_USE_PACKAGE.test(argument))
    );
}

export function mcpServerVisibleInTurn(
  serverId: string,
  server: McpServerConfig,
  context: ToolInvocationContext
): boolean {
  return !isOpenComputerUseServer(serverId, server) || computerUseEnabled(context);
}

export function visibleMcpServerIds(
  config: McpConfig,
  context: ToolInvocationContext
): string[] {
  return Object.entries(config.mcpServers)
    .filter(([serverId, server]) => (
      server.enabled && mcpServerVisibleInTurn(serverId, server, context)
    ))
    .map(([serverId]) => serverId);
}
