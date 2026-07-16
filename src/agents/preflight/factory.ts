import type { Agent } from "../agent";
import type { StrongCodeConfig } from "../../config/schema";
import { StrongCodeError } from "../../core/errors";
import { createModelProvider } from "../../models/factory";
import type { ProviderAuthReader } from "../../models/auth-store";
import type { ChatGptOAuthFetch } from "../../models/chatgpt-oauth";
import type { OpenAICompatibleFetcher } from "../../models/openai-compatible-provider";
import { effectiveConfiguredTools } from "../../tools/capability-policy";
import type { PreflightRole } from "./metadata";
import { resolvePreflightModel } from "./routing";
import { getPreflightAgentDefinition } from "./roles";

export type CreatePreflightAgentOptions = {
  readonly modelFetch?: OpenAICompatibleFetcher;
  readonly chatGptFetch?: ChatGptOAuthFetch;
  readonly authStore?: ProviderAuthReader;
  readonly allowEnvironmentCredentials?: boolean;
  readonly workspaceRoot?: string;
};

export function createPreflightAgent(
  config: StrongCodeConfig,
  role: PreflightRole,
  options: CreatePreflightAgentOptions = {}
): Agent {
  const definition = getPreflightAgentDefinition(role);
  const resolution = resolvePreflightModel(config, role);
  const route = config.preflight?.[role];
  const baseAgent = config.agents[config.defaultAgent];
  if (!baseAgent) {
    throw new StrongCodeError("CONFIG_ERROR", `Default agent not found: ${config.defaultAgent}`);
  }
  const providerConfig = config.providers[resolution.providerId];
  if (!providerConfig) {
    throw new StrongCodeError("CONFIG_ERROR", `Provider not found: ${resolution.providerId}`);
  }
  const agentConfig = {
    ...baseAgent,
    model: resolution.modelId,
    tools: effectiveConfiguredTools(role, route?.tools ?? baseAgent.tools),
    displayName: definition.displayName,
    hidden: true,
    mode: "subagent" as const,
    systemPrompt: undefined
  };
  return {
    name: definition.id,
    displayName: definition.displayName,
    runtimeRole: role,
    config: agentConfig,
    model: createModelProvider({
      providerId: resolution.providerId,
      providerConfig,
      modelId: resolution.modelId,
      modelConfig: resolution.model,
      fetcher: options.modelFetch,
      chatGptFetch: options.chatGptFetch,
      authStore: options.authStore,
      allowEnvironmentCredentials: options.allowEnvironmentCredentials,
      cwd: options.workspaceRoot
    }),
    systemPrompt: definition.systemPrompt,
    modelResolution: resolution
  };
}
