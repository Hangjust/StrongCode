import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProviderAuthStore } from "../src/models/auth-store";
import {
  CHATGPT_CLIENT_ID,
  buildChatGptAuthorizeUrl,
  loginChatGptBrowser,
  loginChatGptDevice,
  refreshChatGptAccessToken,
  type ChatGptAuthPrompt,
  type ChatGptOAuthFetch
} from "../src/models/chatgpt-oauth";

function jwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature"
  ].join(".");
}

function callbackUrl(authUrl: string, params: Record<string, string>): string {
  const authorize = new URL(authUrl);
  const redirect = authorize.searchParams.get("redirect_uri");
  if (!redirect) throw new Error("missing redirect_uri");
  const callback = new URL(redirect);
  for (const [key, value] of Object.entries(params)) callback.searchParams.set(key, value);
  return callback.toString();
}

describe("native ChatGPT OAuth", () => {
  it("builds a PKCE authorization URL for the fixed loopback callback", () => {
    const url = new URL(buildChatGptAuthorizeUrl(
      "http://127.0.0.1:1455/auth/callback",
      { verifier: "verifier", challenge: "challenge" },
      "csrf-state"
    ));

    expect(url.origin).toBe("https://auth.openai.com");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(CHATGPT_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");
    expect(url.searchParams.get("code_challenge")).toBe("challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("csrf-state");
  });

  it("waits for the browser callback, validates state, exchanges the code, and persists OAuth", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-chatgpt-browser-"));
    const authStore = new ProviderAuthStore(root);
    let callbackResponse: Promise<Response> | undefined;
    const fetcher: ChatGptOAuthFetch = async (input, init) => {
      expect(String(input)).toBe("https://auth.openai.com/oauth/token");
      expect(init?.method).toBe("POST");
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("authorization-code");
      expect(body.get("code_verifier")).toHaveLength(64);
      return new Response(JSON.stringify({
        access_token: "oauth-access",
        refresh_token: "oauth-refresh",
        id_token: jwt({ chatgpt_account_id: "account-123" }),
        expires_in: 3600
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const auth = await loginChatGptBrowser("chatgpt", authStore, {
      fetcher,
      callbackTimeoutMs: 2_000,
      openUrl: async authUrl => {
        const state = new URL(authUrl).searchParams.get("state");
        if (!state) throw new Error("missing state");
        callbackResponse = fetch(callbackUrl(authUrl, { code: "authorization-code", state }));
        return true;
      }
    });

    expect((await callbackResponse)?.status).toBe(200);
    expect(auth).toMatchObject({ type: "oauth", access: "oauth-access", refresh: "oauth-refresh", accountId: "account-123" });
    await expect(authStore.get("chatgpt")).resolves.toMatchObject({ type: "oauth", access: "oauth-access", refresh: "oauth-refresh" });
  });

  it("rejects a browser callback with the wrong state and stores nothing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-chatgpt-state-"));
    const authStore = new ProviderAuthStore(root);
    let callbackResponse: Promise<Response> | undefined;
    const login = loginChatGptBrowser("chatgpt", authStore, {
      fetcher: async () => { throw new Error("token endpoint must not be called"); },
      callbackTimeoutMs: 2_000,
      openUrl: async authUrl => {
        callbackResponse = fetch(callbackUrl(authUrl, { code: "authorization-code", state: "wrong-state" }));
        return true;
      }
    });

    await expect(login).rejects.toThrow("state validation");
    expect((await callbackResponse)?.status).toBe(400);
    await expect(authStore.get("chatgpt")).resolves.toBeUndefined();
  });

  it("completes the headless device flow and persists its tokens", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-chatgpt-device-"));
    const authStore = new ProviderAuthStore(root);
    let prompt: ChatGptAuthPrompt | undefined;
    const calls: string[] = [];
    const fetcher: ChatGptOAuthFetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/api/accounts/deviceauth/usercode")) {
        expect(JSON.parse(String(init?.body))).toEqual({ client_id: CHATGPT_CLIENT_ID });
        return new Response(JSON.stringify({ device_auth_id: "device-id", user_code: "ABCD-EFGH", interval: 1 }), { status: 200 });
      }
      if (url.endsWith("/api/accounts/deviceauth/token")) {
        return new Response(JSON.stringify({ authorization_code: "device-authorization", code_verifier: "device-verifier" }), { status: 200 });
      }
      if (url.endsWith("/oauth/token")) {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback");
        expect(body.get("code_verifier")).toBe("device-verifier");
        return new Response(JSON.stringify({ access_token: "device-access", refresh_token: "device-refresh" }), { status: 200 });
      }
      throw new Error(`unexpected URL: ${url}`);
    };

    const auth = await loginChatGptDevice("chatgpt", authStore, { fetcher, onPrompt: value => { prompt = value; } });

    expect(prompt).toMatchObject({ url: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH" });
    expect(calls).toEqual([
      "https://auth.openai.com/api/accounts/deviceauth/usercode",
      "https://auth.openai.com/api/accounts/deviceauth/token",
      "https://auth.openai.com/oauth/token"
    ]);
    expect(auth).toMatchObject({ access: "device-access", refresh: "device-refresh" });
    await expect(authStore.get("chatgpt")).resolves.toMatchObject({ access: "device-access" });
  });

  it("refreshes an expired access token without discarding account metadata", async () => {
    const refreshed = await refreshChatGptAccessToken({
      type: "oauth",
      access: "old-access",
      refresh: "old-refresh",
      accountId: "account-123"
    }, {
      fetcher: async (_input, init) => {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("old-refresh");
        return new Response(JSON.stringify({ access_token: "new-access", expires_in: 7200 }), { status: 200 });
      }
    });

    expect(refreshed).toMatchObject({ access: "new-access", refresh: "old-refresh", accountId: "account-123" });
    expect(refreshed.expires).toBeGreaterThan(Date.now() + 7_000_000);
  });
});
