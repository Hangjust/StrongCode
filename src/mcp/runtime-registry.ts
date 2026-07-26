import path from "node:path";
import { z } from "zod";
import { StrongCodeError } from "../core/errors";
import { err, ok } from "../core/result";
import type { RuntimeContext, ToolInvocationContext } from "../runtime/context";
import { createDefaultToolRegistry, ToolRegistry } from "../tools/registry";
import { assertToolAllowed } from "../tools/permissions";
import { isDelegationToolName } from "../tools/child-policy";
import type { Tool } from "../tools/tool";
import { loadMcpConfig } from "./config";
import { McpManager } from "./client";
import type { McpConfig } from "./config";
import { namespacedMcpToolName } from "./names";

const listInputSchema = z.object({ server: z.string().min(1) });
const callInputSchema = z.object({
  server: z.string().min(1),
  tool: z.string().min(1),
  arguments: z.record(z.unknown()).default({})
});
const searchInputSchema = z.object({ query: z.string().min(1) });

const AUDITED_WEB_SEARCH_ROUTES: Readonly<Record<string, { readonly url: string; readonly tool: string }>> = {
  exa: { url: "https://mcp.exa.ai/mcp", tool: "web_search_exa" },
  tinyfish: { url: "https://agent.tinyfish.ai/mcp", tool: "search" }
};

function isAuditedWebSearchRoute(config: McpConfig, provider: McpConfig["webSearch"]["providers"][number]): boolean {
  const audited = AUDITED_WEB_SEARCH_ROUTES[provider.server];
  const server = config.mcpServers[provider.server];
  return Boolean(
    audited
    && server
    && (server.type === "remote" || server.type === "http")
    && server.url === audited.url
    && provider.tool === audited.tool
  );
}

function errorResult(error: unknown) {
  return err(error instanceof StrongCodeError ? error : new StrongCodeError("TOOL_ERROR", error instanceof Error ? error.message : String(error)));
}

function gatewayTools(manager: McpManager): Tool[] {
  return [
    {
      name: "mcp_list_tools",
      description: "Discover tools exposed by one configured MCP server.",
      effect: "discovery",
      inputSchema: listInputSchema,
      inputJsonSchema: {
        type: "object",
        properties: { server: { type: "string" } },
        required: ["server"],
        additionalProperties: false
      },
      modelView(context) {
        const serverIds = Object.freeze([...manager.serverIds(context)]);
        if (serverIds.length === 0) return undefined;
        return {
          description: `Discover tools exposed by one configured MCP server. Configured servers: ${serverIds.join(", ")}.`,
          inputJsonSchema: {
            type: "object",
            properties: { server: { type: "string", enum: serverIds } },
            required: ["server"],
            additionalProperties: false
          }
        };
      },
      readOnly: false,
      async execute(input, context) {
        const parsed = listInputSchema.safeParse(input);
        if (!parsed.success) return err(new StrongCodeError("VALIDATION_ERROR", parsed.error.message));
        try {
          const tools = await manager.listTools(parsed.data.server, context);
          return ok({ content: tools.map(tool => `${tool.name}${tool.description ? ` - ${tool.description}` : ""}`).join("\n") });
        } catch (error) {
          return errorResult(error instanceof Error ? error : new Error(String(error)));
        }
      }
    },
    {
      name: "mcp_call",
      description: "Call a tool on an enabled MCP server. Use mcp_list_tools first to discover the exact tool name and purpose.",
      effect: "unclassified",
      inputSchema: callInputSchema,
      inputJsonSchema: {
        type: "object",
        properties: {
          server: { type: "string" },
          tool: { type: "string", minLength: 1 },
          arguments: { type: "object", additionalProperties: true }
        },
        required: ["server", "tool"],
        additionalProperties: false
      },
      modelView(context) {
        const serverIds = Object.freeze([...manager.serverIds(context)]);
        if (serverIds.length === 0) return undefined;
        return {
          description: `Call a tool on an enabled MCP server. Configured servers: ${serverIds.join(", ")}. Use mcp_list_tools first to discover the exact tool name and purpose.`,
          inputJsonSchema: {
            type: "object",
            properties: {
              server: { type: "string", enum: serverIds },
              tool: { type: "string", minLength: 1 },
              arguments: { type: "object", additionalProperties: true }
            },
            required: ["server", "tool"],
            additionalProperties: false
          }
        };
      },
      readOnly: false,
      async execute(input, context) {
        const parsed = callInputSchema.safeParse(input);
        if (!parsed.success) return err(new StrongCodeError("VALIDATION_ERROR", parsed.error.message));
        if (context.taskId && isDelegationToolName(parsed.data.tool)) {
          return err(new StrongCodeError(
            "NESTED_SPAWN_DENIED",
            `Child task '${context.taskId}' cannot invoke delegation tool '${parsed.data.tool}'`
          ));
        }
        const nestedAllowed = assertToolAllowed(
          context.config,
          namespacedMcpToolName(parsed.data.server, parsed.data.tool),
          context.effectivePermissions
        );
        if (!nestedAllowed.ok) return nestedAllowed;
        try {
          return ok({ content: await manager.callTool(parsed.data.server, parsed.data.tool, parsed.data.arguments, context) });
        } catch (error) {
          return errorResult(error instanceof Error ? error : new Error(String(error)));
        }
      }
    }
  ];
}

type WebSearchProvider = McpConfig["webSearch"]["providers"][number];

function visibleWebSearchProviders(
  manager: McpManager,
  context: ToolInvocationContext
): readonly WebSearchProvider[] {
  const visibleServerIds = new Set(manager.serverIds(context));
  return Object.freeze(manager.config.webSearch.providers.filter(provider => (
    provider.enabled && visibleServerIds.has(provider.server)
  )));
}

function webSearchTool(manager: McpManager): Tool | undefined {
  if (!manager.config.webSearch.providers.some(provider => provider.enabled)) return undefined;
  return {
    name: "web_search",
    description: "Search the current web with automatic provider fallback.",
    effect: manager.config.webSearch.providers.every(provider => (
      !provider.enabled || isAuditedWebSearchRoute(manager.config, provider)
    )) ? "read-only-web" : "unclassified",
    inputSchema: searchInputSchema,
    inputJsonSchema: {
      type: "object",
      properties: { query: { type: "string", minLength: 1 } },
      required: ["query"],
      additionalProperties: false
    },
    modelView(context) {
      const providers = visibleWebSearchProviders(manager, context);
      if (providers.length === 0) return undefined;
      return Object.freeze({
        description: `Search the current web with automatic provider fallback (${providers.map(provider => provider.server).join(" -> ")}).`
      });
    },
    readOnly: true,
    async execute(input, context) {
      const parsed = searchInputSchema.safeParse(input);
      if (!parsed.success) return err(new StrongCodeError("VALIDATION_ERROR", parsed.error.message));
      const providers = visibleWebSearchProviders(manager, context);
      if (providers.length === 0) {
        return err(new StrongCodeError(
          "PERMISSION_DENIED",
          "No web-search providers are visible in the current turn"
        ));
      }
      const failures: string[] = [];
      for (const provider of providers) {
        const nestedToolName = namespacedMcpToolName(provider.server, provider.tool);
        const nestedAllowed = assertToolAllowed(
          context.config,
          nestedToolName,
          context.effectivePermissions
        );
        if (!nestedAllowed.ok) return nestedAllowed;
        try {
          const content = await manager.callTool(
            provider.server,
            provider.tool,
            { [provider.queryParameter]: parsed.data.query },
            context
          );
          return ok({ content: `[provider: ${provider.server}]\n${content}` });
        } catch (error) {
          if (error instanceof StrongCodeError && error.code === "PERMISSION_DENIED") return err(error);
          failures.push(`${provider.server}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return err(new StrongCodeError("TOOL_ERROR", `All web-search providers failed:\n${failures.join("\n")}`));
    }
  };
}

function directMcpTool(manager: McpManager, serverId: string, sdkTool: Awaited<ReturnType<McpManager["listTools"]>>[number]): Tool {
  const server = manager.config.mcpServers[serverId];
  if (!server) throw new StrongCodeError("CONFIG_ERROR", `MCP server not found: ${serverId}`);
  return {
    name: namespacedMcpToolName(serverId, sdkTool.name),
    rawName: sdkTool.name,
    description: sdkTool.description ?? `${serverId} MCP tool: ${sdkTool.name}`,
    effect: "unclassified",
    inputSchema: z.record(z.unknown()),
    inputJsonSchema: sdkTool.inputSchema,
    readOnly: server.readOnly || sdkTool.annotations?.readOnlyHint === true,
    async execute(input, context) {
      if (!input || typeof input !== "object" || Array.isArray(input)) return err(new StrongCodeError("VALIDATION_ERROR", "MCP tool input must be an object"));
      try {
        return ok({ content: await manager.callTool(serverId, sdkTool.name, input as Record<string, unknown>, context) });
      } catch (error) {
        return errorResult(error instanceof Error ? error : new Error(String(error)));
      }
    }
  };
}

export interface RuntimeToolRegistryOptions {
  allowMcp?: boolean;
  readonly managerFactory?: (context: RuntimeContext, config: McpConfig) => McpManager;
}

export async function createRuntimeToolRegistry(context: RuntimeContext, options: RuntimeToolRegistryOptions = {}): Promise<ToolRegistry> {
  const registry = createDefaultToolRegistry();
  if (options.allowMcp === false) return registry;
  const config = await loadMcpConfig(path.join(path.dirname(context.configPath), "mcp.json"), {
    automaticHomeReceipt: context.automaticHomeReceipt
  });
  if (!config) return registry;
  const manager = options.managerFactory?.(context, config) ?? new McpManager(context, config);
  registry.addCloser(() => manager.close());
  gatewayTools(manager).forEach(tool => registry.register(tool));
  const search = webSearchTool(manager);
  if (search) registry.register(search);
  const connected = await manager.autoStart();
  for (const connection of connected) {
    for (const sdkTool of connection.tools) registry.register(directMcpTool(manager, connection.id, sdkTool));
  }
  return registry;
}
