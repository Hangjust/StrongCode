import { StrongCodeError } from "../core/errors";
import { resolveProviderCredentials, type ProviderCredentials } from "./credentials";
import type { ProviderAuthReader } from "./auth-store";
import { buildProviderUrl } from "./provider-url";
import { redactProviderSecret } from "./native-provider-utils";
import { readBoundedResponseText } from "./response-body";

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
  allowUnauthenticated?: boolean;
  enabled?: boolean;
  authStore?: ProviderAuthReader;
  allowEnvironmentCredentials?: boolean;
}

export interface DiscoveryResponse {
  data?: Array<{ id?: unknown; display_name?: unknown }>;
}

interface AnthropicDiscoveryResponse extends DiscoveryResponse {
  has_more?: unknown;
  last_id?: unknown;
}

interface GoogleDiscoveryResponse {
  models?: Array<{
    name?: unknown;
    baseModelId?: unknown;
    displayName?: unknown;
  }>;
  nextPageToken?: unknown;
}

export interface DiscoveryFetchResponse {
  ok: boolean;
  status: number;
  responseBytes?: number;
  json(): Promise<unknown>;
}

export type DiscoveryFetcher = (url: string, init: { method: "GET"; headers: Record<string, string> }) => Promise<DiscoveryFetchResponse>;

const MAX_DISCOVERY_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_AGGREGATE_DISCOVERY_BYTES = 20 * 1024 * 1024;
const MAX_DISCOVERY_PAGES = 25;
const MAX_DISCOVERED_MODELS = 10_000;
const MAX_MODEL_ID_LENGTH = 256;
const MAX_MODEL_DISPLAY_NAME_LENGTH = 160;
const UNSAFE_MODEL_TEXT = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;
const UNSAFE_MODEL_DISPLAY_TEXT = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu;
const ANSI_ESCAPE_SEQUENCE = /\u001B\[[0-?]*[ -/]*[@-~]/gu;

export function buildModelsUrl(providerConfig: Pick<DiscoveryProviderConfig, "baseUrl" | "modelsEndpoint">): string {
  return buildProviderUrl(providerConfig.baseUrl, providerConfig.modelsEndpoint ?? "/models", "model discovery");
}

export function globalFetchTransport(): DiscoveryFetcher {
  return async (url, init) => {
    if (typeof fetch !== "function") {
      throw new StrongCodeError("MODEL_ERROR", "Global fetch is not available for model discovery");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(url, { ...init, redirect: "error", signal: controller.signal });
      const text = await readBoundedResponseText(response, {
        maxBytes: MAX_DISCOVERY_RESPONSE_BYTES,
        tooLargeMessage: "Model discovery response exceeded 5 MB"
      });
      return {
        ok: response.ok,
        status: response.status,
        responseBytes: Buffer.byteLength(text, "utf8"),
        json: async () => JSON.parse(text)
      };
    } finally {
      clearTimeout(timeout);
    }
  };
}

function credentialSecret(credentials: ProviderCredentials | undefined): string {
  return credentials?.secret ?? "";
}

function bearerHeaders(credentials: ProviderCredentials | undefined): Record<string, string> {
  if (!credentials || credentials.type === "none") return {};
  return { Authorization: `Bearer ${credentials.apiKey}` };
}

function apiKey(credentials: ProviderCredentials, providerId: string): string {
  if (credentials.type !== "api") {
    throw new StrongCodeError("MODEL_ERROR", `Provider ${providerId} model discovery requires API-key authentication`);
  }
  return credentials.apiKey;
}

interface DiscoveryPage {
  payload: unknown;
  bytes: number;
}

async function fetchDiscoveryPage(fetcher: DiscoveryFetcher, url: string, headers: Record<string, string>, providerId: string, secret: string): Promise<DiscoveryPage> {
  let response: DiscoveryFetchResponse;
  try {
    response = await fetcher(url, { method: "GET", headers });
  } catch (error) {
    const detail = error instanceof Error ? redactProviderSecret(error.message, secret) : "request failed";
    throw new StrongCodeError("MODEL_ERROR", `Model discovery request failed for ${providerId}: ${detail}`);
  }
  if (!response.ok) {
    throw new StrongCodeError("MODEL_ERROR", `Model discovery failed with HTTP ${response.status}`);
  }
  try {
    const payload = await response.json();
    const serialized = response.responseBytes === undefined ? JSON.stringify(payload) : undefined;
    const bytes = response.responseBytes ?? Buffer.byteLength(serialized ?? "", "utf8");
    if (bytes > MAX_DISCOVERY_RESPONSE_BYTES) {
      throw new StrongCodeError("MODEL_ERROR", "Model discovery response exceeded 5 MB");
    }
    return { payload, bytes };
  } catch (error) {
    if (error instanceof StrongCodeError) throw error;
    const detail = error instanceof Error ? redactProviderSecret(error.message, secret) : "invalid JSON";
    throw new StrongCodeError("MODEL_ERROR", `Model discovery response was not valid JSON: ${detail}`);
  }
}

function assertDiscoveryBudget(bytes: number, models: number): void {
  if (bytes > MAX_AGGREGATE_DISCOVERY_BYTES) {
    throw new StrongCodeError("MODEL_ERROR", "Model discovery exceeded the aggregate response limit");
  }
  if (models > MAX_DISCOVERED_MODELS) {
    throw new StrongCodeError("MODEL_ERROR", "Model discovery exceeded the model count limit");
  }
}

function discoveredModel(provider: string, id: string, displayName = id): DiscoveredModel {
  return { id, provider, displayName, enabled: false, source: "discovered" };
}

function safeModelId(value: unknown): string | undefined {
  if (typeof value !== "string" || UNSAFE_MODEL_TEXT.test(value)) return undefined;
  const id = value.trim();
  return id.length > 0 && id.length <= MAX_MODEL_ID_LENGTH ? id : undefined;
}

function safeDisplayName(value: unknown, fallback: string): string {
  const source = typeof value === "string" ? value : fallback;
  const sanitized = source
    .replace(ANSI_ESCAPE_SEQUENCE, "")
    .replace(UNSAFE_MODEL_DISPLAY_TEXT, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return Array.from(sanitized || fallback).slice(0, MAX_MODEL_DISPLAY_NAME_LENGTH).join("");
}

function safeDiscoveredModel(provider: string, idValue: unknown, displayNameValue?: unknown): DiscoveredModel | undefined {
  const id = safeModelId(idValue);
  return id ? discoveredModel(provider, id, safeDisplayName(displayNameValue, id)) : undefined;
}

function dedupeModels(models: DiscoveredModel[]): DiscoveredModel[] {
  const seen = new Set<string>();
  return models.filter(model => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

function withPageToken(url: string, key: string, token: string): string {
  const next = new URL(url);
  next.searchParams.set(key, token);
  return next.toString();
}

export async function discoverOpenAICompatibleModels(providerConfig: DiscoveryProviderConfig, fetcher: DiscoveryFetcher): Promise<DiscoveredModel[]> {
  const provider = providerConfig.id ?? "custom";
  const url = buildModelsUrl(providerConfig);
  const credentials = providerConfig.apiKeyEnv || providerConfig.authStore
    ? await resolveProviderCredentials(provider, providerConfig, {
      authStore: providerConfig.authStore,
      allowEnvironmentCredentials: providerConfig.allowEnvironmentCredentials
    })
    : undefined;
  const page = await fetchDiscoveryPage(fetcher, url, bearerHeaders(credentials), provider, credentialSecret(credentials));
  const payload = page.payload;
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as DiscoveryResponse).data)) {
    throw new StrongCodeError("MODEL_ERROR", "Model discovery response must include a data array");
  }
  assertDiscoveryBudget(page.bytes, (payload as DiscoveryResponse).data?.length ?? 0);

  return dedupeModels(((payload as DiscoveryResponse).data ?? []).flatMap(model => {
    if (!model || typeof model !== "object") return [];
    const discovered = safeDiscoveredModel(provider, model.id, model.display_name);
    return discovered ? [discovered] : [];
  }));
}

export async function discoverAnthropicModels(providerConfig: DiscoveryProviderConfig, fetcher: DiscoveryFetcher): Promise<DiscoveredModel[]> {
  const provider = providerConfig.id ?? "anthropic";
  const credentials = await resolveProviderCredentials(provider, providerConfig, {
    authStore: providerConfig.authStore,
    allowEnvironmentCredentials: providerConfig.allowEnvironmentCredentials
  });
  const headers = {
    "x-api-key": apiKey(credentials, provider),
    "anthropic-version": "2023-06-01"
  };
  const models: DiscoveredModel[] = [];
  const seenTokens = new Set<string>();
  let aggregateBytes = 0;
  let aggregateModels = 0;
  let url = buildModelsUrl(providerConfig);

  for (let pageIndex = 0; pageIndex < MAX_DISCOVERY_PAGES; pageIndex += 1) {
    const page = await fetchDiscoveryPage(fetcher, url, headers, provider, credentials.secret);
    const payload = page.payload;
    if (!payload || typeof payload !== "object" || !Array.isArray((payload as AnthropicDiscoveryResponse).data)) {
      throw new StrongCodeError("MODEL_ERROR", "Anthropic model discovery response must include a data array");
    }
    aggregateBytes += page.bytes;
    aggregateModels += (payload as AnthropicDiscoveryResponse).data?.length ?? 0;
    assertDiscoveryBudget(aggregateBytes, aggregateModels);
    for (const model of (payload as AnthropicDiscoveryResponse).data ?? []) {
      if (!model || typeof model !== "object") continue;
      const discovered = safeDiscoveredModel(provider, model.id, model.display_name);
      if (discovered) models.push(discovered);
    }

    const hasMore = (payload as AnthropicDiscoveryResponse).has_more === true;
    const lastId = (payload as AnthropicDiscoveryResponse).last_id;
    if (!hasMore || typeof lastId !== "string" || lastId.length === 0 || seenTokens.has(lastId)) break;
    if (pageIndex === MAX_DISCOVERY_PAGES - 1) {
      throw new StrongCodeError("MODEL_ERROR", "Model discovery exceeded the page limit");
    }
    seenTokens.add(lastId);
    url = withPageToken(buildModelsUrl(providerConfig), "after_id", lastId);
  }
  return dedupeModels(models);
}

export async function discoverGoogleModels(providerConfig: DiscoveryProviderConfig, fetcher: DiscoveryFetcher): Promise<DiscoveredModel[]> {
  const provider = providerConfig.id ?? "google";
  const credentials = await resolveProviderCredentials(provider, providerConfig, {
    authStore: providerConfig.authStore,
    allowEnvironmentCredentials: providerConfig.allowEnvironmentCredentials
  });
  const headers = { "x-goog-api-key": apiKey(credentials, provider) };
  const models: DiscoveredModel[] = [];
  const seenTokens = new Set<string>();
  let aggregateBytes = 0;
  let aggregateModels = 0;
  let url = buildModelsUrl(providerConfig);

  for (let pageIndex = 0; pageIndex < MAX_DISCOVERY_PAGES; pageIndex += 1) {
    const page = await fetchDiscoveryPage(fetcher, url, headers, provider, credentials.secret);
    const payload = page.payload;
    if (!payload || typeof payload !== "object" || !Array.isArray((payload as GoogleDiscoveryResponse).models)) {
      throw new StrongCodeError("MODEL_ERROR", "Google model discovery response must include a models array");
    }
    aggregateBytes += page.bytes;
    aggregateModels += (payload as GoogleDiscoveryResponse).models?.length ?? 0;
    assertDiscoveryBudget(aggregateBytes, aggregateModels);
    for (const model of (payload as GoogleDiscoveryResponse).models ?? []) {
      if (!model || typeof model !== "object") continue;
      const name = typeof model.baseModelId === "string" && model.baseModelId.length > 0
        ? model.baseModelId
        : typeof model.name === "string" ? model.name.replace(/^models\//, "") : undefined;
      const discovered = safeDiscoveredModel(provider, name, model.displayName);
      if (discovered) models.push(discovered);
    }

    const token = (payload as GoogleDiscoveryResponse).nextPageToken;
    if (typeof token !== "string" || token.length === 0 || seenTokens.has(token)) break;
    if (pageIndex === MAX_DISCOVERY_PAGES - 1) {
      throw new StrongCodeError("MODEL_ERROR", "Model discovery exceeded the page limit");
    }
    seenTokens.add(token);
    url = withPageToken(buildModelsUrl(providerConfig), "pageToken", token);
  }
  return dedupeModels(models);
}

export async function discoverProviderModels(providerConfig: DiscoveryProviderConfig, fetcher: DiscoveryFetcher): Promise<DiscoveredModel[]> {
  if (providerConfig.type === "anthropic") return discoverAnthropicModels(providerConfig, fetcher);
  if (providerConfig.type === "google") return discoverGoogleModels(providerConfig, fetcher);
  if (providerConfig.type === "openai" || providerConfig.type === "openai-compatible") {
    return discoverOpenAICompatibleModels(providerConfig, fetcher);
  }
  throw new StrongCodeError("MODEL_ERROR", `Provider type '${providerConfig.type}' does not support model discovery`);
}
