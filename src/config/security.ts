export const forbiddenConfigKeys = new Set(["apiKey", "api_key", "apikey", "token", "accessToken", "access_token", "secret", "password", "authorization", "bearerToken", "bearer_token"]);

export function isSecretLikeConfigKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return [...forbiddenConfigKeys].some(forbidden => normalized === forbidden.replace(/[^a-z0-9]/gi, "").toLowerCase());
}

export function looksLikeProviderApiKeyEnv(value: string): boolean {
  return /^[A-Z_][A-Z0-9_]*_API_KEY$/.test(value);
}
