import { ModelConfig, ProviderConfig } from "../config/schema";
import { ModelProvider } from "./provider";
import { MockModelProvider, UnsupportedModelProvider } from "./mock-provider";
import { OpenAICompatibleFetcher, OpenAICompatibleModelProvider } from "./openai-compatible-provider";

export interface CreateModelProviderOptions {
  providerId: string;
  providerConfig: ProviderConfig;
  modelId: string;
  modelConfig: ModelConfig;
  fetcher?: OpenAICompatibleFetcher;
}

export function createModelProvider(options: CreateModelProviderOptions): ModelProvider {
  if (options.providerConfig.type === "mock") {
    return new MockModelProvider();
  }

  if (options.providerConfig.type === "openai" || options.providerConfig.type === "openai-compatible") {
    return new OpenAICompatibleModelProvider(options);
  }

  return new UnsupportedModelProvider(options.providerId, options.providerConfig.type);
}
