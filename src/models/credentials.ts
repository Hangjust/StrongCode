import { StrongCodeError } from "../core/errors";
import type { OAuthProviderAuth, ProviderAuthReader } from "./auth-store";
import { refreshChatGptAccessToken } from "./chatgpt-oauth";

export type ProviderCredentials = ApiKeyProviderCredentials | OAuthProviderCredentials;

export interface ApiKeyProviderCredentials {
  type: "api";
  apiKey: string;
  secret: string;
}

export interface OAuthProviderCredentials {
  type: "oauth";
  access: string;
  refresh?: string;
  expires?: number;
  accountId?: string;
  secret: string;
}

export interface ResolveProviderCredentialsOptions {
  authStore?: ProviderAuthReader;
}

interface ProviderAuthWriter extends ProviderAuthReader {
  set(providerId: string, auth: OAuthProviderAuth): Promise<void>;
}

const refreshPromises = new Map<string, Promise<OAuthProviderAuth>>();

function canWriteAuth(authStore: ProviderAuthReader | undefined): authStore is ProviderAuthWriter {
  return Boolean(authStore && "set" in authStore && typeof authStore.set === "function");
}

function oauthSupported(providerId: string): boolean {
  return providerId === "openai";
}

async function refreshOAuth(providerId: string, auth: OAuthProviderAuth, authStore: ProviderAuthReader | undefined): Promise<OAuthProviderAuth> {
  if (!auth.refresh) throw new StrongCodeError("MODEL_ERROR", `Provider ${providerId} OAuth credentials are expired and missing a refresh token`);
  const key = `${providerId}:${auth.refresh}`;
  let refreshPromise = refreshPromises.get(key);
  if (!refreshPromise) {
    refreshPromise = refreshChatGptAccessToken(auth.refresh).then(refreshed => ({ ...refreshed, accountId: refreshed.accountId ?? auth.accountId }));
    refreshPromises.set(key, refreshPromise);
    refreshPromise.finally(() => refreshPromises.delete(key)).catch(error => { void error; });
  }
  const refreshed = await refreshPromise;
  if (canWriteAuth(authStore)) await authStore.set(providerId, refreshed);
  return refreshed;
}

function oauthCredentials(auth: OAuthProviderAuth): OAuthProviderCredentials {
  return {
    type: "oauth",
    access: auth.access,
    refresh: auth.refresh,
    expires: auth.expires,
    accountId: auth.accountId,
    secret: auth.access
  };
}

export async function resolveProviderCredentials(providerId: string, providerConfig: { apiKeyEnv?: string | undefined }, options: ResolveProviderCredentialsOptions = {}): Promise<ProviderCredentials> {
  const auth = await options.authStore?.get(providerId);
  if (!providerConfig.apiKeyEnv) {
    if (auth?.type === "api") return { type: "api", apiKey: auth.key, secret: auth.key };
    if (auth?.type === "oauth" && oauthSupported(providerId)) {
      const current = auth.expires !== undefined && auth.expires <= Date.now() ? await refreshOAuth(providerId, auth, options.authStore) : auth;
      return oauthCredentials(current);
    }
    throw new StrongCodeError("CONFIG_ERROR", `Provider ${providerId} requires apiKeyEnv or auth.json credentials`);
  }

  const apiKey = process.env[providerConfig.apiKeyEnv];
  if (!apiKey) {
    if (auth?.type === "api") return { type: "api", apiKey: auth.key, secret: auth.key };
    if (auth?.type === "oauth" && oauthSupported(providerId)) {
      const current = auth.expires !== undefined && auth.expires <= Date.now() ? await refreshOAuth(providerId, auth, options.authStore) : auth;
      return oauthCredentials(current);
    }
    throw new StrongCodeError("MODEL_ERROR", `Missing API key env ${providerConfig.apiKeyEnv} for provider ${providerId}`);
  }

  return { type: "api", apiKey, secret: apiKey };
}
