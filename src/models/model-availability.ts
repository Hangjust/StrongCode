import type { ModelConfig, ProviderConfig, StrongCodeConfig } from "../config/schema";
import { discoverOpenAICompatibleModels, DiscoveryFetcher } from "./discovery";
import type { ProviderAuth, ProviderAuthReader } from "./auth-store";
import { orderedProviders } from "./registry";

export interface ModelAvailabilityResult {
  config: StrongCodeConfig;
  changed: boolean;
  discovered: number;
  failures: string[];
}

interface AuthStoreWithAll extends ProviderAuthReader {
  all(): Promise<Record<string, ProviderAuth>>;
}

function providerHasCredentials(providerId: string, provider: ProviderConfig, auth: ProviderAuth | undefined): boolean {
  if (provider.apiKeyEnv && process.env[provider.apiKeyEnv]) return true;
  if (auth?.type === "api" && auth.key.length > 0) return true;
  return providerId === "openai" && auth?.type === "oauth" && auth.access.length > 0;
}

export function supportsAuthenticatedModelDiscovery(provider: ProviderConfig): boolean {
  return (provider.type === "openai" || provider.type === "openai-compatible") && Boolean(provider.baseUrl);
}

function existingModelKey(models: StrongCodeConfig["models"], providerId: string, modelId: string): string | undefined {
  return Object.entries(models).find(([key, model]) => model.provider === providerId && (key === modelId || model.model === modelId))?.[0];
}

function nextModelKey(models: StrongCodeConfig["models"], providerId: string, modelId: string): string {
  const existing = existingModelKey(models, providerId, modelId);
  if (existing) return existing;
  if (!models[modelId]) return modelId;

  const base = `${providerId}:${modelId}`;
  if (!models[base]) return base;

  let suffix = 2;
  while (models[`${base}:${suffix}`]) suffix += 1;
  return `${base}:${suffix}`;
}

function sameModel(left: ModelConfig | undefined, right: ModelConfig): boolean {
  return left?.provider === right.provider
    && left.model === right.model
    && left.displayName === right.displayName
    && left.enabled === right.enabled
    && left.source === right.source;
}

function safeFailure(providerId: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Model discovery failed for ${providerId}: ${message}`;
}

export async function discoverAuthenticatedProviderModels(config: StrongCodeConfig, authStore: AuthStoreWithAll, fetcher: DiscoveryFetcher): Promise<ModelAvailabilityResult> {
  const auth = await authStore.all();
  const nextModels: StrongCodeConfig["models"] = { ...config.models };
  const failures: string[] = [];
  let discovered = 0;
  let changed = false;

  for (const { id: providerId, config: provider } of orderedProviders(config.providers)) {
    if (!supportsAuthenticatedModelDiscovery(provider)) continue;
    if (!providerHasCredentials(providerId, provider, auth[providerId])) continue;

    try {
      const models = await discoverOpenAICompatibleModels({
        id: providerId,
        ...provider,
        authStore
      }, fetcher);

      for (const model of models) {
        const key = nextModelKey(nextModels, providerId, model.id);
        const existing = nextModels[key];
        const nextModel: ModelConfig = {
          provider: providerId,
          model: model.id,
          displayName: existing?.displayName ?? model.displayName,
          enabled: existing?.enabled ?? true,
          source: existing?.source ?? model.source,
          options: existing?.options
        };

        if (!sameModel(existing, nextModel)) {
          nextModels[key] = nextModel;
          changed = true;
        }
        discovered += 1;
      }
    } catch (error) {
      failures.push(safeFailure(providerId, error));
    }
  }

  return {
    config: changed ? { ...config, models: nextModels } : config,
    changed,
    discovered,
    failures
  };
}
