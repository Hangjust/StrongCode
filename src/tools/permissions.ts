import { StrongCodeConfig } from "../config/schema";
import { StrongCodeError } from "../core/errors";
import { err, ok, Result } from "../core/result";

export function getToolPermission(config: StrongCodeConfig, toolName: string): "allow" | "ask" | "deny" {
  return config.permissions.tools[toolName] ?? "deny";
}

export function assertToolAllowed(config: StrongCodeConfig, toolName: string): Result<void> {
  const decision = getToolPermission(config, toolName);
  if (decision === "allow") {
    return ok(undefined);
  }

  if (decision === "ask") {
    return err(new StrongCodeError("PERMISSION_DENIED", `Tool '${toolName}' requires ask permission, which is denied non-interactively in this MVP`));
  }

  return err(new StrongCodeError("PERMISSION_DENIED", `Tool '${toolName}' is denied`));
}
