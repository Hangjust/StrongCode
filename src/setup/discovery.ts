import type { ProviderConfig } from "../config/schema";
import { StrongCodeError } from "../core/errors";
import { buildProviderUrl, parseProviderBaseUrl } from "../models/provider-url";
import { readBoundedResponseText } from "../models/response-body";

export interface SetupDiscoveredModel {
  id: string;
  displayName: string;
}

export interface SetupDiscoveryOptions {
  fetcher?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export class SetupDiscoveryHttpError extends StrongCodeError {
  readonly status: number;

  constructor(status: number) {
    super("MODEL_ERROR", `Model discovery failed with HTTP ${status}`);
    this.name = "SetupDiscoveryHttpError";
    this.status = status;
  }
}

const MAX_MODEL_ID_LENGTH = 256;
const MAX_MODEL_DISPLAY_NAME_LENGTH = 160;
const MAX_DISCOVERY_PAGES = 25;
const MAX_DISCOVERED_MODELS = 10_000;
const MAX_AGGREGATE_DISCOVERY_BYTES = 20 * 1024 * 1024;
const UNSAFE_MODEL_TEXT = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;
const UNSAFE_MODEL_DISPLAY_TEXT = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu;
const ANSI_ESCAPE_SEQUENCE = /\u001B\[[0-?]*[ -/]*[@-~]/gu;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function safeModelId(value: unknown): string | undefined {
  if (typeof value !== "string" || UNSAFE_MODEL_TEXT.test(value)) return undefined;
  const id = value.trim();
  return id.length > 0 && id.length <= MAX_MODEL_ID_LENGTH ? id : undefined;
}

function safeModelDisplayName(value: unknown, fallback: string): string {
  const source = typeof value === "string" ? value : fallback;
  const sanitized = source
    .replace(ANSI_ESCAPE_SEQUENCE, "")
    .replace(UNSAFE_MODEL_DISPLAY_TEXT, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const capped = Array.from(sanitized || fallback).slice(0, MAX_MODEL_DISPLAY_NAME_LENGTH).join("").trim();
  return capped || fallback;
}

function unique(models: SetupDiscoveredModel[]): SetupDiscoveredModel[] {
  const seen = new Set<string>();
  return models.filter(model => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  }).sort((left, right) => left.displayName.localeCompare(right.displayName));
}

function parseModels(type: string, payload: unknown): SetupDiscoveredModel[] {
  const root = record(payload);
  const values = type === "google"
    ? root?.models
    : root?.data ?? root?.models;
  if (!Array.isArray(values)) throw new StrongCodeError("MODEL_ERROR", "Model discovery response did not contain a model list");
  return unique(values.flatMap(value => {
    const model = record(value);
    const rawId = [model?.id, model?.name, model?.model, model?.key]
      .find(candidate => typeof candidate === "string" && candidate.trim().length > 0);
    let id = safeModelId(rawId);
    if (!id) return [];
    if (type === "google" && id.startsWith("models/")) id = id.slice("models/".length);
    if (!safeModelId(id)) return [];
    const displayName = string(model?.displayName) ?? string(model?.display_name);
    return [{ id, displayName: safeModelDisplayName(displayName, id) }];
  }));
}

async function boundedJson(response: Response, maxResponseBytes: number): Promise<{ payload: unknown; bytes: number }> {
  const text = await readBoundedResponseText(response, {
    maxBytes: maxResponseBytes,
    tooLargeMessage: "Model discovery response is too large"
  });
  try {
    return { payload: JSON.parse(text), bytes: Buffer.byteLength(text, "utf8") };
  } catch {
    throw new StrongCodeError("MODEL_ERROR", "Model discovery response was not valid JSON");
  }
}

function discoveryHeaders(provider: ProviderConfig, apiKey: string): Record<string, string> {
  if (provider.type === "anthropic") {
    return {
      "anthropic-version": "2023-06-01",
      ...(apiKey ? { "x-api-key": apiKey } : {})
    };
  }
  if (provider.type === "google") return apiKey ? { "x-goog-api-key": apiKey } : {};
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

export async function discoverModelsForSetup(provider: ProviderConfig, apiKey: string, options: SetupDiscoveryOptions = {}): Promise<SetupDiscoveredModel[]> {
  parseProviderBaseUrl(provider.baseUrl, "setup model discovery");
  const baseUrl = buildProviderUrl(provider.baseUrl, provider.modelsEndpoint ?? "/models", "setup model discovery");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);
  try {
    const models: SetupDiscoveredModel[] = [];
    const seenTokens = new Set<string>();
    let aggregateBytes = 0;
    let url = baseUrl;
    for (let page = 0; page < MAX_DISCOVERY_PAGES; page += 1) {
      const response = await (options.fetcher ?? fetch)(url, {
        method: "GET",
        headers: discoveryHeaders(provider, apiKey),
        redirect: "error",
        signal: controller.signal
      });
      if (!response.ok) throw new SetupDiscoveryHttpError(response.status);
      const pageResult = await boundedJson(response, options.maxResponseBytes ?? 5 * 1024 * 1024);
      const payload = pageResult.payload;
      aggregateBytes += pageResult.bytes;
      if (aggregateBytes > MAX_AGGREGATE_DISCOVERY_BYTES) {
        throw new StrongCodeError("MODEL_ERROR", "Model discovery exceeded the aggregate response limit");
      }
      models.push(...parseModels(provider.type, payload));
      if (models.length > MAX_DISCOVERED_MODELS) {
        throw new StrongCodeError("MODEL_ERROR", `Model discovery exceeded the ${MAX_DISCOVERED_MODELS} model safety limit`);
      }
      const root = record(payload);
      const token = provider.type === "google"
        ? string(root?.nextPageToken)
        : provider.type === "anthropic" && root?.has_more === true ? string(root?.last_id) : undefined;
      if (!token || seenTokens.has(token)) break;
      if (page === MAX_DISCOVERY_PAGES - 1) {
        throw new StrongCodeError("MODEL_ERROR", "Model discovery exceeded the page limit");
      }
      seenTokens.add(token);
      const next = new URL(baseUrl);
      next.searchParams.set(provider.type === "google" ? "pageToken" : "after_id", token);
      url = next.toString();
    }
    return unique(models);
  } catch (error) {
    if (error instanceof StrongCodeError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw new StrongCodeError("MODEL_ERROR", "Model discovery timed out");
    throw new StrongCodeError("MODEL_ERROR", `Model discovery request failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

export interface LocalProviderCandidate {
  id: "ollama" | "lmstudio" | "vllm";
  label: string;
  baseUrl: string;
  modelsEndpoint: string;
  nativeUrl?: string;
}

export interface DiscoveredLocalProvider extends LocalProviderCandidate {
  models: SetupDiscoveredModel[];
}

export const LOCAL_PROVIDER_CANDIDATES: LocalProviderCandidate[] = [
  { id: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", modelsEndpoint: "/models", nativeUrl: "http://127.0.0.1:11434/api/tags" },
  { id: "lmstudio", label: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", modelsEndpoint: "/models", nativeUrl: "http://127.0.0.1:1234/api/v1/models" },
  { id: "vllm", label: "vLLM", baseUrl: "http://127.0.0.1:8000/v1", modelsEndpoint: "/models" }
];

async function discoverNativeLocal(candidate: LocalProviderCandidate, options: SetupDiscoveryOptions): Promise<SetupDiscoveredModel[]> {
  if (!candidate.nativeUrl) return [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 1_500);
  try {
    const response = await (options.fetcher ?? fetch)(candidate.nativeUrl, { method: "GET", redirect: "error", signal: controller.signal });
    if (!response.ok) return [];
    const result = await boundedJson(response, options.maxResponseBytes ?? 5 * 1024 * 1024);
    return parseModels(candidate.id === "ollama" ? "ollama" : "lmstudio", result.payload);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export async function scanLocalProviders(options: SetupDiscoveryOptions = {}): Promise<DiscoveredLocalProvider[]> {
  const found = await Promise.all(LOCAL_PROVIDER_CANDIDATES.map(async candidate => {
    try {
      const models = await discoverModelsForSetup({
        type: "openai-compatible",
        displayName: candidate.label,
        apiKeyEnv: undefined,
        baseUrl: candidate.baseUrl,
        modelsEndpoint: candidate.modelsEndpoint,
        allowUnauthenticated: true,
        enabled: true
      }, "", { ...options, timeoutMs: options.timeoutMs ?? 1_500 });
      return models.length ? { ...candidate, models } : undefined;
    } catch {
      const models = await discoverNativeLocal(candidate, options);
      return models.length ? { ...candidate, models } : undefined;
    }
  }));
  return found.filter((candidate): candidate is DiscoveredLocalProvider => Boolean(candidate));
}
