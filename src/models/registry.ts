import type { ProviderConfig } from "../config/schema";

export type ProviderId = "openai" | "kimi" | "anthropic" | "grok" | "mock" | "custom";

export interface ProviderMetadata {
  id: ProviderId;
  displayName: string;
  type: ProviderConfig["type"];
  apiKeyEnv?: string;
  baseUrl?: string;
  modelsEndpoint?: string;
  enabled: boolean;
}

export const BUILT_IN_PROVIDERS: ProviderMetadata[] = [
  {
    id: "openai",
    displayName: "GPT / OpenAI",
    type: "openai",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
    modelsEndpoint: "/models",
    enabled: false
  },
  {
    id: "kimi",
    displayName: "Kimi",
    type: "openai-compatible",
    apiKeyEnv: "MOONSHOT_API_KEY",
    baseUrl: "https://api.moonshot.ai/v1",
    modelsEndpoint: "/models",
    enabled: false
  },
  {
    id: "anthropic",
    displayName: "Claude",
    type: "anthropic",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    enabled: false
  },
  {
    id: "grok",
    displayName: "Grok",
    type: "openai-compatible",
    apiKeyEnv: "XAI_API_KEY",
    baseUrl: "https://api.x.ai/v1",
    modelsEndpoint: "/models",
    enabled: false
  },
  {
    id: "mock",
    displayName: "Mock",
    type: "mock",
    enabled: true
  },
  {
    id: "custom",
    displayName: "Custom Provider",
    type: "openai-compatible",
    apiKeyEnv: "CUSTOM_PROVIDER_API_KEY",
    modelsEndpoint: "/models",
    enabled: false
  }
];

const providerOrder = new Map(BUILT_IN_PROVIDERS.map((provider, index) => [provider.id, index]));

export function providerDefaults(): Record<string, ProviderConfig> {
  return Object.fromEntries(BUILT_IN_PROVIDERS.map(provider => [provider.id, {
    type: provider.type,
    displayName: provider.displayName,
    apiKeyEnv: provider.apiKeyEnv,
    baseUrl: provider.baseUrl,
    modelsEndpoint: provider.modelsEndpoint,
    enabled: provider.enabled
  }]));
}

export function mockProviderDefaults(): Record<string, ProviderConfig> {
  const mock = BUILT_IN_PROVIDERS.find(provider => provider.id === "mock");
  if (!mock) {
    return {};
  }

  return {
    mock: {
      type: mock.type,
      displayName: mock.displayName,
      apiKeyEnv: mock.apiKeyEnv,
      baseUrl: mock.baseUrl,
      modelsEndpoint: mock.modelsEndpoint,
      enabled: mock.enabled
    }
  };
}

export function withProviderDefaults(providers: Record<string, ProviderConfig>): Record<string, ProviderConfig> {
  return {
    ...providerDefaults(),
    ...providers
  };
}

export function getProviderDisplayName(providerId: string, providers: Record<string, ProviderConfig>): string {
  return providers[providerId]?.displayName ?? providerId;
}

export function orderedProviders(providers: Record<string, ProviderConfig>): Array<{ id: string; config: ProviderConfig }> {
  return Object.entries(providers)
    .map(([id, config]) => ({ id, config }))
    .sort((left, right) => {
      const leftOrder = providerOrder.get(left.id as ProviderId) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = providerOrder.get(right.id as ProviderId) ?? Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }

      return left.config.displayName.localeCompare(right.config.displayName);
    });
}
