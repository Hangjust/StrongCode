import type { ModelConfig, ProviderConfig, StrongCodeConfig } from "../config/schema";
import { orderedProviders } from "./registry";
import type { ProviderAuth } from "./auth-store";

export type ProviderAuthMethod = "none" | "api_key" | "oauth";
export type RuntimeSupportStatus = "supported" | "catalog-only";

export interface CatalogModel {
  id: string;
  displayName: string;
  provider: string;
  enabled: boolean;
  capabilities: string[];
  source: string;
}

export interface CatalogProvider {
  id: string;
  displayName: string;
  authMethods: ProviderAuthMethod[];
  models: CatalogModel[];
  modelCapabilities: Record<string, string[]>;
  runtimeSupport: RuntimeSupportStatus;
  connected: boolean;
}

export interface ProviderCatalog {
  all: CatalogProvider[];
  defaultProvider?: string;
  connected: string[];
}

function runtimeSupport(provider: ProviderConfig): RuntimeSupportStatus {
  return provider.type === "mock" || provider.type === "openai" || provider.type === "openai-compatible" ? "supported" : "catalog-only";
}

function authMethods(provider: ProviderConfig): ProviderAuthMethod[] {
  if (provider.type === "mock") return ["none"];
  if (provider.type === "openai") return ["api_key", "oauth"];
  return ["api_key"];
}

function hasApiAuth(auth: ProviderAuth | undefined): boolean {
  return auth?.type === "api" && auth.key.length > 0;
}

function providerConnected(provider: ProviderConfig, auth: ProviderAuth | undefined): boolean {
  if (provider.type === "mock") return true;
  if (provider.apiKeyEnv && process.env[provider.apiKeyEnv]) return true;
  if (provider.type === "openai" && auth?.type === "oauth" && auth.access.length > 0) return true;
  return hasApiAuth(auth);
}

function catalogModel(modelId: string, model: ModelConfig): CatalogModel {
  const capabilities = model.provider === "mock" ? ["chat", "tools"] : ["chat"];
  return {
    id: modelId,
    displayName: model.displayName ?? modelId,
    provider: model.provider,
    enabled: model.enabled !== false,
    capabilities,
    source: model.source ?? "config"
  };
}

export function createProviderCatalog(config: StrongCodeConfig, auth: Record<string, ProviderAuth> = {}): ProviderCatalog {
  const modelsByProvider = new Map<string, CatalogModel[]>();
  for (const [modelId, model] of Object.entries(config.models)) {
    const models = modelsByProvider.get(model.provider) ?? [];
    models.push(catalogModel(modelId, model));
    modelsByProvider.set(model.provider, models);
  }

  const defaultModel = config.models[config.agents[config.defaultAgent]?.model ?? ""];
  const all = orderedProviders(config.providers).map(({ id, config: provider }) => {
    const models = (modelsByProvider.get(id) ?? []).sort((left, right) => left.id.localeCompare(right.id));
    return {
      id,
      displayName: provider.displayName,
      authMethods: authMethods(provider),
      models,
      modelCapabilities: Object.fromEntries(models.map(model => [model.id, model.capabilities])),
      runtimeSupport: runtimeSupport(provider),
      connected: providerConnected(provider, auth[id])
    };
  });

  return {
    all,
    defaultProvider: defaultModel?.provider,
    connected: all.filter(provider => provider.connected).map(provider => provider.id)
  };
}
