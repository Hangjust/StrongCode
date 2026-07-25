import { access } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool as SdkTool } from "@modelcontextprotocol/sdk/types.js";
import { StrongCodeError } from "../core/errors";
import type { RuntimeContext, ToolInvocationContext } from "../runtime/context";
import { resolveWorkspaceRealPath } from "../tools/builtin/list-files";
import { assertToolAllowed } from "../tools/permissions";
import { assertComputerUseEnabled } from "../tools/computer-use-policy";
import {
  isOpenComputerUseServer,
  visibleMcpServerIds
} from "./computer-use-server";
import type { McpConfig, McpServerConfig } from "./config";
import { namespacedMcpToolPattern } from "./names";
import { createOAuthCallbackServer, PersistentOAuthProvider } from "./oauth";

export interface ConnectedMcpServer {
  id: string;
  client: Client;
  transport: Transport;
  tools: SdkTool[];
  config: McpServerConfig;
}

function isLocal(config: McpServerConfig): config is Extract<McpServerConfig, { type: "local" | "stdio" }> {
  return config.type === "local" || config.type === "stdio";
}

export function selectedMcpEnvironment(
  config: McpConfig,
  server: Extract<McpServerConfig, { type: "local" | "stdio" }>,
  environment: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const env: Record<string, string> = {};
  const defaults = server.inheritDefaultEnvironment ? config.defaults.environment.allowlist : [];
  for (const name of [...defaults, ...server.environmentFromEnv]) {
    const value = environment[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function requestHeaders(server: Extract<McpServerConfig, { type: "remote" | "http" }>): Headers {
  const headers = new Headers();
  for (const [header, reference] of Object.entries(server.headersFromEnv)) {
    const value = process.env[reference.env];
    if (value !== undefined) headers.set(header, `${reference.prefix}${value}`);
  }
  return headers;
}

function missingRequiredEnvironment(server: McpServerConfig): string[] {
  const required = new Set(server.requiredEnv);
  if (!isLocal(server)) {
    Object.values(server.headersFromEnv).forEach(reference => {
      if (reference.required) required.add(reference.env);
    });
  }
  return [...required].filter(name => !process.env[name]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function renderMcpResult(result: Record<string, unknown>): string {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const rendered = blocks.map(block => {
    if (!block || typeof block !== "object") return JSON.stringify(block);
    const typed = block as Record<string, unknown>;
    if (typed.type === "text" && typeof typed.text === "string") return typed.text;
    if (typed.type === "resource" && typed.resource && typeof typed.resource === "object") {
      const resource = typed.resource as Record<string, unknown>;
      return typeof resource.text === "string" ? resource.text : JSON.stringify(resource);
    }
    if ((typed.type === "image" || typed.type === "audio") && typeof typed.mimeType === "string") {
      return `[${typed.type}: ${typed.mimeType}; binary data omitted]`;
    }
    return JSON.stringify(block);
  }).filter(Boolean);
  if (result.structuredContent !== undefined) rendered.push(JSON.stringify(result.structuredContent));
  return rendered.join("\n");
}

export class McpManager {
  private readonly connections = new Map<string, Promise<ConnectedMcpServer>>();
  private readonly connected = new Map<string, ConnectedMcpServer>();

  constructor(private readonly context: RuntimeContext, readonly config: McpConfig) {}

  private startupTimeout(server: McpServerConfig): number {
    return server.timeout?.startupMs ?? this.config.defaults.timeout.startupMs;
  }

  private requestTimeout(server: McpServerConfig): number {
    return server.timeout?.requestMs ?? this.config.defaults.timeout.requestMs;
  }

  serverIds(invocationContext: ToolInvocationContext = this.context): string[] {
    return visibleMcpServerIds(this.config, invocationContext).sort();
  }

  async connect(
    serverId: string,
    invocationContext: ToolInvocationContext = this.context
  ): Promise<ConnectedMcpServer> {
    const server = this.config.mcpServers[serverId];
    if (!server || !server.enabled) throw new StrongCodeError("TOOL_ERROR", `MCP server '${serverId}' is not enabled`);
    if (isOpenComputerUseServer(serverId, server)) {
      const computerUseAllowed = assertComputerUseEnabled(invocationContext);
      if (!computerUseAllowed.ok) throw computerUseAllowed.error;
    }
    if (isLocal(server)) {
      const allowed = assertToolAllowed(invocationContext.config, namespacedMcpToolPattern(serverId), invocationContext.effectivePermissions);
      if (!allowed.ok) throw allowed.error;
    }
    const existing = this.connections.get(serverId);
    if (existing) return existing;
    const pending = this.connectFresh(serverId, server).catch(error => {
      this.connections.delete(serverId);
      throw error;
    });
    this.connections.set(serverId, pending);
    return pending;
  }

  private async connectFresh(serverId: string, server: McpServerConfig): Promise<ConnectedMcpServer> {
    const missingEnv = missingRequiredEnvironment(server);
    if (missingEnv.length > 0) throw new StrongCodeError("TOOL_ERROR", `MCP server '${serverId}' requires environment variable(s): ${missingEnv.join(", ")}`);
    for (const requiredFile of server.requiredFiles) {
      const resolved = await resolveWorkspaceRealPath(this.context, requiredFile);
      if (!resolved.ok) throw new StrongCodeError("TOOL_ERROR", `MCP server '${serverId}' requires workspace file: ${requiredFile}`);
      await access(resolved.value);
    }

    if (!isLocal(server) && server.oauth && [...requestHeaders(server).keys()].length === 0) {
      return this.connectOAuth(serverId, server);
    }

    let transport: Transport;
    if (isLocal(server)) {
      let [command, ...args] = server.command;
      if (server.tokenSaver === "caveman-shrink") {
        args = ["-y", "caveman-shrink@0.1.0", command, ...args];
        command = "npx";
      }
      transport = new StdioClientTransport({
        command,
        args,
        cwd: server.workingDirectory === "workspace" ? this.context.workspaceRoot : path.dirname(this.context.configPath),
        env: selectedMcpEnvironment(this.config, server),
        stderr: "pipe"
      });
    } else {
      const headers = requestHeaders(server);
      transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: [...headers.keys()].length > 0 ? { headers } : undefined
      });
    }

    const client = new Client({ name: "strongcode", version: "0.1.0" }, { capabilities: {} });
    try {
      await client.connect(transport, { timeout: this.startupTimeout(server) });
      const listed = await client.listTools(undefined, { timeout: this.requestTimeout(server) });
      const connection = { id: serverId, client, transport, tools: listed.tools, config: server };
      this.connected.set(serverId, connection);
      return connection;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw new StrongCodeError("TOOL_ERROR", `Unable to connect MCP server '${serverId}': ${errorMessage(error)}`);
    }
  }

  private async connectOAuth(serverId: string, server: Extract<McpServerConfig, { type: "remote" | "http" }>): Promise<ConnectedMcpServer> {
    const callback = await createOAuthCallbackServer();
    const provider = await PersistentOAuthProvider.create(serverId, server.url, callback.redirectUrl);
    const createSession = (): { client: Client; transport: StreamableHTTPClientTransport } => {
      const client = new Client({ name: "strongcode", version: "0.1.0" }, { capabilities: {} });
      const transport = new StreamableHTTPClientTransport(new URL(server.url), { authProvider: provider });
      return { client, transport };
    };
    try {
      let session = createSession();
      try {
        await session.client.connect(session.transport, { timeout: this.startupTimeout(server) });
      } catch (error) {
        if (!(error instanceof UnauthorizedError)) throw error;
        const code = await callback.waitForCode(provider.expectedState(), 240000);
        await session.transport.finishAuth(code);
        await session.client.close().catch(() => undefined);
        session = createSession();
        await session.client.connect(session.transport, { timeout: this.startupTimeout(server) });
      }
      const listed = await session.client.listTools(undefined, { timeout: this.requestTimeout(server) });
      const connection = { id: serverId, client: session.client, transport: session.transport, tools: listed.tools, config: server };
      this.connected.set(serverId, connection);
      return connection;
    } catch (error) {
      throw new StrongCodeError("TOOL_ERROR", `Unable to authorize MCP server '${serverId}': ${errorMessage(error)}`);
    } finally {
      await callback.close().catch(() => undefined);
    }
  }

  async listTools(
    serverId: string,
    invocationContext: ToolInvocationContext = this.context
  ): Promise<SdkTool[]> {
    return (await this.connect(serverId, invocationContext)).tools;
  }

  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    invocationContext: ToolInvocationContext = this.context
  ): Promise<string> {
    const connection = await this.connect(serverId, invocationContext);
    if (!connection.tools.some(tool => tool.name === toolName)) {
      throw new StrongCodeError("TOOL_ERROR", `MCP server '${serverId}' does not expose tool '${toolName}'`);
    }
    const result = await connection.client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { timeout: this.requestTimeout(connection.config) }
    );
    if (result.isError) throw new StrongCodeError("TOOL_ERROR", renderMcpResult(result));
    return renderMcpResult(result);
  }

  async autoStart(): Promise<ConnectedMcpServer[]> {
    const ids = Object.entries(this.config.mcpServers)
      .filter(([id, server]) => !isOpenComputerUseServer(id, server) && server.enabled && (server.autoStart ?? this.config.defaults.autoStart))
      .map(([id]) => id);
    const results = await Promise.allSettled(ids.map(id => this.connect(id, this.context)));
    return results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.connected.values()].map(connection => connection.client.close()));
    this.connected.clear();
    this.connections.clear();
  }
}
