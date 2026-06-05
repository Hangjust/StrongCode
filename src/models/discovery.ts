import { StrongCodeError } from "../core/errors";
import { resolveProviderCredentials } from "./credentials";
import { buildProviderUrl } from "./provider-url";

export interface DiscoveredModel {
  id: string;
  provider: string;
  displayName: string;
  enabled: boolean;
  source: "discovered";
}

export interface DiscoveryProviderConfig {
  id?: string;
  type: string;
  displayName: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  modelsEndpoint?: string;
  enabled?: boolean;
}

export interface DiscoveryResponse {
  data?: Array<{ id?: unknown }>;
}

export interface DiscoveryFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type DiscoveryFetcher = (url: string, init: { method: "GET"; headers: Record<string, string> }) => Promise<DiscoveryFetchResponse>;

export function buildModelsUrl(providerConfig: Pick<DiscoveryProviderConfig, "baseUrl" | "modelsEndpoint">): string {
  return buildProviderUrl(providerConfig.baseUrl, providerConfig.modelsEndpoint ?? "/models", "model discovery");
}

export function globalFetchTransport(): DiscoveryFetcher {
  return async (url, init) => {
    if (typeof fetch !== "function") {
      throw new StrongCodeError("MODEL_ERROR", "Global fetch is not available for model discovery");
    }

    const response = await fetch(url, init);
    return {
      ok: response.ok,
      status: response.status,
      json: () => response.json()
    };
  };
}

export async function discoverOpenAICompatibleModels(providerConfig: DiscoveryProviderConfig, fetcher: DiscoveryFetcher): Promise<DiscoveredModel[]> {
  const url = buildModelsUrl(providerConfig);
  const credentials = providerConfig.apiKeyEnv ? resolveProviderCredentials(providerConfig.id ?? "custom", providerConfig) : undefined;
  const response = await fetcher(url, {
    method: "GET",
    headers: credentials ? { Authorization: `Bearer ${credentials.apiKey}` } : {}
  });

  if (!response.ok) {
    throw new StrongCodeError("MODEL_ERROR", `Model discovery failed with HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as DiscoveryResponse).data)) {
    throw new StrongCodeError("MODEL_ERROR", "Model discovery response must include a data array");
  }

  const provider = providerConfig.id ?? "custom";
  const models = (payload as DiscoveryResponse).data ?? [];
  return models
    .filter((model): model is { id: string } => typeof model.id === "string" && model.id.length > 0)
    .map(model => ({
      id: model.id,
      provider,
      displayName: model.id,
      enabled: false,
      source: "discovered"
    }));
}
