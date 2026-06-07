import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { randomBytes, webcrypto } from "node:crypto";
import type { OAuthProviderAuth, ProviderAuthReader } from "./auth-store";
import { StrongCodeError } from "../core/errors";

export const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CHATGPT_ISSUER = "https://auth.openai.com";
export const CHATGPT_CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const OAUTH_PORT = 1455;
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const DEVICE_POLLING_SAFETY_MARGIN_MS = 3000;

interface PkceCodes {
  verifier: string;
  challenge: string;
}

interface TokenResponse {
  id_token?: string;
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

interface DeviceUserCodeResponse {
  device_auth_id: string;
  user_code: string;
  interval: string;
}

interface DeviceTokenResponse {
  authorization_code: string;
  code_verifier: string;
}

interface ChatGptAccountClaims {
  chatgpt_account_id?: unknown;
  organizations?: unknown;
  "https://api.openai.com/auth"?: unknown;
}

export type ChatGptOAuthFetch = (url: string, init: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface ChatGptOAuthOptions {
  fetcher?: ChatGptOAuthFetch;
  issuer?: string;
  openUrl?: (url: string) => Promise<boolean>;
  callbackTimeoutMs?: number;
  onBackgroundError?: (error: Error) => void;
}

interface ProviderAuthWriter extends ProviderAuthReader {
  set(providerId: string, auth: OAuthProviderAuth): Promise<void>;
}

function isTokenResponse(value: unknown): value is TokenResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.access_token === "string" && record.access_token.length > 0;
}

function isDeviceUserCodeResponse(value: unknown): value is DeviceUserCodeResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.device_auth_id === "string" && typeof record.user_code === "string" && typeof record.interval === "string";
}

function isDeviceTokenResponse(value: unknown): value is DeviceTokenResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.authorization_code === "string" && typeof record.code_verifier === "string";
}

function fetcherForOptions(options: ChatGptOAuthOptions): ChatGptOAuthFetch {
  if (options.fetcher) return options.fetcher;
  return async (url, init) => {
    if (typeof fetch !== "function") throw new StrongCodeError("CONFIG_ERROR", "Global fetch is not available for ChatGPT OAuth");
    const response = await fetch(url, init);
    return { ok: response.ok, status: response.status, json: () => response.json() };
  };
}

function base64UrlEncode(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return Buffer.from(bytes).toString("base64url");
}

async function generatePKCE(): Promise<PkceCodes> {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = new Uint8Array(43);
  webcrypto.getRandomValues(bytes);
  const verifier = Array.from(bytes).map(byte => chars[byte % chars.length]).join("");
  const challenge = base64UrlEncode(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

export function parseJwtClaims(token: string): ChatGptAccountClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as ChatGptAccountClaims : undefined;
  } catch (error) {
    void error;
    return undefined;
  }
}

export function extractAccountIdFromClaims(claims: ChatGptAccountClaims): string | undefined {
  if (typeof claims.chatgpt_account_id === "string" && claims.chatgpt_account_id.length > 0) return claims.chatgpt_account_id;
  const authClaims = claims["https://api.openai.com/auth"];
  if (authClaims && typeof authClaims === "object" && !Array.isArray(authClaims)) {
    const nested = authClaims as Record<string, unknown>;
    if (typeof nested.chatgpt_account_id === "string" && nested.chatgpt_account_id.length > 0) return nested.chatgpt_account_id;
  }
  if (Array.isArray(claims.organizations)) {
    const first = claims.organizations[0];
    if (first && typeof first === "object" && !Array.isArray(first)) {
      const organization = first as Record<string, unknown>;
      if (typeof organization.id === "string" && organization.id.length > 0) return organization.id;
    }
  }
  return undefined;
}

export function extractAccountId(tokens: { id_token?: string; access_token?: string }): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token);
    const accountId = claims ? extractAccountIdFromClaims(claims) : undefined;
    if (accountId) return accountId;
  }
  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token);
    return claims ? extractAccountIdFromClaims(claims) : undefined;
  }
  return undefined;
}

function authFromTokens(tokens: TokenResponse, fallbackRefresh?: string, fallbackAccountId?: string): OAuthProviderAuth {
  const refresh = tokens.refresh_token ?? fallbackRefresh;
  const accountId = extractAccountId(tokens) ?? fallbackAccountId;
  return {
    type: "oauth",
    access: tokens.access_token,
    refresh,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    accountId,
    metadata: { issuer: CHATGPT_ISSUER }
  };
}

export function buildChatGptAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string, issuer = CHATGPT_ISSUER): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CHATGPT_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "strongcode"
  });
  return `${issuer}/oauth/authorize?${params.toString()}`;
}

async function exchangeCodeForTokens(fetcher: ChatGptOAuthFetch, issuer: string, code: string, redirectUri: string, codeVerifier: string): Promise<TokenResponse> {
  const response = await fetcher(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: CHATGPT_CLIENT_ID, code_verifier: codeVerifier }).toString()
  });
  if (!response.ok) throw new StrongCodeError("CONFIG_ERROR", `Token exchange failed: ${response.status}`);
  const tokens = await response.json();
  if (!isTokenResponse(tokens)) throw new StrongCodeError("CONFIG_ERROR", "Token exchange response is missing access_token");
  return tokens;
}

export async function refreshChatGptAccessToken(refreshToken: string, options: ChatGptOAuthOptions = {}): Promise<OAuthProviderAuth> {
  const issuer = options.issuer ?? CHATGPT_ISSUER;
  const response = await fetcherForOptions(options)(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CHATGPT_CLIENT_ID }).toString()
  });
  if (!response.ok) throw new StrongCodeError("MODEL_ERROR", `Token refresh failed: ${response.status}`);
  const tokens = await response.json();
  if (!isTokenResponse(tokens)) throw new StrongCodeError("MODEL_ERROR", "Token refresh response is missing access_token");
  return authFromTokens(tokens, refreshToken);
}

function htmlSuccess(): string {
  return "<!doctype html><html><head><title>StrongCode Authorization Successful</title></head><body><h1>Authorization Successful</h1><p>You can close this window and return to StrongCode.</p><script>setTimeout(() => window.close(), 2000)</script></body></html>";
}

function htmlError(error: string): string {
  return `<!doctype html><html><head><title>StrongCode Authorization Failed</title></head><body><h1>Authorization Failed</h1><p>${error.replace(/[<>&]/g, char => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[char] ?? char))}</p></body></html>`;
}

async function defaultOpenUrl(url: string): Promise<boolean> {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

export async function startChatGptBrowserAuth(providerId: string, authStore: ProviderAuthWriter, options: ChatGptOAuthOptions = {}): Promise<{ url: string; instructions: string }> {
  const issuer = options.issuer ?? CHATGPT_ISSUER;
  const callbackTimeoutMs = options.callbackTimeoutMs ?? OAUTH_TIMEOUT_MS;
  const fetcher = fetcherForOptions(options);
  const redirectUri = `http://127.0.0.1:${OAUTH_PORT}/auth/callback`;
  const pkce = await generatePKCE();
  const state = base64UrlEncode(randomBytes(32));
  const authUrl = buildChatGptAuthorizeUrl(redirectUri, pkce, state, issuer);
  let closeStarted = false;
  let timeout: NodeJS.Timeout | undefined;
  const server = createServer(async (request, response) => {
    const closeOnce = (): void => {
      if (closeStarted) return;
      closeStarted = true;
      if (timeout) clearTimeout(timeout);
      server.close(error => {
        if (error) options.onBackgroundError?.(error);
      });
    };
    const sendHtmlAndClose = (status: number, html: string): void => {
      response.writeHead(status, { "Content-Type": "text/html" });
      response.end(html, closeOnce);
    };
    const requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${OAUTH_PORT}`);
    if (requestUrl.hostname !== "127.0.0.1") {
      response.writeHead(400);
      response.end("Invalid host", closeOnce);
      return;
    }
    if (requestUrl.pathname !== "/auth/callback") {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    const error = requestUrl.searchParams.get("error");
    if (error) {
      sendHtmlAndClose(200, htmlError(requestUrl.searchParams.get("error_description") ?? error));
      return;
    }
    const code = requestUrl.searchParams.get("code");
    if (!code || requestUrl.searchParams.get("state") !== state) {
      sendHtmlAndClose(400, htmlError("Invalid OAuth callback"));
      return;
    }
    try {
      const tokens = await exchangeCodeForTokens(fetcher, issuer, code, redirectUri, pkce.verifier);
      await authStore.set(providerId, authFromTokens(tokens));
      sendHtmlAndClose(200, htmlSuccess());
    } catch (errorValue) {
      const errorMessage = errorValue instanceof Error ? errorValue.message : String(errorValue);
      sendHtmlAndClose(500, htmlError(errorMessage));
    }
  });
  await new Promise<void>((resolve, reject) => {
    const closeOnce = (): void => {
      if (closeStarted) return;
      closeStarted = true;
      server.close();
    };
    timeout = setTimeout(closeOnce, callbackTimeoutMs);
    server.once("close", () => clearTimeout(timeout));
    server.once("error", reject);
    server.listen(OAUTH_PORT, "127.0.0.1", resolve);
  });
  const opened = await (options.openUrl ?? defaultOpenUrl)(authUrl);
  return {
    url: authUrl,
    instructions: opened ? "Complete ChatGPT authorization in your browser." : "Open this URL in your browser to complete ChatGPT authorization."
  };
}

export async function completeChatGptHeadlessAuth(options: ChatGptOAuthOptions = {}): Promise<{ auth: OAuthProviderAuth; userCode: string; url: string }> {
  const issuer = options.issuer ?? CHATGPT_ISSUER;
  const fetcher = fetcherForOptions(options);
  const deviceResponse = await fetcher(`${issuer}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "strongcode/0.1.0" },
    body: JSON.stringify({ client_id: CHATGPT_CLIENT_ID })
  });
  if (!deviceResponse.ok) throw new StrongCodeError("CONFIG_ERROR", "Failed to initiate device authorization");
  const deviceData = await deviceResponse.json();
  if (!isDeviceUserCodeResponse(deviceData)) throw new StrongCodeError("CONFIG_ERROR", "Device authorization response is malformed");
  const interval = Math.max(Number.parseInt(deviceData.interval, 10) || 5, 1) * 1000;
  const started = Date.now();
  while (Date.now() - started < OAUTH_TIMEOUT_MS) {
    const response = await fetcher(`${issuer}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "strongcode/0.1.0" },
      body: JSON.stringify({ device_auth_id: deviceData.device_auth_id, user_code: deviceData.user_code })
    });
    if (response.ok) {
      const deviceToken = await response.json();
      if (!isDeviceTokenResponse(deviceToken)) throw new StrongCodeError("CONFIG_ERROR", "Device token response is malformed");
      const tokens = await exchangeCodeForTokens(fetcher, issuer, deviceToken.authorization_code, `${issuer}/deviceauth/callback`, deviceToken.code_verifier);
      return { auth: authFromTokens(tokens), userCode: deviceData.user_code, url: `${issuer}/codex/device` };
    }
    if (response.status !== 403 && response.status !== 404) throw new StrongCodeError("CONFIG_ERROR", `Device authorization failed: ${response.status}`);
    await sleep(interval + DEVICE_POLLING_SAFETY_MARGIN_MS);
  }
  throw new StrongCodeError("CONFIG_ERROR", "Device authorization timed out");
}

export async function startChatGptHeadlessAuth(providerId: string, authStore: ProviderAuthWriter, options: ChatGptOAuthOptions = {}): Promise<{ url: string; instructions: string }> {
  const issuer = options.issuer ?? CHATGPT_ISSUER;
  const fetcher = fetcherForOptions(options);
  const deviceResponse = await fetcher(`${issuer}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "strongcode/0.1.0" },
    body: JSON.stringify({ client_id: CHATGPT_CLIENT_ID })
  });
  if (!deviceResponse.ok) throw new StrongCodeError("CONFIG_ERROR", "Failed to initiate device authorization");
  const deviceData = await deviceResponse.json();
  if (!isDeviceUserCodeResponse(deviceData)) throw new StrongCodeError("CONFIG_ERROR", "Device authorization response is malformed");
  const interval = Math.max(Number.parseInt(deviceData.interval, 10) || 5, 1) * 1000;
  const poll = async (): Promise<void> => {
    const started = Date.now();
    const timeout = options.callbackTimeoutMs ?? OAUTH_TIMEOUT_MS;
    while (Date.now() - started < timeout) {
      const response = await fetcher(`${issuer}/api/accounts/deviceauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "strongcode/0.1.0" },
        body: JSON.stringify({ device_auth_id: deviceData.device_auth_id, user_code: deviceData.user_code })
      });
      if (response.ok) {
        const deviceToken = await response.json();
        if (!isDeviceTokenResponse(deviceToken)) throw new StrongCodeError("CONFIG_ERROR", "Device token response is malformed");
        const tokens = await exchangeCodeForTokens(fetcher, issuer, deviceToken.authorization_code, `${issuer}/deviceauth/callback`, deviceToken.code_verifier);
        await authStore.set(providerId, authFromTokens(tokens));
        return;
      }
      if (response.status !== 403 && response.status !== 404) throw new StrongCodeError("CONFIG_ERROR", `Device authorization failed: ${response.status}`);
      await sleep(interval + DEVICE_POLLING_SAFETY_MARGIN_MS);
    }
    throw new StrongCodeError("CONFIG_ERROR", "Device authorization timed out");
  };
  poll().catch(error => {
    options.onBackgroundError?.(error instanceof Error ? error : new Error(String(error)));
  });
  return { url: `${issuer}/codex/device`, instructions: `Enter code: ${deviceData.user_code}` };
}
