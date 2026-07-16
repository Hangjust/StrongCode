import { createServer, type Server } from "node:http";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { StrongCodeError } from "../core/errors";
import { strongCodeHomePath } from "../config/paths";

interface StoredOAuthState {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
}

async function atomicPrivateJson(filePath: string, value: StoredOAuthState): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await chmod(temporary, 0o600).catch(() => undefined);
  await rename(temporary, filePath);
}

async function readStoredState(filePath: string): Promise<StoredOAuthState> {
  try {
    const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as StoredOAuthState : {};
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
    if (error instanceof SyntaxError) throw new StrongCodeError("CONFIG_ERROR", `Invalid private MCP OAuth state: ${filePath}`);
    throw error;
  }
}

function oauthStatePath(serverId: string, serverUrl: string): string {
  const safeId = serverId.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const digest = createHash("sha256").update(serverUrl).digest("hex").slice(0, 12);
  return strongCodeHomePath("credentials", "mcp", `${safeId}-${digest}.json`);
}

function openBrowser(url: URL): void {
  const command = process.platform === "win32" ? "rundll32" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url.toString()] : [url.toString()];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true, shell: false });
  child.once("error", () => undefined);
  child.unref();
}

export class PersistentOAuthProvider implements OAuthClientProvider {
  readonly clientMetadata: OAuthClientMetadata;
  private readonly stateValue = randomUUID();

  private constructor(
    readonly redirectUrl: URL,
    private readonly filePath: string,
    private stored: StoredOAuthState
  ) {
    this.clientMetadata = {
      client_name: "StrongCode MCP Client",
      redirect_uris: [redirectUrl.toString()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    };
  }

  static async create(serverId: string, serverUrl: string, redirectUrl: URL): Promise<PersistentOAuthProvider> {
    const filePath = oauthStatePath(serverId, serverUrl);
    return new PersistentOAuthProvider(redirectUrl, filePath, await readStoredState(filePath));
  }

  state(): string { return this.stateValue; }
  expectedState(): string { return this.stateValue; }
  clientInformation(): OAuthClientInformationMixed | undefined { return this.stored.clientInformation; }
  tokens(): OAuthTokens | undefined { return this.stored.tokens; }
  codeVerifier(): string {
    if (!this.stored.codeVerifier) throw new StrongCodeError("TOOL_ERROR", "MCP OAuth code verifier is missing");
    return this.stored.codeVerifier;
  }
  discoveryState(): OAuthDiscoveryState | undefined { return this.stored.discoveryState; }
  redirectToAuthorization(authorizationUrl: URL): void { openBrowser(authorizationUrl); }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    this.stored.clientInformation = clientInformation;
    await atomicPrivateJson(this.filePath, this.stored);
  }
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.stored.tokens = tokens;
    await atomicPrivateJson(this.filePath, this.stored);
  }
  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.stored.codeVerifier = codeVerifier;
    await atomicPrivateJson(this.filePath, this.stored);
  }
  async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
    this.stored.discoveryState = discoveryState;
    await atomicPrivateJson(this.filePath, this.stored);
  }
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "all" || scope === "client") delete this.stored.clientInformation;
    if (scope === "all" || scope === "tokens") delete this.stored.tokens;
    if (scope === "all" || scope === "verifier") delete this.stored.codeVerifier;
    if (scope === "all" || scope === "discovery") delete this.stored.discoveryState;
    await atomicPrivateJson(this.filePath, this.stored);
  }
}

export interface OAuthCallbackServer {
  redirectUrl: URL;
  waitForCode(expectedState: string, timeoutMs: number): Promise<string>;
  close(): Promise<void>;
}

export async function createOAuthCallbackServer(): Promise<OAuthCallbackServer> {
  let resolveCode: ((value: { code: string; state?: string }) => void) | undefined;
  let rejectCode: ((reason: Error) => void) | undefined;
  const callback = new Promise<{ code: string; state?: string }>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    if (code) {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end("<h1>StrongCode MCP authorization complete</h1><p>You can close this window.</p>");
      resolveCode?.({ code, state: url.searchParams.get("state") ?? undefined });
    } else {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      response.end("StrongCode MCP authorization failed.");
      rejectCode?.(new StrongCodeError("TOOL_ERROR", `MCP OAuth authorization failed${error ? `: ${error}` : ""}`));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  const redirectUrl = new URL(`http://127.0.0.1:${address.port}/callback`);
  return {
    redirectUrl,
    async waitForCode(expectedState, timeoutMs) {
      const timeout = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new StrongCodeError("TOOL_ERROR", "Timed out waiting for MCP OAuth authorization")), timeoutMs);
        timer.unref();
      });
      const result = await Promise.race([callback, timeout]);
      if (result.state !== expectedState) throw new StrongCodeError("TOOL_ERROR", "MCP OAuth state did not match");
      return result.code;
    },
    async close() {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  };
}
