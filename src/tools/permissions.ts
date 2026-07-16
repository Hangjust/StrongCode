import { StrongCodeConfig } from "../config/schema";
import { StrongCodeError } from "../core/errors";
import { err, ok, Result } from "../core/result";
import type { EffectiveToolPermission } from "../runtime/context";
import { isDelegationToolName } from "./child-policy";
import { toolNameMatches } from "./registry";

export function getToolPermission(config: StrongCodeConfig, toolName: string): "allow" | "ask" | "deny" {
  const matching = Object.entries(config.permissions.tools)
    .filter(([pattern]) => pattern === toolName || (pattern.includes("*") && toolNameMatches(pattern, toolName)))
    .map(([, decision]) => decision);
  if (matching.includes("deny")) return "deny";
  if (matching.includes("ask")) return "ask";
  return matching.includes("allow") ? "allow" : "deny";
}

export function assertToolAllowed(
  config: StrongCodeConfig,
  toolName: string,
  effectivePermissions?: Readonly<Record<string, EffectiveToolPermission>>
): Result<void> {
  if (effectivePermissions && isDelegationToolName(toolName)) {
    return err(new StrongCodeError("NESTED_SPAWN_DENIED", `Child execution cannot invoke delegation tool '${toolName}'`));
  }
  const configured = getToolPermission(config, toolName);
  const effective = effectivePermissions?.[toolName] ?? (effectivePermissions ? "deny" : "allow");
  const decision = configured === "deny" || effective === "deny"
    ? "deny"
    : configured === "ask" || effective === "ask" ? "ask" : "allow";
  if (decision === "allow") {
    return ok(undefined);
  }

  if (decision === "ask") {
    return err(new StrongCodeError("PERMISSION_DENIED", `Tool '${toolName}' requires ask permission, which is denied non-interactively in this MVP`));
  }

  return err(new StrongCodeError("PERMISSION_DENIED", `Tool '${toolName}' is denied`));
}
