import type { StrongCodeConfig } from "../../config/schema";
import {
  resolveConfiguredModelRoute,
  type AgentModelResolution,
  type AgentModelRoutingOptions
} from "../model-routing";
import type { PreflightRole } from "./metadata";
import { getPreflightAgentDefinition } from "./roles";

export function resolvePreflightModel(
  config: StrongCodeConfig,
  role: PreflightRole,
  options: AgentModelRoutingOptions = {}
): AgentModelResolution {
  const definition = getPreflightAgentDefinition(role);
  const route = config.preflight?.[role];
  return resolveConfiguredModelRoute(config, {
    label: definition.displayName,
    route,
    preferences: route ? [] : definition.modelPreferences,
    allowGenericFallback: false
  }, options);
}
