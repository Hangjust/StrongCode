import type { AgentConfig, ModelConfig, ProviderConfig, StrongCodeConfig } from "../config/schema";
import { StrongCodeError } from "../core/errors";
import { isModelProviderConstructable } from "../models/factory";
import { AgentDefinition, AgentModelPreference, getAgentDefinition } from "./registry";

export type AgentModelProvenance =
  | "agent-override"
  | "user-fallback"
  | "agent-preference"
  | "configured-default"
  | "available-fallback";

export interface AgentModelResolution {
  modelId: string;
  providerId: string;
  model: ModelConfig;
  provenance: AgentModelProvenance;
  preference?: string;
}

export interface AgentModelRoutingOptions {
  /** When supplied, non-local models must belong to one of these connected providers. */
  connectedProviderIds?: Iterable<string>;
  /** Override the built-in runtime support check for embedders with extra adapters. */
  providerIsRunnable?: (providerId: string, provider: ProviderConfig) => boolean;
}

export type ConfiguredModelRoute = {
  readonly model?: string;
  readonly fallbackModels?: readonly string[];
};

export type ConfiguredModelRouteRequest = {
  readonly label: string;
  readonly route?: ConfiguredModelRoute;
  readonly preferences: readonly AgentModelPreference[];
  readonly allowGenericFallback?: boolean;
};

interface Candidate {
  modelId: string;
  providerId: string;
  model: ModelConfig;
  provider: ProviderConfig;
  searchValues: string[];
  identityTokens: ReadonlySet<string>;
}

const RUNTIME_PROVIDER_TYPES = new Set(["mock", "openai", "openai-compatible", "anthropic", "google", "chatgpt", "codex-cli", "google-vertex"]);

export function normalizeModelName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function semanticTokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
}

function defaultProviderIsRunnable(providerId: string, provider: ProviderConfig): boolean {
  return RUNTIME_PROVIDER_TYPES.has(provider.type);
}

function exactConfiguredModelIsRunnable(
  config: StrongCodeConfig,
  modelId: string,
  allowEnvironmentCredentials: boolean | undefined
): boolean {
  const model = config.models[modelId];
  if (!model || model.enabled === false) return false;
  const provider = config.providers[model.provider];
  return Boolean(provider && provider.enabled !== false && isModelProviderConstructable({
    providerId: model.provider,
    providerConfig: provider,
    allowEnvironmentCredentials
  }));
}

export function firstUnavailableExactModel(
  config: StrongCodeConfig,
  modelIds: readonly string[],
  allowEnvironmentCredentials?: boolean
): string | undefined {
  return modelIds.find(modelId => !exactConfiguredModelIsRunnable(config, modelId, allowEnvironmentCredentials));
}

function isLoopbackBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

function candidates(config: StrongCodeConfig, options: AgentModelRoutingOptions): Candidate[] {
  const connected = options.connectedProviderIds ? new Set(options.connectedProviderIds) : undefined;
  const providerIsRunnable = options.providerIsRunnable ?? defaultProviderIsRunnable;
  return Object.entries(config.models).flatMap(([modelId, model]) => {
    const provider = config.providers[model.provider];
    if (!provider || provider.enabled === false || model.enabled === false) return [];
    if (!providerIsRunnable(model.provider, provider)) return [];
    if (connected && provider.type !== "mock" && !isLoopbackBaseUrl(provider.baseUrl) && !connected.has(model.provider)) return [];
    const identityValues = [modelId, model.model ?? "", model.displayName ?? "", model.provider, provider.displayName];
    return [{
      modelId,
      providerId: model.provider,
      model,
      provider,
      searchValues: [
        ...identityValues,
        `${model.provider}/${model.model ?? modelId}`
      ].map(normalizeModelName).filter(Boolean),
      identityTokens: new Set(identityValues.flatMap(semanticTokens))
    }];
  });
}

function configuredAgent(config: StrongCodeConfig, definition: AgentDefinition): AgentConfig | undefined {
  const direct = config.agents[definition.id];
  if (direct) return direct;
  return Object.entries(config.agents).find(([name]) => getAgentDefinition(name)?.id === definition.id)?.[1];
}

function candidateById(values: Candidate[], modelId: string | undefined): Candidate | undefined {
  if (!modelId) return undefined;
  return values.find(candidate => candidate.modelId === modelId)
    ?? values.find(candidate => candidate.model.model === modelId);
}

function candidateIdentity(candidate: Candidate): string {
  return `${normalizeModelName(candidate.providerId)}:${normalizeModelName(candidate.model.model ?? candidate.modelId)}`;
}

function providerMatches(candidate: Candidate, preference: AgentModelPreference): boolean {
  if (!preference.providers?.length) return true;
  const providerValues = [candidate.providerId, candidate.provider.displayName].map(normalizeModelName);
  return preference.providers.some(value => {
    const normalized = normalizeModelName(value);
    return providerValues.some(provider => provider === normalized || provider.includes(normalized) || normalized.includes(provider));
  });
}

function requiredTokensMatch(candidate: Candidate, preference: AgentModelPreference): boolean {
  return preference.requiredTokens?.every(token => candidate.identityTokens.has(token.toLowerCase())) ?? true;
}

function patternScore(candidate: Candidate, pattern: string): number {
  const normalized = normalizeModelName(pattern);
  if (!normalized) return 0;
  let best = 0;
  for (const value of candidate.searchValues) {
    if (value === normalized) best = Math.max(best, 1000);
    else if (value.startsWith(normalized) || normalized.startsWith(value)) best = Math.max(best, 700 - Math.abs(value.length - normalized.length));
    else if (value.includes(normalized) || normalized.includes(value)) best = Math.max(best, 500 - Math.abs(value.length - normalized.length));
  }
  return best;
}

function bestPreferenceCandidate(values: Candidate[], preference: AgentModelPreference, excluded: Set<string>): Candidate | undefined {
  return values
    .filter(candidate => !excluded.has(candidateIdentity(candidate)) && providerMatches(candidate, preference) && requiredTokensMatch(candidate, preference))
    .map(candidate => ({ candidate, score: Math.max(...preference.patterns.map(pattern => patternScore(candidate, pattern)), 0) }))
    .filter(match => match.score > 0)
    .sort((left, right) => right.score - left.score || left.candidate.modelId.localeCompare(right.candidate.modelId))[0]?.candidate;
}

function result(candidate: Candidate, provenance: AgentModelProvenance, preference?: string): AgentModelResolution {
  return {
    modelId: candidate.modelId,
    providerId: candidate.providerId,
    model: candidate.model,
    provenance,
    preference
  };
}

export function resolveConfiguredModelRoute(
  config: StrongCodeConfig,
  request: ConfiguredModelRouteRequest,
  options: AgentModelRoutingOptions = {}
): AgentModelResolution {
  const available = candidates(config, options);
  const explicit = candidateById(available, request.route?.model);
  if (explicit) return result(explicit, "agent-override");

  for (const modelId of request.route?.fallbackModels ?? []) {
    const fallback = candidateById(available, modelId);
    if (fallback) return result(fallback, "user-fallback");
  }

  for (const preference of request.preferences) {
    const preferred = bestPreferenceCandidate(available, preference, new Set());
    if (preferred) return result(preferred, "agent-preference", preference.label);
  }

  if (request.allowGenericFallback !== false) {
    const configuredDefault = candidateById(available, config.agents[config.defaultAgent]?.model);
    if (configuredDefault) return result(configuredDefault, "configured-default");

    const fallback = available[0];
    if (fallback) return result(fallback, "available-fallback");
  }

  throw new StrongCodeError("MODEL_ERROR", `No enabled, runnable model is available for ${request.label}. Complete onboarding or connect a provider first.`);
}

/** Resolve one runnable model while recording why it was selected. */
export function resolveAgentModel(
  config: StrongCodeConfig,
  definition: AgentDefinition,
  options: AgentModelRoutingOptions = {}
): AgentModelResolution {
  const override = configuredAgent(config, definition);
  return resolveConfiguredModelRoute(config, {
    label: definition.displayName,
    route: override,
    preferences: definition.modelPreferences
  }, options);
}

/**
 * Resolve an ordered set of distinct models for ensemble agents. The normal
 * single-model winner stays first, followed by user fallbacks, preference
 * matches, and finally any other runnable models.
 */
export function resolveAgentModelSet(
  config: StrongCodeConfig,
  definition: AgentDefinition,
  minimum = definition.orchestration.minimumDistinctModels ?? 1,
  options: AgentModelRoutingOptions = {}
): AgentModelResolution[] {
  const available = candidates(config, options);
  const selected: AgentModelResolution[] = [];
  const used = new Set<string>();
  const add = (candidate: Candidate | undefined, provenance: AgentModelProvenance, preference?: string) => {
    if (!candidate) return;
    const identity = candidateIdentity(candidate);
    if (used.has(identity)) return;
    used.add(identity);
    selected.push(result(candidate, provenance, preference));
  };

  const override = configuredAgent(config, definition);
  add(candidateById(available, override?.model), "agent-override");
  for (const modelId of override?.fallbackModels ?? []) add(candidateById(available, modelId), "user-fallback");
  for (const preference of definition.modelPreferences) {
    add(bestPreferenceCandidate(available, preference, used), "agent-preference", preference.label);
  }
  add(candidateById(available, config.agents[config.defaultAgent]?.model), "configured-default");
  for (const candidate of available) add(candidate, "available-fallback");

  if (selected.length < minimum) {
    throw new StrongCodeError(
      "MODEL_ERROR",
      `${definition.displayName} requires at least ${minimum} distinct enabled models, but only ${selected.length} ${selected.length === 1 ? "is" : "are"} available. Connect more providers or enable more models in onboarding.`
    );
  }

  const maximum = Math.max(minimum, definition.orchestration.maximumDistinctModels ?? selected.length);
  return selected.slice(0, maximum);
}

export function modelRoutingAgentConfig(config: StrongCodeConfig, definition: AgentDefinition): AgentConfig {
  return configuredAgent(config, definition) ?? config.agents[config.defaultAgent];
}
