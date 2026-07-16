import type { AgentRuntimeRole, AgentToolPolicy } from "../agents/agent";
import { StrongCodeError } from "../core/errors";
import { err, ok, type Result } from "../core/result";
import type { Tool, ToolEffect } from "./tool";

const HOST_TOOL_EFFECTS: Readonly<Record<string, ToolEffect>> = {
  list_files: "read",
  read_file: "read",
  find_files: "search",
  ripgrep: "search",
  web_search: "read-only-web",
  write_file: "mutation",
  edit_file: "mutation",
  delete_path: "mutation",
  shell: "shell",
  question: "interaction",
  mcp_list_tools: "discovery",
  mcp_call: "unclassified"
};

const PREFLIGHT_SAFE_EFFECTS = new Set<ToolEffect>(["read", "search", "read-only-web"]);
const READ_ONLY_AGENT_EFFECTS = new Set<ToolEffect>(["read", "search", "read-only-web", "interaction"]);

export type RuntimeToolAccessDecision =
  | { readonly kind: "allow"; readonly effect: ToolEffect }
  | { readonly kind: "deny"; readonly effect: ToolEffect; readonly reason: "role-ceiling" | "unclassified" };

function hostToolEffect(toolName: string): ToolEffect {
  return HOST_TOOL_EFFECTS[toolName] ?? "unclassified";
}

export function decideRuntimeToolAccess(role: AgentRuntimeRole, toolName: string): RuntimeToolAccessDecision {
  const effect = hostToolEffect(toolName);
  if (role === "primary" || role === "child") return { kind: "allow", effect };
  if (effect === "unclassified") return { kind: "deny", effect, reason: "unclassified" };
  if (PREFLIGHT_SAFE_EFFECTS.has(effect)) return { kind: "allow", effect };
  return { kind: "deny", effect, reason: "role-ceiling" };
}

export function effectiveConfiguredTools(role: AgentRuntimeRole, configuredTools: readonly string[]): string[] {
  if (role === "primary" || role === "child") return [...configuredTools];
  return configuredTools.filter(toolName => decideRuntimeToolAccess(role, toolName).kind === "allow");
}

export function filterToolsForRuntimeRole(role: AgentRuntimeRole, tools: readonly Tool[]): Tool[] {
  if (role === "primary" || role === "child") return [...tools];
  return tools.filter(tool => {
    const decision = decideRuntimeToolAccess(role, tool.name);
    return decision.kind === "allow" && decision.effect === tool.effect;
  });
}

export function isToolAllowedByAgentPolicy(policy: AgentToolPolicy | undefined, tool: Tool): boolean {
  return policy !== "read-only" || (tool.readOnly === true && READ_ONLY_AGENT_EFFECTS.has(tool.effect));
}

export function filterToolsForAgentPolicy(policy: AgentToolPolicy | undefined, tools: readonly Tool[]): Tool[] {
  return tools.filter(tool => isToolAllowedByAgentPolicy(policy, tool));
}

export function assertToolAllowedByAgentPolicy(policy: AgentToolPolicy | undefined, tool: Tool): Result<void> {
  return isToolAllowedByAgentPolicy(policy, tool)
    ? ok(undefined)
    : err(new StrongCodeError("PERMISSION_DENIED", `Tool '${tool.name}' is denied by read-only agent policy`));
}

export function assertRuntimeToolNameAllowed(role: AgentRuntimeRole, toolName: string): Result<void> {
  const decision = decideRuntimeToolAccess(role, toolName);
  if (decision.kind === "allow") return ok(undefined);
  return err(new StrongCodeError(
    "PERMISSION_DENIED",
    `Tool '${toolName}' is denied for runtime role '${role}' (${decision.reason})`
  ));
}

export function assertRuntimeToolAllowed(role: AgentRuntimeRole, tool: Tool): Result<void> {
  const decision = decideRuntimeToolAccess(role, tool.name);
  if (decision.kind === "deny") {
    return err(new StrongCodeError(
      "PERMISSION_DENIED",
      `Tool '${tool.name}' is denied for runtime role '${role}' (${decision.reason})`
    ));
  }
  if (role !== "primary" && role !== "child" && decision.effect !== tool.effect) {
    return err(new StrongCodeError(
      "PERMISSION_DENIED",
      `Tool '${tool.name}' has effect '${tool.effect}', expected host classification '${decision.effect}'`
    ));
  }
  return ok(undefined);
}
