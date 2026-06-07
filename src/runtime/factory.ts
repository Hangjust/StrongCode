import { DEFAULT_CONFIG_PATH, loadConfig } from "../config/load";
import { StrongCodeConfig } from "../config/schema";
import { StrongCodeError } from "../core/errors";
import { Agent } from "../agents/agent";
import { createModelProvider } from "../models/factory";
import { OpenAICompatibleFetcher } from "../models/openai-compatible-provider";
import type { ProviderAuthReader } from "../models/auth-store";
import { createRuntimeContext, RuntimeContext } from "./context";

export interface CreateAgentOptions {
  modelFetch?: OpenAICompatibleFetcher;
  authStore?: ProviderAuthReader;
}

export async function requireRuntime(configPath?: string): Promise<{ config: StrongCodeConfig; context: RuntimeContext }> {
  const loaded = await loadConfig(configPath ?? DEFAULT_CONFIG_PATH);
  if (!loaded.ok) {
    throw loaded.error;
  }

  return {
    config: loaded.value.config,
    context: createRuntimeContext(loaded.value.config, loaded.value.path, loaded.value.directory)
  };
}

export function createAgent(config: StrongCodeConfig, agentName: string, options: CreateAgentOptions = {}): Agent {
  const agentConfig = config.agents[agentName];
  if (!agentConfig) {
    throw new StrongCodeError("CONFIG_ERROR", `Agent not found: ${agentName}`);
  }

  const modelConfig = config.models[agentConfig.model];
  if (!modelConfig) {
    throw new StrongCodeError("CONFIG_ERROR", `Model not found: ${agentConfig.model}`);
  }

  const providerConfig = config.providers[modelConfig.provider];
  if (!providerConfig) {
    throw new StrongCodeError("CONFIG_ERROR", `Provider not found: ${modelConfig.provider}`);
  }

  if (providerConfig.enabled === false) {
    throw new StrongCodeError("MODEL_ERROR", `Provider disabled: ${modelConfig.provider}`);
  }

  if (modelConfig.enabled === false) {
    throw new StrongCodeError("MODEL_ERROR", `Model disabled: ${agentConfig.model}`);
  }

  const provider = createModelProvider({
    providerId: modelConfig.provider,
    providerConfig,
    modelId: agentConfig.model,
    modelConfig,
    fetcher: options.modelFetch,
    authStore: options.authStore
  });

  return { name: agentName, config: agentConfig, model: provider };
}
