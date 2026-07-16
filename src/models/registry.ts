import type { ProviderConfig } from "../config/schema";
import { isLocalProviderBaseUrl } from "./provider-url";

export type ProviderId =
  | "chatgpt"
  | "openai"
  | "kimi"
  | "anthropic"
  | "grok"
  | "google"
  | "google-vertex"
  | "deepseek"
  | "zhipu"
  | "ollama"
  | "lmstudio"
  | "vllm"
  | "mock"
  | "custom";

export interface ProviderMetadata {
  id: ProviderId;
  displayName: string;
  type: ProviderConfig["type"];
  apiKeyEnv?: string;
  baseUrl?: string;
  modelsEndpoint?: string;
  authRequired: boolean;
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
    authRequired: true,
    enabled: false
  },
  {
    id: "kimi",
    displayName: "Kimi",
    type: "openai-compatible",
    apiKeyEnv: "MOONSHOT_API_KEY",
    baseUrl: "https://api.moonshot.ai/v1",
    modelsEndpoint: "/models",
    authRequired: true,
    enabled: false
  },
  {
    id: "anthropic",
    displayName: "Claude",
    type: "anthropic",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    baseUrl: "https://api.anthropic.com/v1",
    modelsEndpoint: "/models",
    authRequired: true,
    enabled: false
  },
  {
    id: "grok",
    displayName: "Grok",
    type: "openai-compatible",
    apiKeyEnv: "XAI_API_KEY",
    baseUrl: "https://api.x.ai/v1",
    modelsEndpoint: "/models",
    authRequired: true,
    enabled: false
  },
  {
    id: "chatgpt",
    displayName: "ChatGPT",
    type: "chatgpt",
    authRequired: true,
    enabled: false
  },
  {
    id: "google",
    displayName: "Google Gemini",
    type: "google",
    apiKeyEnv: "GEMINI_API_KEY",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    modelsEndpoint: "/models",
    authRequired: true,
    enabled: false
  },
  {
    id: "google-vertex",
    displayName: "Google Vertex AI (ADC)",
    type: "google-vertex",
    baseUrl: "https://aiplatform.googleapis.com",
    authRequired: true,
    enabled: false
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    type: "openai-compatible",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com",
    modelsEndpoint: "/models",
    authRequired: true,
    enabled: false
  },
  {
    id: "zhipu",
    displayName: "Zhipu GLM",
    type: "openai-compatible",
    apiKeyEnv: "ZAI_API_KEY",
    baseUrl: "https://api.z.ai/api/paas/v4",
    modelsEndpoint: "/models",
    authRequired: true,
    enabled: false
  },
  {
    id: "ollama",
    displayName: "Ollama (local)",
    type: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    modelsEndpoint: "/models",
    authRequired: false,
    enabled: false
  },
  {
    id: "lmstudio",
    displayName: "LM Studio (local)",
    type: "openai-compatible",
    baseUrl: "http://localhost:1234/v1",
    modelsEndpoint: "/models",
    authRequired: false,
    enabled: false
  },
  {
    id: "vllm",
    displayName: "vLLM (local)",
    type: "openai-compatible",
    baseUrl: "http://localhost:8000/v1",
    modelsEndpoint: "/models",
    authRequired: false,
    enabled: false
  },
  {
    id: "mock",
    displayName: "Mock",
    type: "mock",
    authRequired: false,
    enabled: true
  },
  {
    id: "custom",
    displayName: "Custom Provider",
    type: "openai-compatible",
    apiKeyEnv: "CUSTOM_PROVIDER_API_KEY",
    modelsEndpoint: "/models",
    authRequired: true,
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
    allowUnauthenticated: provider.authRequired ? undefined : provider.baseUrl ? true : undefined,
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
      allowUnauthenticated: undefined,
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

export function providerAuthRequired(providerId: string): boolean {
  return BUILT_IN_PROVIDERS.find(provider => provider.id === providerId)?.authRequired ?? true;
}

export function allowsCredentiallessLocalProvider(providerId: string, provider: { apiKeyEnv?: string | undefined; baseUrl?: string | undefined; allowUnauthenticated?: boolean | undefined }): boolean {
  return !provider.apiKeyEnv
    && (provider.allowUnauthenticated === true || !providerAuthRequired(providerId))
    && providerId !== "mock"
    && isLocalProviderBaseUrl(provider.baseUrl);
}
