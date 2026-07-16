import { ModelConfig, ProviderConfig } from "../config/schema";
import { ModelProvider } from "./provider";
import { MockModelProvider, UnsupportedModelProvider } from "./mock-provider";
import { OpenAICompatibleFetcher, OpenAICompatibleModelProvider } from "./openai-compatible-provider";
import type { ProviderAuthReader } from "./auth-store";
import { AnthropicModelProvider } from "./anthropic-provider";
import { GoogleGeminiModelProvider } from "./google-provider";
import { GoogleVertexModelProvider } from "./google-vertex-provider";
import { StrongCodeError } from "../core/errors";
import { ChatGptModelProvider } from "./chatgpt-provider";
import type { ChatGptOAuthFetch } from "./chatgpt-oauth";
import { parseProviderBaseUrl } from "./provider-url";

export interface CreateModelProviderOptions {
  providerId: string;
  providerConfig: ProviderConfig;
  modelId: string;
  modelConfig: ModelConfig;
  fetcher?: OpenAICompatibleFetcher;
  chatGptFetch?: ChatGptOAuthFetch;
  authStore?: ProviderAuthReader;
  allowEnvironmentCredentials?: boolean;
  cwd?: string;
}

export type ModelProviderConstructabilityOptions = Pick<
  CreateModelProviderOptions,
  "providerId" | "providerConfig" | "allowEnvironmentCredentials"
>;

function hasValidBaseUrl(provider: ProviderConfig): boolean {
  if (!provider.baseUrl) return false;
  try {
    parseProviderBaseUrl(provider.baseUrl, "model provider");
    return true;
  } catch {
    return false;
  }
}

function validVertexSegment(value: string | undefined): boolean {
  return Boolean(value && /^[A-Za-z0-9._-]+$/u.test(value));
}

function hasValidVertexEndpoint(provider: ProviderConfig): boolean {
  if (!provider.baseUrl) return true;
  try {
    const parsed = parseProviderBaseUrl(provider.baseUrl, "Google Vertex AI");
    const location = provider.location;
    if (!location) return false;
    const allowedHosts = new Set(["aiplatform.googleapis.com", `${location}-aiplatform.googleapis.com`]);
    return parsed.protocol === "https:" && parsed.port === "" && allowedHosts.has(parsed.hostname);
  } catch {
    return false;
  }
}

export function isModelProviderConstructable(options: ModelProviderConstructabilityOptions): boolean {
  const provider = options.providerConfig;
  if (
    options.allowEnvironmentCredentials === false
    && ["chatgpt", "codex-cli", "google-vertex"].includes(provider.type)
  ) return false;
  switch (provider.type) {
    case "mock":
      return true;
    case "openai":
    case "openai-compatible":
    case "anthropic":
    case "google":
      return hasValidBaseUrl(provider);
    case "chatgpt":
    case "codex-cli":
      return true;
    case "google-vertex":
      return validVertexSegment(provider.projectId)
        && validVertexSegment(provider.location)
        && hasValidVertexEndpoint(provider);
    default:
      return false;
  }
}

export function createModelProvider(options: CreateModelProviderOptions): ModelProvider {
  if (options.providerConfig.type === "mock") {
    return new MockModelProvider();
  }

  if (
    options.allowEnvironmentCredentials === false
    && ["chatgpt", "codex-cli", "google-vertex"].includes(options.providerConfig.type)
  ) {
    throw new StrongCodeError(
      "CONFIG_ERROR",
      `Provider '${options.providerId}' uses user-account credentials and cannot be selected by an untrusted project config; set STRONGCODE_TRUST_PROJECT_CONFIG=1 only after reviewing the repository config`
    );
  }

  if (options.providerConfig.type === "openai" || options.providerConfig.type === "openai-compatible") {
    return new OpenAICompatibleModelProvider(options);
  }

  if (options.providerConfig.type === "anthropic" && options.providerConfig.baseUrl) {
    return new AnthropicModelProvider(options);
  }

  if (options.providerConfig.type === "google" && options.providerConfig.baseUrl) {
    return new GoogleGeminiModelProvider(options);
  }

  if (options.providerConfig.type === "chatgpt") {
    return new ChatGptModelProvider({ ...options, fetcher: options.chatGptFetch });
  }

  if (options.providerConfig.type === "codex-cli") {
    return new ChatGptModelProvider({ ...options, fetcher: options.chatGptFetch });
  }

  if (options.providerConfig.type === "google-vertex") {
    return new GoogleVertexModelProvider(options);
  }

  return new UnsupportedModelProvider(options.providerId, options.providerConfig.type);
}
