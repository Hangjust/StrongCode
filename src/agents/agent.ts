import { AgentConfig } from "../config/schema";
import { ModelProvider } from "../models/provider";
import type { AgentModelResolution } from "./model-routing";
import type { AgentDefinition } from "./registry";

export type AgentRuntimeRole = "primary" | "child" | "summary" | "analysis" | "explorer";
export type AgentToolPolicy = "standard" | "read-only";

export interface Agent {
  name: string;
  runtimeRole?: AgentRuntimeRole;
  toolPolicy?: AgentToolPolicy;
  displayName?: string;
  config: AgentConfig;
  model: ModelProvider;
  systemPrompt?: string;
  definition?: AgentDefinition;
  modelResolution?: AgentModelResolution;
}
