import { StrongCodeError } from "../core/errors";
import { isSecretLikeConfigKey } from "../config/security";

export function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

export function isLocalProviderBaseUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return isLocalhost(parseProviderBaseUrl(value, "local provider").hostname);
  } catch {
    return false;
  }
}

function rejectSecretQuery(searchParams: URLSearchParams, fieldName: string): void {
  for (const key of searchParams.keys()) {
    if (isSecretLikeConfigKey(key)) {
      throw new StrongCodeError("CONFIG_ERROR", `Provider ${fieldName} must not include secret-like query parameter '${key}'`);
    }
  }
}

export function parseProviderBaseUrl(value: string | undefined, purpose: string): URL {
  if (!value) {
    throw new StrongCodeError("CONFIG_ERROR", `Provider baseUrl is required for ${purpose}`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new StrongCodeError("CONFIG_ERROR", "Provider baseUrl must be a valid URL");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new StrongCodeError("CONFIG_ERROR", "Provider baseUrl must use http or https");
  }

  if (url.protocol === "http:" && !isLocalhost(url.hostname)) {
    throw new StrongCodeError("CONFIG_ERROR", "Provider baseUrl must use https unless it points to localhost");
  }

  if (url.username || url.password) {
    throw new StrongCodeError("CONFIG_ERROR", "Provider baseUrl must not include username or password");
  }

  if (url.hash) {
    throw new StrongCodeError("CONFIG_ERROR", "Provider baseUrl must not include a fragment");
  }

  if (url.search) {
    throw new StrongCodeError("CONFIG_ERROR", "Provider baseUrl must not include a query string");
  }

  rejectSecretQuery(url.searchParams, "baseUrl");
  return url;
}

export function validateProviderModelsEndpoint(endpoint: string | undefined): string {
  const value = endpoint ?? "/models";
  if (!value.startsWith("/") || value.startsWith("//")) {
    throw new StrongCodeError("CONFIG_ERROR", "Provider modelsEndpoint must start with one / and stay relative to baseUrl");
  }

  if (value.includes("#")) {
    throw new StrongCodeError("CONFIG_ERROR", "Provider modelsEndpoint must not include a fragment");
  }

  if (value.includes("?")) {
    throw new StrongCodeError("CONFIG_ERROR", "Provider modelsEndpoint must not include a query string");
  }

  if (value.split("/").some(segment => segment === "." || segment === "..")) {
    throw new StrongCodeError("CONFIG_ERROR", "Provider modelsEndpoint must not contain dot path segments");
  }

  return value;
}

export function buildProviderUrl(baseUrlValue: string | undefined, endpoint: string, purpose: string): string {
  const baseUrl = parseProviderBaseUrl(baseUrlValue, purpose);
  const safeEndpoint = validateProviderModelsEndpoint(endpoint);
  const resolved = new URL(`${baseUrl.pathname.replace(/\/$/, "")}${safeEndpoint}`, baseUrl);
  parseProviderBaseUrl(resolved.toString(), purpose);
  return resolved.toString();
}
