import { StrongCodeError } from "../core/errors";
import type { ProviderAuthReader } from "./auth-store";
import { allowsCredentiallessLocalProvider } from "./registry";
import { parseProviderBaseUrl } from "./provider-url";

export type ProviderCredentials = ApiKeyProviderCredentials | NoAuthProviderCredentials;

export interface ApiKeyProviderCredentials {
  type: "api";
  apiKey: string;
  secret: string;
}

export interface NoAuthProviderCredentials {
  type: "none";
  secret: "";
}

export interface ResolveProviderCredentialsOptions {
  authStore?: ProviderAuthReader;
  /** Ambient API-key environment variables are only safe with a trusted provider configuration. */
  allowEnvironmentCredentials?: boolean;
}

function normalizedBaseUrl(value: string): string {
  return parseProviderBaseUrl(value, "credential binding").toString().replace(/\/$/, "");
}

export async function resolveProviderCredentials(providerId: string, providerConfig: { type?: string | undefined; apiKeyEnv?: string | undefined; baseUrl?: string | undefined; allowUnauthenticated?: boolean | undefined }, options: ResolveProviderCredentialsOptions = {}): Promise<ProviderCredentials> {
  const auth = await options.authStore?.get(providerId);
  if (auth?.type === "oauth") {
    throw new StrongCodeError("CONFIG_ERROR", `OAuth credentials are not valid for API provider ${providerId}; choose the ChatGPT browser or headless login instead`);
  }
  if (auth?.type === "api" && auth.metadata?.providerType && providerConfig.type && auth.metadata.providerType !== providerConfig.type) {
    throw new StrongCodeError("CONFIG_ERROR", `Saved credentials for ${providerId} are bound to provider type ${auth.metadata.providerType}; reconfigure this provider before use`);
  }
  if (auth?.type === "api" && auth.metadata?.origin) {
    if (!providerConfig.baseUrl || normalizedBaseUrl(auth.metadata.origin) !== normalizedBaseUrl(providerConfig.baseUrl)) {
      throw new StrongCodeError("CONFIG_ERROR", `Saved credentials for ${providerId} are bound to a different endpoint; reconfigure this provider before use`);
    }
  }
  if (
    options.allowEnvironmentCredentials === false
    && auth?.type === "api"
    && (!auth.metadata?.providerType || (providerConfig.baseUrl && !auth.metadata.origin))
  ) {
    throw new StrongCodeError(
      "CONFIG_ERROR",
      `Saved credentials for ${providerId} are not bound to this project provider type and endpoint; reconnect the provider before use`
    );
  }
  if (!providerConfig.apiKeyEnv) {
    if (auth?.type === "api") return { type: "api", apiKey: auth.key, secret: auth.key };
    if (allowsCredentiallessLocalProvider(providerId, providerConfig)) return { type: "none", secret: "" };
    throw new StrongCodeError("CONFIG_ERROR", `Provider ${providerId} requires apiKeyEnv or auth.json credentials`);
  }

  if (options.allowEnvironmentCredentials === false) {
    if (auth?.type === "api") return { type: "api", apiKey: auth.key, secret: auth.key };
    throw new StrongCodeError(
      "MODEL_ERROR",
      `Environment API keys are disabled for untrusted project provider ${providerId}; connect it to the project credential store or set STRONGCODE_TRUST_PROJECT_CONFIG=1`
    );
  }

  // An explicitly connected credential is authoritative. Environment values
  // remain a convenient fallback, but must not silently shadow a newer key
  // saved by setup or `/connect` (for example, a stale user-level variable).
  if (auth?.type === "api") return { type: "api", apiKey: auth.key, secret: auth.key };

  const apiKey = process.env[providerConfig.apiKeyEnv];
  if (!apiKey) {
    throw new StrongCodeError("MODEL_ERROR", `Missing API key env ${providerConfig.apiKeyEnv} for provider ${providerId}`);
  }

  return { type: "api", apiKey, secret: apiKey };
}
