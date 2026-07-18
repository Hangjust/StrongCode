import { createHash } from "node:crypto";
import YAML, { isMap, isScalar, isSeq, Scalar, type YAMLMap, type YAMLSeq } from "yaml";
import { strongCodeConfigSchema, type PermissionDecision } from "../../config/schema";
import {
  assertBlenderTransitionAuthorized,
  BLENDER_MANAGED_MARKER,
  blenderMcpLaunchFlavor,
  type BlenderMcpLaunchInput,
  type BlenderMcpTransitionProof
} from "./mcp-launch";
import {
  blenderConfigConflict,
  MAX_BLENDER_CONFIG_BYTES,
  type SourceMergePlan
} from "./config-merge-shared";

const PERMISSION_ORDER: Readonly<Record<PermissionDecision, number>> = { allow: 0, ask: 1, deny: 2 };
const WILDCARD_PERMISSION = "mcp__blender__*";
const EXECUTE_PERMISSION = "mcp__blender__execute_blender_code";

function unsupportedPermissionFlavor(flavor: never): never {
  throw blenderConfigConflict(`Unsupported Blender permission flavor: ${JSON.stringify(flavor)}`);
}

function managedPermissionDecision(value: unknown): PermissionDecision | undefined {
  return value === "allow" || value === "ask" || value === "deny" ? value : undefined;
}

function parsePermissionsDocument(source: string): YAML.Document {
  const document = YAML.parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw blenderConfigConflict(`Invalid global YAML config: ${document.errors.map(error => error.message).join("; ")}`);
  }
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    if (error instanceof Error) throw blenderConfigConflict(`Invalid global YAML config: ${error.message}`);
    throw error;
  }
  const parsed = strongCodeConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw blenderConfigConflict(
      `Invalid global StrongCode config: ${parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`
    );
  }
  return document;
}

function permissionTools(document: YAML.Document): YAMLMap {
  const permissions = document.get("permissions", true);
  if (!isMap(permissions)) throw blenderConfigConflict("Global StrongCode permissions must be a YAML map");
  const tools = permissions.get("tools", true);
  if (!isMap(tools)) throw blenderConfigConflict("Global StrongCode permissions.tools must be a YAML map");
  return tools;
}

function defaultAgentTools(document: YAML.Document): YAMLSeq {
  const defaultAgent = document.get("defaultAgent", true);
  if (!isScalar(defaultAgent) || typeof defaultAgent.value !== "string") {
    throw blenderConfigConflict("Global StrongCode defaultAgent must be a string");
  }
  const agents = document.get("agents", true);
  if (!isMap(agents)) throw blenderConfigConflict("Global StrongCode agents must be a YAML map");
  const agent = agents.get(defaultAgent.value, true);
  if (!isMap(agent)) {
    throw blenderConfigConflict(`Global StrongCode default agent '${defaultAgent.value}' must be a YAML map`);
  }
  const tools = agent.get("tools", true);
  if (!isSeq(tools)) {
    throw blenderConfigConflict(`Global StrongCode default agent '${defaultAgent.value}' tools must be a YAML sequence`);
  }
  return tools;
}

function addMissingAgentTools(tools: YAMLSeq): boolean {
  const existing = new Set(tools.items.flatMap(item =>
    isScalar(item) && typeof item.value === "string" ? [item.value] : []));
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

function ownedPermission(tools: YAMLMap, key: string): PermissionDecision | undefined {
  const existing = tools.get(key, true);
  if (existing === undefined) return undefined;
  if (!isScalar(existing) || existing.comment?.trim() !== BLENDER_MANAGED_MARKER) {
    throw blenderConfigConflict(`Refusing to replace unowned Blender permission '${key}'`);
  }
  const decision = managedPermissionDecision(existing.value);
  if (decision === undefined) {
    throw blenderConfigConflict(`Managed Blender permission '${key}' has an invalid decision`);
  }
  return decision;
}

function assertNoUnsupportedBlenderPermissions(tools: YAMLMap): void {
  for (const pair of tools.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") continue;
    const key = pair.key.value;
    if (!key.startsWith("mcp__blender__")) continue;
    if (key !== WILDCARD_PERMISSION && key !== EXECUTE_PERMISSION) {
      throw blenderConfigConflict(`Blender permission '${key}' conflicts with StrongCode-managed permissions`);
    }
    ownedPermission(tools, key);
  }
}

function mergeOwnedPermission(tools: YAMLMap, key: string, desired: PermissionDecision): boolean {
  const current = ownedPermission(tools, key);
  if (current !== undefined && PERMISSION_ORDER[current] >= PERMISSION_ORDER[desired]) return false;
  tools.set(key, new Scalar(desired));
  const updated = tools.get(key, true);
  if (!isScalar(updated)) throw blenderConfigConflict(`Unable to mark managed Blender permission '${key}'`);
  updated.comment = ` ${BLENDER_MANAGED_MARKER}`;
  return true;
}

function replaceManagedPermission(tools: YAMLMap, key: string, desired: PermissionDecision): boolean {
  if (ownedPermission(tools, key) === desired) return false;
  tools.set(key, new Scalar(desired));
  const updated = tools.get(key, true);
  if (!isScalar(updated)) throw blenderConfigConflict(`Unable to mark managed Blender permission '${key}'`);
  updated.comment = ` ${BLENDER_MANAGED_MARKER}`;
  return true;
}

function mergeFlavorPermissions(
  tools: YAMLMap,
  launch: BlenderMcpLaunchInput | undefined,
  transition: BlenderMcpTransitionProof | undefined
): boolean {
  const flavor = blenderMcpLaunchFlavor(launch);
  const wildcard = ownedPermission(tools, WILDCARD_PERMISSION);
  const execute = ownedPermission(tools, EXECUTE_PERMISSION);
  switch (flavor) {
    case "legacy": {
      if (wildcard === "ask") {
        assertBlenderTransitionAuthorized("official", "legacy", transition);
      }
      return [
        wildcard === "ask"
          ? replaceManagedPermission(tools, WILDCARD_PERMISSION, "allow")
          : mergeOwnedPermission(tools, WILDCARD_PERMISSION, "allow"),
        mergeOwnedPermission(tools, EXECUTE_PERMISSION, "ask")
      ].some(Boolean);
    }
    case "official": {
      const legacyFingerprint = wildcard === "allow" || (execute !== undefined && execute !== "deny");
      if (legacyFingerprint) assertBlenderTransitionAuthorized("legacy", "official", transition);
      let changed = mergeOwnedPermission(tools, WILDCARD_PERMISSION, "ask");
      if (execute !== undefined && execute !== "deny") changed = tools.delete(EXECUTE_PERMISSION) || changed;
      return changed;
    }
    default:
      return unsupportedPermissionFlavor(flavor);
  }
}

export function permissionsFragmentSha256(source: string): string {
  const document = parsePermissionsDocument(source);
  const tools = permissionTools(document);
  const agentTools = new Set(defaultAgentTools(document).items.flatMap(item =>
    isScalar(item) && typeof item.value === "string" ? [item.value] : []));
  const permission = (key: string): unknown => {
    const value = tools.get(key, true);
    return isScalar(value)
      ? { value: value.value, managed: value.comment?.trim() === BLENDER_MANAGED_MARKER }
      : null;
  };
  return createHash("sha256").update(JSON.stringify({
    agentTools: ["mcp_call", "mcp_list_tools"].filter(tool => agentTools.has(tool)).sort(),
    gatewayPermissions: ["mcp_call", "mcp_list_tools"].filter(key => tools.has(key)).sort(),
    blenderPermissions: {
      execute: permission(EXECUTE_PERMISSION),
      wildcard: permission(WILDCARD_PERMISSION)
    }
  })).digest("hex");
}

export function planBlenderPermissionsSource(
  source: string,
  launch?: BlenderMcpLaunchInput,
  transition?: BlenderMcpTransitionProof
): SourceMergePlan {
  if (Buffer.byteLength(source) > MAX_BLENDER_CONFIG_BYTES) {
    throw blenderConfigConflict(`Global StrongCode config exceeds ${MAX_BLENDER_CONFIG_BYTES} bytes`);
  }
  const document = parsePermissionsDocument(source);
  const tools = permissionTools(document);
  const agentTools = defaultAgentTools(document);
  assertNoUnsupportedBlenderPermissions(tools);
  const changed = [
    addMissingAgentTools(agentTools),
    addMissingPermission(tools, "mcp_list_tools"),
    addMissingPermission(tools, "mcp_call"),
    mergeFlavorPermissions(tools, launch, transition)
  ].some(Boolean);
  if (!changed) return { changed: false, content: source };
  const content = document.toString();
  const result = strongCodeConfigSchema.safeParse(YAML.parse(content));
  if (!result.success) {
    throw blenderConfigConflict(`Managed Blender permission merge is invalid: ${result.error.message}`);
  }
  return { changed: true, content };
}
