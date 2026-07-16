import type { StrongCodeConfig } from "../config/schema";
import { StrongCodeError } from "../core/errors";
import type { ProviderAuth, ProviderAuthReader } from "./auth-store";
import { ProviderAuthStore } from "./auth-store";
import { createProviderCatalog, providerAuthMethods, ProviderAuthMethod, ProviderCatalog } from "./catalog";

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
  id?: string;
  type: "api" | "oauth" | "none" | "delegated";
  label: string;
  prompts?: ProviderAuthPrompt[];
}

export type ProviderAuthMethods = Record<string, ProviderAuthMethodDetail[]>;

export interface ProviderServiceOptions {
  allowEnvironmentCredentials?: boolean;
}

export class ProviderService {
  constructor(
    private readonly config: StrongCodeConfig,
    private readonly authStore: ProviderAuthStore,
    private readonly options: ProviderServiceOptions = {}
  ) {}

  async listProviders(): Promise<ProviderCatalog> {
    return createProviderCatalog(this.config, await this.authStore.all(), {
      allowEnvironmentCredentials: this.options.allowEnvironmentCredentials
    });
  }

  listAuthMethods(providerId: string): ProviderAuthMethod[] {
    const provider = this.config.providers[providerId];
    if (!provider) throw new StrongCodeError("CONFIG_ERROR", `Provider '${providerId}' is not defined`);
    return providerAuthMethods(providerId, provider);
  }

  authMethods(): ProviderAuthMethods {
    const methods: ProviderAuthMethods = {};
    for (const [providerId, provider] of Object.entries(this.config.providers)) {
      if (provider.type === "mock") continue;
      const available = providerAuthMethods(providerId, provider);
      methods[providerId] = available.includes("none")
        ? [{ type: "none", label: "No credentials (local)" }]
        : available.includes("oauth")
        ? [
          { id: "browser", type: "oauth", label: "ChatGPT browser login" },
          { id: "device-code", type: "oauth", label: "ChatGPT headless/device-code login" }
        ]
        : available.includes("delegated")
        ? [{ type: "delegated", label: "Google Application Default Credentials" }]
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

}

export async function listProviders(config: StrongCodeConfig, authStore: ProviderAuthReader): Promise<ProviderCatalog> {
  return createProviderCatalog(config, await authStore.all());
}
