import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import YAML, { isMap, isScalar, isSeq, Scalar, type YAMLMap, type YAMLSeq } from "yaml";
import { assertNoSymlinkPathComponents } from "../../config/save";
import { strongCodeConfigSchema, type PermissionDecision } from "../../config/schema";
import { StrongCodeError } from "../../core/errors";
import { mcpConfigSchema } from "../../mcp/config";
import { mcpServerNamespace } from "../../mcp/names";
import { canonicalJsonString } from "./semantic-json";

export const BLENDER_MANAGED_MARKER = "strongcode:blender-managed";
const MAX_CONFIG_BYTES = 1024 * 1024;
const PERMISSION_ORDER: Readonly<Record<PermissionDecision, number>> = { allow: 0, ask: 1, deny: 2 };

export type BlenderManagedPaths = {
  readonly pythonPath: string;
  readonly wrapperPath: string;
  readonly privateConfigPath: string;
};

export type SourceMergePlan = { readonly changed: boolean; readonly content: string };

export type FileMergePlan = SourceMergePlan & {
  readonly filePath: string;
  readonly expectedSourceHash: string;
  readonly fragmentSha256: string;
};

export type GlobalBlenderConfigMergePlan = {
  readonly mcp: FileMergePlan;
  readonly permissions: FileMergePlan;
};

export type GlobalBlenderConfigMergeOptions = BlenderManagedPaths & {
  readonly homePath: string;
};

function conflict(message: string): StrongCodeError {
  return new StrongCodeError("CONFIG_ERROR", message);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function parseJsonObject(source: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    if (error instanceof SyntaxError) throw conflict(`Invalid JSON in global MCP config: ${error.message}`);
    throw error;
  }
  const parsed = mcpConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw conflict(`Invalid global MCP config: ${parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  const object = record(value);
  if (!object) throw conflict("Global MCP config must be an object");
  return object;
}

function commandIdentifiesBlender(server: unknown): boolean {
  const command = record(server)?.["command"];
  if (!Array.isArray(command) || !command.every(part => typeof part === "string")) return false;
  const identity = command.join(" ").toLowerCase().replaceAll("\\", "/");
  return identity.includes("blender-mcp")
    || identity.includes("blender_mcp")
    || (identity.includes("strongcode") && identity.includes("blender"));
}

function managedServer(paths: BlenderManagedPaths): Record<string, unknown> {
  for (const [name, filePath] of Object.entries(paths)) {
    if (!path.isAbsolute(filePath)) throw conflict(`Managed Blender ${name} must be absolute: ${filePath}`);
  }
  return {
    description: BLENDER_MANAGED_MARKER,
    enabled: true,
    autoStart: false,
    type: "local",
    readOnly: false,
    command: [paths.pythonPath, "-I", paths.wrapperPath, "--config", paths.privateConfigPath],
    inheritDefaultEnvironment: false,
    environmentFromEnv: [],
    timeout: { startupMs: 30000, requestMs: 180000 }
  };
}

function mcpFragmentSha256(source: string): string {
  const servers = record(parseJsonObject(source)["mcpServers"]);
  if (!servers) throw conflict("Global MCP config mcpServers must be an object");
  return createHash("sha256").update(canonicalJsonString({ serverId: "blender", server: servers["blender"] })).digest("hex");
}

function ownedServer(serverId: string, server: unknown): boolean {
  return serverId === "blender" && record(server)?.["description"] === BLENDER_MANAGED_MARKER;
}

export function planBlenderMcpSource(source: string, paths: BlenderManagedPaths): SourceMergePlan {
  if (Buffer.byteLength(source) > MAX_CONFIG_BYTES) throw conflict(`Global MCP config exceeds ${MAX_CONFIG_BYTES} bytes`);
  const config = parseJsonObject(source);
  const servers = record(config["mcpServers"]);
  if (!servers) throw conflict("Global MCP config mcpServers must be an object");
  for (const [serverId, server] of Object.entries(servers)) {
    const owned = ownedServer(serverId, server);
    if (mcpServerNamespace(serverId) === "blender" && !owned) {
      throw conflict(`Blender MCP server '${serverId}' conflicts with the managed server and is unowned`);
    }
    if (commandIdentifiesBlender(server) && !owned) {
      throw conflict(`MCP server '${serverId}' has an unowned Blender MCP or StrongCode derivative command`);
    }
  }

  const blender = managedServer(paths);
  if (canonicalJsonString(servers["blender"]) === canonicalJsonString(blender)) return { changed: false, content: source };
  const next = { ...config, mcpServers: { ...servers, blender } };
  const validated = mcpConfigSchema.safeParse(next);
  if (!validated.success) throw conflict(`Managed Blender MCP merge is invalid: ${validated.error.message}`);
  return { changed: true, content: `${JSON.stringify(next, null, 2)}\n` };
}

function parsePermissionsDocument(source: string): YAML.Document {
  const document = YAML.parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw conflict(`Invalid global YAML config: ${document.errors.map(error => error.message).join("; ")}`);
  }
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    if (error instanceof Error) throw conflict(`Invalid global YAML config: ${error.message}`);
    throw error;
  }
  const parsed = strongCodeConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw conflict(`Invalid global StrongCode config: ${parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  return document;
}

function permissionTools(document: YAML.Document): YAMLMap {
  const permissions = document.get("permissions", true);
  if (!isMap(permissions)) throw conflict("Global StrongCode permissions must be a YAML map");
  const tools = permissions.get("tools", true);
  if (!isMap(tools)) throw conflict("Global StrongCode permissions.tools must be a YAML map");
  return tools;
}

function defaultAgentTools(document: YAML.Document): YAMLSeq {
  const defaultAgent = document.get("defaultAgent", true);
  if (!isScalar(defaultAgent) || typeof defaultAgent.value !== "string") {
    throw conflict("Global StrongCode defaultAgent must be a string");
  }
  const agents = document.get("agents", true);
  if (!isMap(agents)) throw conflict("Global StrongCode agents must be a YAML map");
  const agent = agents.get(defaultAgent.value, true);
  if (!isMap(agent)) throw conflict(`Global StrongCode default agent '${defaultAgent.value}' must be a YAML map`);
  const tools = agent.get("tools", true);
  if (!isSeq(tools)) throw conflict(`Global StrongCode default agent '${defaultAgent.value}' tools must be a YAML sequence`);
  return tools;
}

function addMissingAgentTools(tools: YAMLSeq): boolean {
  const existing = new Set(tools.items.flatMap(item => isScalar(item) && typeof item.value === "string" ? [item.value] : []));
  let changed = false;
  for (const tool of ["mcp_list_tools", "mcp_call"] as const) {
    if (existing.has(tool)) continue;
    tools.add(new Scalar(tool));
    changed = true;
  }
  return changed;
}

function addMissingPermission(tools: YAMLMap, key: string): boolean {
  if (tools.has(key)) return false;
  tools.set(key, "allow");
  return true;
}

function permissionsFragmentSha256(source: string): string {
  const document = parsePermissionsDocument(source);
  const tools = permissionTools(document);
  const agentTools = new Set(defaultAgentTools(document).items.flatMap(item =>
    isScalar(item) && typeof item.value === "string" ? [item.value] : []));
  const permission = (key: string): unknown => {
    const value = tools.get(key, true);
    return isScalar(value) ? { value: value.value, managed: value.comment?.includes(BLENDER_MANAGED_MARKER) ?? false } : null;
  };
  return createHash("sha256").update(JSON.stringify({
    agentTools: ["mcp_call", "mcp_list_tools"].filter(tool => agentTools.has(tool)).sort(),
    gatewayPermissions: ["mcp_call", "mcp_list_tools"].filter(key => tools.has(key)).sort(),
    blenderPermissions: {
      execute: permission("mcp__blender__execute_blender_code"),
      wildcard: permission("mcp__blender__*")
    }
  })).digest("hex");
}

function mergeOwnedPermission(tools: YAMLMap, key: string, desired: PermissionDecision): boolean {
  const existing = tools.get(key, true);
  if (existing !== undefined) {
    if (!isScalar(existing) || !existing.comment?.includes(BLENDER_MANAGED_MARKER)) {
      throw conflict(`Refusing to replace unowned Blender permission '${key}'`);
    }
    const parsed = typeof existing.value === "string" ? existing.value : "";
    const current = parsed === "allow" || parsed === "ask" || parsed === "deny" ? parsed : desired;
    if (PERMISSION_ORDER[current] >= PERMISSION_ORDER[desired]) return false;
  }
  tools.set(key, new Scalar(desired));
  const updated = tools.get(key, true);
  if (!isScalar(updated)) throw conflict(`Unable to mark managed Blender permission '${key}'`);
  updated.comment = ` ${BLENDER_MANAGED_MARKER}`;
  return true;
}

export function planBlenderPermissionsSource(source: string): SourceMergePlan {
  if (Buffer.byteLength(source) > MAX_CONFIG_BYTES) throw conflict(`Global StrongCode config exceeds ${MAX_CONFIG_BYTES} bytes`);
  const document = parsePermissionsDocument(source);
  const tools = permissionTools(document);
  const agentTools = defaultAgentTools(document);
  const changed = [
    addMissingAgentTools(agentTools),
    addMissingPermission(tools, "mcp_list_tools"),
    addMissingPermission(tools, "mcp_call"),
    mergeOwnedPermission(tools, "mcp__blender__*", "allow"),
    mergeOwnedPermission(tools, "mcp__blender__execute_blender_code", "ask")
  ].some(Boolean);
  if (!changed) return { changed: false, content: source };

  const content = document.toString();
  const result = strongCodeConfigSchema.safeParse(YAML.parse(content));
  if (!result.success) throw conflict(`Managed Blender permission merge is invalid: ${result.error.message}`);
  return { changed: true, content };
}

async function readConfig(filePath: string): Promise<{ readonly source: string; readonly hash: string }> {
  await assertNoSymlinkPathComponents(filePath);
  let stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw conflict(`Required global config does not exist: ${filePath}`);
    }
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) throw conflict(`Refusing non-regular or symlinked global config: ${filePath}`);
  if (stats.size > MAX_CONFIG_BYTES) throw conflict(`Global config exceeds ${MAX_CONFIG_BYTES} bytes: ${filePath}`);
  const content = await readFile(filePath);
  return { source: content.toString("utf8"), hash: createHash("sha256").update(content).digest("hex") };
}

export async function planGlobalBlenderConfigMerge(options: GlobalBlenderConfigMergeOptions): Promise<GlobalBlenderConfigMergePlan> {
  const homePath = path.resolve(options.homePath);
  const mcpPath = path.join(homePath, "mcp.json");
  const permissionsPath = path.join(homePath, "strongcode.config.yaml");
  const mcpSource = await readConfig(mcpPath);
  const permissionsSource = await readConfig(permissionsPath);
  const paths = { pythonPath: options.pythonPath, wrapperPath: options.wrapperPath, privateConfigPath: options.privateConfigPath };
  const mcpPlan = planBlenderMcpSource(mcpSource.source, paths);
  const permissionsPlan = planBlenderPermissionsSource(permissionsSource.source);
  return {
    mcp: { filePath: mcpPath, expectedSourceHash: mcpSource.hash, fragmentSha256: mcpFragmentSha256(mcpPlan.content), ...mcpPlan },
    permissions: {
      filePath: permissionsPath,
      expectedSourceHash: permissionsSource.hash,
      fragmentSha256: permissionsFragmentSha256(permissionsPlan.content),
      ...permissionsPlan
    }
  };
}
