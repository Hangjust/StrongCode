import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProviderAuthStore } from "../src/models/auth-store";
import { ChatGptOAuthFetch, startChatGptBrowserAuth, startChatGptHeadlessAuth } from "../src/models/chatgpt-oauth";

function callbackUrl(authUrl: string, params: Record<string, string>): string {
  const parsed = new URL(authUrl);
  const redirectUri = parsed.searchParams.get("redirect_uri");
  if (!redirectUri) throw new Error("Missing redirect_uri");
  const callback = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) callback.searchParams.set(key, value);
  return callback.toString();
}

async function fetchText(url: string): Promise<{ status: number; text: string }> {
  const response = await fetch(url);
  return { status: response.status, text: await response.text() };
}

async function closeBrowserServer(authUrl: string): Promise<void> {
  await fetchText(callbackUrl(authUrl, { error: "cancelled" }));
  await new Promise<void>(resolve => setTimeout(resolve, 25));
}

describe("ChatGPT OAuth", () => {
  it("uses 127.0.0.1 consistently for browser redirect URLs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-chatgpt-oauth-redirect-"));
    const authStore = new ProviderAuthStore(root);

    const auth = await startChatGptBrowserAuth("openai", authStore, {
      openUrl: async () => false,
      callbackTimeoutMs: 500
    });

    try {
      const parsed = new URL(auth.url);
      expect(parsed.hostname).toBe("auth.openai.com");
      expect(parsed.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");
    } finally {
      await closeBrowserServer(auth.url);
    }
  });

  it("shows browser callback success only after token exchange and auth persistence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-chatgpt-oauth-success-"));
    const authStore = new ProviderAuthStore(root);
    const fetcher: ChatGptOAuthFetch = async () => ({
      ok: true,
      status: 200,
      async json() {
        return { access_token: "oauth-access", refresh_token: "oauth-refresh", expires_in: 3600 };
      }
    });
    const auth = await startChatGptBrowserAuth("openai", authStore, { fetcher, openUrl: async () => false, callbackTimeoutMs: 500 });
    const state = new URL(auth.url).searchParams.get("state");
    if (!state) throw new Error("Missing state");

    const response = await fetchText(callbackUrl(auth.url, { code: "authorization-code", state }));

    expect(response.status).toBe(200);
    expect(response.text).toContain("Authorization Successful");
    await expect(authStore.get("openai")).resolves.toMatchObject({ type: "oauth", access: "oauth-access", refresh: "oauth-refresh" });
  });

  it("shows browser callback error on token exchange failure and reuses the port", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-chatgpt-oauth-failure-"));
    const authStore = new ProviderAuthStore(root);
    const fetcher: ChatGptOAuthFetch = async () => ({
      ok: false,
      status: 500,
      async json() {
        return {};
      }
    });
    const auth = await startChatGptBrowserAuth("openai", authStore, { fetcher, openUrl: async () => false, callbackTimeoutMs: 500 });
    const state = new URL(auth.url).searchParams.get("state");
    if (!state) throw new Error("Missing state");

    const response = await fetchText(callbackUrl(auth.url, { code: "authorization-code", state }));
    await new Promise<void>(resolve => setTimeout(resolve, 25));
    const second = await startChatGptBrowserAuth("openai", authStore, { openUrl: async () => false, callbackTimeoutMs: 500 });

    try {
      expect(response.status).toBe(500);
      expect(response.text).toContain("Authorization Failed");
      expect(response.text).toContain("Token exchange failed: 500");
      await expect(authStore.get("openai")).resolves.toBeUndefined();
    } finally {
      await closeBrowserServer(second.url);
    }
  });

  it("reports headless background polling failures through the observable hook", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-chatgpt-headless-error-"));
    const authStore = new ProviderAuthStore(root);
    let calls = 0;
    const errorPromise = new Promise<Error>(resolve => {
      const fetcher: ChatGptOAuthFetch = async () => {
        calls += 1;
        if (calls === 1) {
          return {
            ok: true,
            status: 200,
            async json() {
              return { device_auth_id: "device-123", user_code: "ABCD-EFGH", interval: "1" };
            }
          };
        }
        return {
          ok: false,
          status: 500,
          async json() {
            return {};
          }
        };
      };
      void startChatGptHeadlessAuth("openai", authStore, { fetcher, callbackTimeoutMs: 50, onBackgroundError: resolve });
    });

    await expect(errorPromise).resolves.toMatchObject({ message: "Device authorization failed: 500" });
    await expect(authStore.get("openai")).resolves.toBeUndefined();
  });
});
