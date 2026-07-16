import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { randomBytes, timingSafeEqual, webcrypto } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { StrongCodeError } from "../core/errors";
import type { OAuthProviderAuth } from "./auth-store";
import { readBoundedResponseText } from "./response-body";

export const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CHATGPT_ISSUER = "https://auth.openai.com";
export const CHATGPT_CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
export const CHATGPT_OAUTH_PORT = 1455;

const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const DEVICE_POLLING_SAFETY_MARGIN_MS = 3_000;
const MAX_OAUTH_RESPONSE_BYTES = 64 * 1024;
const MAX_TOKEN_LENGTH = 64 * 1024;

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

export interface ChatGptDeviceCode {
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
  url: string;
}

interface ChatGptAccountClaims {
  chatgpt_account_id?: unknown;
  organizations?: unknown;
  "https://api.openai.com/auth"?: unknown;
}

export type ChatGptOAuthFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface ChatGptAuthPrompt {
  url: string;
  instructions: string;
  userCode?: string;
  browserOpened?: boolean;
}

export interface ChatGptAuthWriter {
  set(providerId: string, auth: OAuthProviderAuth): Promise<void>;
}

export interface ChatGptOAuthOptions {
  fetcher?: ChatGptOAuthFetch;
  issuer?: string;
  callbackTimeoutMs?: number;
  openUrl?: (url: string) => Promise<boolean>;
  onPrompt?: (prompt: ChatGptAuthPrompt) => void;
  signal?: AbortSignal;
}

function fetcherForOptions(options: ChatGptOAuthOptions): ChatGptOAuthFetch {
  if (options.fetcher) return options.fetcher;
  if (typeof fetch !== "function") throw new StrongCodeError("CONFIG_ERROR", "Global fetch is not available for ChatGPT login");
  return fetch;
}

async function boundedJson(response: Response, context: string): Promise<unknown> {
  const text = await readBoundedResponseText(response, {
    maxBytes: MAX_OAUTH_RESPONSE_BYTES,
    tooLargeMessage: `${context} response exceeded 64 KB`
  });
  try {
    return JSON.parse(text);
  } catch {
    throw new StrongCodeError("CONFIG_ERROR", `${context} response was not valid JSON`);
  }
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TOKEN_LENGTH;
}

function tokenResponse(value: unknown, context: string): TokenResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StrongCodeError("CONFIG_ERROR", `${context} response was malformed`);
  }
  const record = value as Record<string, unknown>;
  if (!validToken(record.access_token)) throw new StrongCodeError("CONFIG_ERROR", `${context} response is missing access_token`);
  if (record.refresh_token !== undefined && !validToken(record.refresh_token)) {
    throw new StrongCodeError("CONFIG_ERROR", `${context} response contained an invalid refresh_token`);
  }
  if (record.id_token !== undefined && !validToken(record.id_token)) {
    throw new StrongCodeError("CONFIG_ERROR", `${context} response contained an invalid id_token`);
  }
  const expiresIn = typeof record.expires_in === "number" && Number.isFinite(record.expires_in)
    ? Math.max(1, Math.min(record.expires_in, 31 * 24 * 60 * 60))
    : undefined;
  return {
    access_token: record.access_token,
    refresh_token: record.refresh_token as string | undefined,
    id_token: record.id_token as string | undefined,
    expires_in: expiresIn
  };
}

function base64UrlEncode(value: ArrayBuffer | Uint8Array): string {
  return Buffer.from(value instanceof Uint8Array ? value : new Uint8Array(value)).toString("base64url");
}

async function generatePkce(): Promise<PkceCodes> {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = new Uint8Array(64);
  webcrypto.getRandomValues(bytes);
  const verifier = Array.from(bytes).map(byte => alphabet[byte % alphabet.length]).join("");
  const challenge = base64UrlEncode(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * These claims are used only as routing metadata for the OpenAI service that
 * issued the token. They never grant local authorization; OpenAI still
 * validates the signed access token on every request.
 */
function parseIssuedTokenClaims(token: string): ChatGptAccountClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as ChatGptAccountClaims : undefined;
  } catch {
    return undefined;
  }
}

function accountIdFromClaims(claims: ChatGptAccountClaims): string | undefined {
  const safeAccountId = (value: unknown): string | undefined => typeof value === "string"
    && /^[\x21-\x7e]{1,512}$/.test(value) ? value : undefined;
  const direct = safeAccountId(claims.chatgpt_account_id);
  if (direct) return direct;
  const auth = claims["https://api.openai.com/auth"];
  if (auth && typeof auth === "object" && !Array.isArray(auth)) {
    const accountId = safeAccountId((auth as Record<string, unknown>).chatgpt_account_id);
    if (accountId) return accountId;
  }
  if (Array.isArray(claims.organizations)) {
    const first = claims.organizations[0];
    if (first && typeof first === "object" && !Array.isArray(first)) {
      const id = safeAccountId((first as Record<string, unknown>).id);
      if (id) return id;
    }
  }
  return undefined;
}

function extractAccountId(tokens: Pick<TokenResponse, "id_token" | "access_token">): string | undefined {
  for (const token of [tokens.id_token, tokens.access_token]) {
    if (!token) continue;
    const claims = parseIssuedTokenClaims(token);
    const accountId = claims ? accountIdFromClaims(claims) : undefined;
    if (accountId) return accountId;
  }
  return undefined;
}

function authFromTokens(
  tokens: TokenResponse,
  issuer: string,
  fallback: Pick<OAuthProviderAuth, "refresh" | "accountId"> = {}
): OAuthProviderAuth {
  return {
    type: "oauth",
    access: tokens.access_token,
    refresh: tokens.refresh_token ?? fallback.refresh,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    accountId: extractAccountId(tokens) ?? fallback.accountId,
    metadata: { issuer }
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

async function exchangeCode(
  fetcher: ChatGptOAuthFetch,
  issuer: string,
  code: string,
  redirectUri: string,
  verifier: string
): Promise<TokenResponse> {
  const response = await fetcher(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CHATGPT_CLIENT_ID,
      code_verifier: verifier
    }).toString(),
    redirect: "error"
  });
  if (!response.ok) throw new StrongCodeError("CONFIG_ERROR", `ChatGPT token exchange failed with HTTP ${response.status}`);
  return tokenResponse(await boundedJson(response, "ChatGPT token exchange"), "ChatGPT token exchange");
}

export async function refreshChatGptAccessToken(auth: OAuthProviderAuth, options: ChatGptOAuthOptions = {}): Promise<OAuthProviderAuth> {
  if (!auth.refresh) throw new StrongCodeError("MODEL_ERROR", "ChatGPT login expired and has no refresh token; reconnect the account");
  const issuer = options.issuer ?? CHATGPT_ISSUER;
  const response = await fetcherForOptions(options)(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: auth.refresh,
      client_id: CHATGPT_CLIENT_ID
    }).toString(),
    redirect: "error"
  });
  if (!response.ok) throw new StrongCodeError("MODEL_ERROR", `ChatGPT token refresh failed with HTTP ${response.status}; reconnect the account`);
  const tokens = tokenResponse(await boundedJson(response, "ChatGPT token refresh"), "ChatGPT token refresh");
  return authFromTokens(tokens, issuer, auth);
}

function htmlPage(title: string, message: string, success: boolean): string {
  const escape = (value: string) => value.replace(/[<>&"']/g, character => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;", "'": "&#39;"
  })[character] ?? character);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><style>body{font-family:system-ui;background:#0d1117;color:#f0f6fc;display:grid;place-items:center;min-height:100vh;margin:0}main{text-align:center;max-width:34rem;padding:2rem}h1{color:${success ? "#3fb950" : "#f85149"}}p{color:#8b949e}</style></head><body><main><h1>${escape(title)}</h1><p>${escape(message)}</p></main>${success ? "<script>setTimeout(()=>window.close(),1500)</script>" : ""}</body></html>`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function defaultOpenUrl(url: string): Promise<boolean> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "auth.openai.com") {
    throw new StrongCodeError("CONFIG_ERROR", "Refusing to open an unexpected ChatGPT authorization URL");
  }
  let executable: string;
  let args: string[];
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (!systemRoot || !path.isAbsolute(systemRoot)) return false;
    executable = path.join(systemRoot, "explorer.exe");
    args = [url];
  } else if (process.platform === "darwin") {
    executable = "/usr/bin/open";
    args = [url];
  } else {
    const candidates = ["/usr/bin/xdg-open", "/bin/xdg-open"];
    executable = "";
    for (const candidate of candidates) {
      try {
        await access(candidate);
        executable = candidate;
        break;
      } catch {
        // Try the next fixed system location.
      }
    }
    if (!executable) return false;
    args = [url];
  }
  return new Promise(resolve => {
    const child = spawn(executable, args, { stdio: "ignore", windowsHide: true, shell: false, detached: true });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

export async function loginChatGptBrowser(
  providerId: string,
  authStore: ChatGptAuthWriter,
  options: ChatGptOAuthOptions = {}
): Promise<OAuthProviderAuth> {
  const issuer = options.issuer ?? CHATGPT_ISSUER;
  const fetcher = fetcherForOptions(options);
  const timeoutMs = options.callbackTimeoutMs ?? OAUTH_TIMEOUT_MS;
  const redirectUri = `http://127.0.0.1:${CHATGPT_OAUTH_PORT}/auth/callback`;
  const pkce = await generatePkce();
  const state = base64UrlEncode(randomBytes(32));
  const authUrl = buildChatGptAuthorizeUrl(redirectUri, pkce, state, issuer);

  let settle!: (auth: OAuthProviderAuth) => void;
  let fail!: (error: Error) => void;
  const completion = new Promise<OAuthProviderAuth>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  let settled = false;
  const finish = (result: OAuthProviderAuth | Error): void => {
    if (settled) return;
    settled = true;
    if (result instanceof Error) fail(result);
    else settle(result);
  };

  const server = createServer((request, response) => {
    void (async () => {
      const remote = request.socket.remoteAddress;
      if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const host = request.headers.host?.toLowerCase();
      if (host !== `127.0.0.1:${CHATGPT_OAUTH_PORT}` && host !== `localhost:${CHATGPT_OAUTH_PORT}`) {
        response.writeHead(400).end("Invalid host");
        return;
      }
      const requestUrl = new URL(request.url ?? "/", redirectUri);
      if (request.method !== "GET" || requestUrl.pathname !== "/auth/callback") {
        response.writeHead(404).end("Not found");
        return;
      }
      const headers = {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
        "X-Content-Type-Options": "nosniff"
      };
      const oauthError = requestUrl.searchParams.get("error");
      if (oauthError) {
        const message = (requestUrl.searchParams.get("error_description") ?? oauthError).slice(0, 1_000);
        response.writeHead(200, headers).end(htmlPage("Authorization cancelled", message, false));
        finish(new StrongCodeError("CONFIG_ERROR", `ChatGPT authorization failed: ${message}`));
        return;
      }
      const code = requestUrl.searchParams.get("code");
      const callbackState = requestUrl.searchParams.get("state");
      if (!code || !callbackState || !safeEqual(callbackState, state)) {
        response.writeHead(400, headers).end(htmlPage("Authorization failed", "Invalid OAuth callback.", false));
        finish(new StrongCodeError("CONFIG_ERROR", "ChatGPT authorization callback failed state validation"));
        return;
      }
      try {
        const tokens = await exchangeCode(fetcher, issuer, code, redirectUri, pkce.verifier);
        const auth = authFromTokens(tokens, issuer);
        await authStore.set(providerId, auth);
        response.writeHead(200, headers).end(htmlPage("StrongCode is connected", "You can close this window and return to StrongCode.", true));
        finish(auth);
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        response.writeHead(500, headers).end(htmlPage("Authorization failed", normalized.message, false));
        finish(normalized);
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", error => reject(new StrongCodeError("CONFIG_ERROR", `Could not start the ChatGPT callback server on port ${CHATGPT_OAUTH_PORT}: ${error.message}`)));
    server.listen(CHATGPT_OAUTH_PORT, "127.0.0.1", resolve);
  });

  const timeout = setTimeout(() => finish(new StrongCodeError("CONFIG_ERROR", "ChatGPT browser authorization timed out")), timeoutMs);
  const abort = () => finish(new StrongCodeError("CONFIG_ERROR", "ChatGPT browser authorization was cancelled"));
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const browserOpened = await (options.openUrl ?? defaultOpenUrl)(authUrl);
    options.onPrompt?.({
      url: authUrl,
      browserOpened,
      instructions: browserOpened ? "Complete ChatGPT login in your browser." : "Open this URL to complete ChatGPT login."
    });
    return await completion;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
    await closeServer(server);
  }
}

export async function requestChatGptDeviceCode(options: ChatGptOAuthOptions = {}): Promise<ChatGptDeviceCode> {
  const issuer = options.issuer ?? CHATGPT_ISSUER;
  const response = await fetcherForOptions(options)(`${issuer}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "strongcode/0.1.0" },
    body: JSON.stringify({ client_id: CHATGPT_CLIENT_ID }),
    redirect: "error"
  });
  if (!response.ok) throw new StrongCodeError("CONFIG_ERROR", `Could not start ChatGPT device authorization (HTTP ${response.status})`);
  const value = await boundedJson(response, "ChatGPT device authorization");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StrongCodeError("CONFIG_ERROR", "ChatGPT device authorization response was malformed");
  const record = value as Record<string, unknown>;
  if (!validToken(record.device_auth_id) || !validToken(record.user_code)) {
    throw new StrongCodeError("CONFIG_ERROR", "ChatGPT device authorization response was missing its code");
  }
  const seconds = typeof record.interval === "string" || typeof record.interval === "number"
    ? Number.parseInt(String(record.interval), 10)
    : 5;
  return {
    deviceAuthId: record.device_auth_id,
    userCode: record.user_code,
    intervalMs: Math.max(Number.isFinite(seconds) ? seconds : 5, 1) * 1000,
    url: `${issuer}/codex/device`
  };
}

export async function loginChatGptDevice(
  providerId: string,
  authStore: ChatGptAuthWriter,
  options: ChatGptOAuthOptions = {}
): Promise<OAuthProviderAuth> {
  const issuer = options.issuer ?? CHATGPT_ISSUER;
  const fetcher = fetcherForOptions(options);
  const device = await requestChatGptDeviceCode(options);
  options.onPrompt?.({ url: device.url, userCode: device.userCode, instructions: `Enter code ${device.userCode}` });
  const deadline = Date.now() + (options.callbackTimeoutMs ?? OAUTH_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new StrongCodeError("CONFIG_ERROR", "ChatGPT device authorization was cancelled");
    const response = await fetcher(`${issuer}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "strongcode/0.1.0" },
      body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
      redirect: "error"
    });
    if (response.ok) {
      const value = await boundedJson(response, "ChatGPT device token");
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new StrongCodeError("CONFIG_ERROR", "ChatGPT device token response was malformed");
      const record = value as Record<string, unknown>;
      if (!validToken(record.authorization_code) || !validToken(record.code_verifier)) {
        throw new StrongCodeError("CONFIG_ERROR", "ChatGPT device token response was missing authorization data");
      }
      const tokens = await exchangeCode(fetcher, issuer, record.authorization_code, `${issuer}/deviceauth/callback`, record.code_verifier);
      const auth = authFromTokens(tokens, issuer);
      await authStore.set(providerId, auth);
      return auth;
    }
    if (response.status !== 403 && response.status !== 404) {
      throw new StrongCodeError("CONFIG_ERROR", `ChatGPT device authorization failed with HTTP ${response.status}`);
    }
    try {
      await sleep(device.intervalMs + DEVICE_POLLING_SAFETY_MARGIN_MS, undefined, { signal: options.signal });
    } catch (error) {
      if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new StrongCodeError("CONFIG_ERROR", "ChatGPT device authorization was cancelled");
      }
      throw error;
    }
  }
  throw new StrongCodeError("CONFIG_ERROR", "ChatGPT device authorization timed out");
}

export type ChatGptLoginMode = "browser" | "device-code";

export async function runChatGptLogin(
  mode: ChatGptLoginMode,
  authStore: ChatGptAuthWriter,
  options: ChatGptOAuthOptions = {}
): Promise<OAuthProviderAuth> {
  return mode === "device-code"
    ? loginChatGptDevice("chatgpt", authStore, options)
    : loginChatGptBrowser("chatgpt", authStore, options);
}
