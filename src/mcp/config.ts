import { readFile } from "node:fs/promises";
import { z } from "zod";
import { StrongCodeError } from "../core/errors";
import type { PathReceipt } from "../core/path-identity";
import { readTrustedHomeFile } from "../config/trusted-home-file";
import { mcpServerNamespace } from "./names";

const environmentNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "Use an uppercase environment-variable name");
const MAX_MCP_CONFIG_BYTES = 5 * 1024 * 1024;

const headerFromEnvSchema = z.object({
  env: environmentNameSchema,
  prefix: z.string().max(64).default(""),
  required: z.boolean().default(false)
}).strict();

const serverBase = {
  enabled: z.boolean().default(true),
  autoStart: z.boolean().optional(),
  description: z.string().max(500).optional(),
  readOnly: z.boolean().default(false),
  requiredFiles: z.array(z.string().min(1)).max(32).default([]),
  requiredEnv: z.array(environmentNameSchema).max(32).default([]),
  timeout: z.object({
    startupMs: z.number().int().positive().max(300000).optional(),
    requestMs: z.number().int().positive().max(300000).optional()
  }).strict().optional()
};

const localServerSchema = z.object({
  ...serverBase,
  type: z.enum(["local", "stdio"]),
  command: z.array(z.string().min(1)).min(1).max(256),
  workingDirectory: z.enum(["workspace", "config"]).default("workspace"),
  inheritDefaultEnvironment: z.boolean().default(true),
  environmentFromEnv: z.array(environmentNameSchema).max(64).default([]),
  tokenSaver: z.enum(["caveman-shrink"]).optional()
}).strict();

const remoteServerSchema = z.object({
  ...serverBase,
  type: z.enum(["remote", "http"]),
  url: z.string().url(),
  headersFromEnv: z.record(headerFromEnvSchema).default({}),
  oauth: z.boolean().default(false)
}).strict().superRefine((server, context) => {
  const url = new URL(server.url);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "Remote MCP URLs must use HTTPS, except loopback HTTP" });
  }
  if (url.username || url.password) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "MCP URLs must not contain credentials" });
  }
});

export const mcpServerSchema = z.union([localServerSchema, remoteServerSchema]);

const webSearchProviderSchema = z.object({
  server: z.string().min(1),
  tool: z.string().min(1),
  queryParameter: z.string().min(1).default("query"),
  enabled: z.boolean().default(false)
}).strict();

export const mcpConfigSchema = z.object({
  $schema: z.string().optional(),
  version: z.literal(1),
  defaults: z.object({
    autoStart: z.boolean().default(false),
    timeout: z.object({
      startupMs: z.number().int().positive().max(300000).default(15000),
      requestMs: z.number().int().positive().max(300000).default(60000)
    }).strict().default({ startupMs: 15000, requestMs: 60000 }),
    environment: z.object({
      inherit: z.literal(false).default(false),
      allowlist: z.array(environmentNameSchema).max(64).default(["PATH", "HOME", "USERPROFILE", "LANG", "LC_ALL", "TERM", "TMP", "TEMP"])
    }).strict().default({ inherit: false, allowlist: ["PATH", "HOME", "USERPROFILE", "LANG", "LC_ALL", "TERM", "TMP", "TEMP"] }),
    stderrFile: z.string().optional()
  }).strict().default({
    autoStart: false,
    timeout: { startupMs: 15000, requestMs: 60000 },
    environment: { inherit: false, allowlist: ["PATH", "HOME", "USERPROFILE", "LANG", "LC_ALL", "TERM", "TMP", "TEMP"] }
  }),
  mcpServers: z.record(mcpServerSchema).default({}),
  webSearch: z.object({ providers: z.array(webSearchProviderSchema).max(16).default([]) }).strict().default({ providers: [] }),
  /** Documentation-only snippets; never loaded or executed by the runtime. */
  templates: z.record(z.unknown()).default({})
}).strict().superRefine((config, context) => {
  const serverIdByNamespace = new Map<string, string>();
  for (const serverId of Object.keys(config.mcpServers)) {
    const namespace = mcpServerNamespace(serverId);
    const existingServerId = serverIdByNamespace.get(namespace);
    if (existingServerId !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mcpServers", serverId],
        message: `MCP server IDs '${existingServerId}' and '${serverId}' share normalized namespace '${namespace}'`
      });
    } else {
      serverIdByNamespace.set(namespace, serverId);
    }
  }
  config.webSearch.providers.forEach((provider, index) => {
    if (!Object.hasOwn(config.mcpServers, provider.server)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["webSearch", "providers", index, "server"], message: `Unknown MCP server '${provider.server}'` });
    }
  });
});

export type McpConfig = z.infer<typeof mcpConfigSchema>;
export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export type LocalMcpServerConfig = z.infer<typeof localServerSchema>;
export type RemoteMcpServerConfig = z.infer<typeof remoteServerSchema>;

export type McpConfigLoadOptions = {
  readonly automaticHomeReceipt?: PathReceipt;
};

export async function loadMcpConfig(
  filePath: string,
  options: McpConfigLoadOptions = {}
): Promise<McpConfig | undefined> {
  let text: string;
  try {
    if (options.automaticHomeReceipt === undefined) {
      text = await readFile(filePath, "utf8");
    } else {
      const bytes = await readTrustedHomeFile(filePath, {
        automaticHomeReceipt: options.automaticHomeReceipt,
        maxBytes: BigInt(MAX_MCP_CONFIG_BYTES)
      });
      if (bytes === undefined) return undefined;
      text = bytes.toString("utf8");
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw new StrongCodeError(
      "CONFIG_ERROR",
      `Failed to read MCP config ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new StrongCodeError("CONFIG_ERROR", `Invalid JSON in MCP config: ${filePath}`);
  }
  const parsed = mcpConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new StrongCodeError("CONFIG_ERROR", `Invalid MCP config: ${parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  return parsed.data;
}
