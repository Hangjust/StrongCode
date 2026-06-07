import type { StrongCodeConfig } from "../config/schema";
import { StrongCodeError } from "../core/errors";
import type { ProviderAuth, ProviderAuthReader } from "./auth-store";
import { ProviderAuthStore } from "./auth-store";
import { createProviderCatalog, ProviderAuthMethod, ProviderCatalog } from "./catalog";
import { ChatGptOAuthOptions, startChatGptBrowserAuth, startChatGptHeadlessAuth } from "./chatgpt-oauth";

export interface ProviderAuthPromptBase {
  key: string;
  message: string;
  when?: { key: string; op: "eq" | "neq"; value: string };
}

export interface ProviderAuthTextPrompt extends ProviderAuthPromptBase {
  type: "text";
  placeholder?: string;
}

export interface ProviderAuthSelectPrompt extends ProviderAuthPromptBase {
  type: "select";
  options: Array<{ label: string; value: string; hint?: string }>;
}

export type ProviderAuthPrompt = ProviderAuthTextPrompt | ProviderAuthSelectPrompt;

export interface ProviderAuthMethodDetail {
  type: "api" | "oauth";
  label: string;
  prompts?: ProviderAuthPrompt[];
}

export type ProviderAuthMethods = Record<string, ProviderAuthMethodDetail[]>;

export class ProviderService {
  constructor(private readonly config: StrongCodeConfig, private readonly authStore: ProviderAuthStore, private readonly oauthOptions: ChatGptOAuthOptions = {}) {}

  async listProviders(): Promise<ProviderCatalog> {
    return createProviderCatalog(this.config, await this.authStore.all());
  }

  listAuthMethods(providerId: string): ProviderAuthMethod[] {
    const provider = this.config.providers[providerId];
    if (!provider) throw new StrongCodeError("CONFIG_ERROR", `Provider '${providerId}' is not defined`);
    if (provider.type === "mock") return ["none"];
    if (provider.type === "openai") return ["api_key", "oauth"];
    return ["api_key"];
  }

  authMethods(): ProviderAuthMethods {
    const methods: ProviderAuthMethods = {};
    for (const [providerId, provider] of Object.entries(this.config.providers)) {
      if (provider.type === "mock") continue;
      methods[providerId] = provider.type === "openai"
        ? [{ type: "oauth", label: "ChatGPT Plus/Pro" }, { type: "api", label: "Manually enter API Key" }]
        : [{ type: "api", label: "API key" }];
    }
    return methods;
  }

  async setAuth(providerId: string, auth: ProviderAuth): Promise<void> {
    if (!this.config.providers[providerId]) throw new StrongCodeError("CONFIG_ERROR", `Provider '${providerId}' is not defined`);
    await this.authStore.set(providerId, auth);
  }

  async removeAuth(providerId: string): Promise<void> {
    if (!this.config.providers[providerId]) throw new StrongCodeError("CONFIG_ERROR", `Provider '${providerId}' is not defined`);
    await this.authStore.remove(providerId);
  }

  async authorizeOAuth(providerId: string): Promise<{ url: string; instructions: string }> {
    const provider = this.config.providers[providerId];
    if (!provider) throw new StrongCodeError("CONFIG_ERROR", `Provider '${providerId}' is not defined`);
    if (provider.type !== "openai") throw new StrongCodeError("CONFIG_ERROR", `OAuth for provider '${providerId}' is not supported`);
    return startChatGptBrowserAuth(providerId, this.authStore, this.oauthOptions);
  }

  async callbackOAuth(providerId: string): Promise<{ url: string; instructions: string }> {
    const provider = this.config.providers[providerId];
    if (!provider) throw new StrongCodeError("CONFIG_ERROR", `Provider '${providerId}' is not defined`);
    if (provider.type !== "openai") throw new StrongCodeError("CONFIG_ERROR", `OAuth callback for provider '${providerId}' is not supported`);
    return startChatGptHeadlessAuth(providerId, this.authStore, this.oauthOptions);
  }
}

export async function listProviders(config: StrongCodeConfig, authStore: ProviderAuthReader): Promise<ProviderCatalog> {
  return createProviderCatalog(config, await authStore.all());
}
