import type { EffectiveToolPermission, ToolInvocationContext } from "../runtime/context";
import { StrongCodeError } from "../core/errors";
import { err, ok, type Result } from "../core/result";
import { toolNameMatches } from "./registry";
import type { Tool } from "./tool";

const DELEGATION_TOOL_NAMES = new Set([
  "agent.spawn",
  "call_omo_agent",
  "delegate_jobs",
  "delegate_task",
  "spawn",
  "task",
  "task_spawn",
  "worker"
]);

export type ChildPermissionLayer = Readonly<Record<string, EffectiveToolPermission>>;

export type ChildExecutionPolicyInput = {
  readonly projectTrust: ChildPermissionLayer;
  readonly parentPermissions: ChildPermissionLayer;
  readonly targetCeiling: readonly string[];
  readonly taskGrants: readonly string[];
  readonly tools: readonly Tool[];
};

export type ChildExecutionPolicy = {
  readonly permissions: Readonly<Record<string, EffectiveToolPermission>>;
  readonly tools: readonly string[];
};

function permissionFor(layer: ChildPermissionLayer, toolName: string): EffectiveToolPermission {
  const matching = Object.entries(layer)
    .filter(([pattern]) => pattern === toolName || (pattern.includes("*") && toolNameMatches(pattern, toolName)))
    .map(([, decision]) => decision);
  return matching.length > 0 ? attenuate(matching) : "deny";
}

function matchesAny(patterns: readonly string[], toolName: string): boolean {
  return patterns.some(pattern => toolNameMatches(pattern, toolName));
}

function isDelegationTool(tool: Tool): boolean {
  return tool.effect === "spawn"
    || tool.effect === "worker"
    || isDelegationToolName(tool.rawName ?? tool.name)
    || isDelegationToolName(tool.name);
}

function attenuate(decisions: readonly EffectiveToolPermission[]): EffectiveToolPermission {
  if (decisions.includes("deny")) return "deny";
  if (decisions.includes("ask")) return "ask";
  return "allow";
}

export function isDelegationToolName(toolName: string): boolean {
  if (DELEGATION_TOOL_NAMES.has(toolName)) return true;
  const separator = toolName.lastIndexOf("__");
  return separator >= 0 && DELEGATION_TOOL_NAMES.has(toolName.slice(separator + 2));
}

export function createChildExecutionPolicy(input: ChildExecutionPolicyInput): ChildExecutionPolicy {
  const permissions: Record<string, EffectiveToolPermission> = {};
  for (const tool of input.tools) {
    permissions[tool.name] = isDelegationTool(tool)
      ? "deny"
      : attenuate([
        permissionFor(input.projectTrust, tool.name),
        permissionFor(input.parentPermissions, tool.name),
        matchesAny(input.targetCeiling, tool.name) ? "allow" : "deny",
        matchesAny(input.taskGrants, tool.name) ? "allow" : "deny"
      ]);
  }
  Object.freeze(permissions);
  const tools = Object.freeze(input.tools
    .filter(tool => permissions[tool.name] === "allow")
    .map(tool => tool.name));
  return Object.freeze({ permissions, tools });
}

export function assertChildToolAllowed(context: ToolInvocationContext, tool: Tool): Result<void> {
  if (!context.taskId) return ok(undefined);
  if (isDelegationTool(tool)) {
    return err(new StrongCodeError("NESTED_SPAWN_DENIED", `Child task '${context.taskId}' cannot invoke delegation tool '${tool.name}'`));
  }
  const decision = context.effectivePermissions?.[tool.name] ?? "deny";
  if (decision === "allow") return ok(undefined);
  return err(new StrongCodeError("PERMISSION_DENIED", `Tool '${tool.name}' is ${decision} for child task '${context.taskId}'`));
}
