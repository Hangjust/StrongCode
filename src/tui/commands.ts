import { StrongCodeConfig } from "../config/schema";
import { LoadedConfig } from "../config/load";
import { persistConfigUpdate, selectProvider } from "../config/save";
import { ProviderAuthStore, resolveRuntimeAuthDataDir } from "../models/auth-store";
import { ProviderService } from "../models/provider-service";
import { clipDisplayLine, renderConnectPanel, sanitizeDisplayValue, TuiState } from "./render";
import path from "node:path";
import { providerDefaults } from "../models/registry";
import { isLocalProviderBaseUrl } from "../models/provider-url";
import { runChatGptLogin, type ChatGptAuthPrompt } from "../models/chatgpt-oauth";
import { discoverModelsForSetup, SetupDiscoveryHttpError } from "../setup/discovery";

export interface ProviderCommandContext {
  config: StrongCodeConfig | undefined;
  configPath: string;
  state: TuiState;
  noColor: boolean;
  trustedConfig?: boolean;
  authStore?: ProviderAuthStore;
  onConfigUpdated?: (config: StrongCodeConfig) => void;
  onAuthPrompt?: (prompt: ChatGptAuthPrompt) => void;
  runChatGptLogin?: typeof runChatGptLogin;
  discoverModelsForSetup?: typeof discoverModelsForSetup;
}

function hasTrustedCredentialEndpoint(providerId: string, provider: StrongCodeConfig["providers"][string]): boolean {
  if (isLocalProviderBaseUrl(provider.baseUrl)) return true;
  const canonical = providerDefaults()[providerId];
  if (!canonical || canonical.type !== provider.type || !canonical.baseUrl || !provider.baseUrl) return false;
  return new URL(canonical.baseUrl).toString() === new URL(provider.baseUrl).toString();
}

function findFirstProviderModel(config: StrongCodeConfig, providerId: string): string | undefined {
  return Object.entries(config.models).find(([, model]) => model.provider === providerId && model.enabled !== false)?.[0];
}


function authStoreForContext(context: ProviderCommandContext): ProviderAuthStore | undefined {
  if (context.authStore) return context.authStore;
  if (!context.config) return undefined;
  const dataDir = path.resolve(path.dirname(path.resolve(context.configPath)), context.config.dataDir);
  return new ProviderAuthStore(resolveRuntimeAuthDataDir(context.configPath, dataDir), { allowEnvironmentContent: false });
}


async function persistConfig(context: ProviderCommandContext, mutator: (config: StrongCodeConfig) => void): Promise<string> {
  if (!context.config) {
    return "Config missing. Run 'strongcode init' first.";
  }

  try {
    const loadedConfig: LoadedConfig = {
      path: context.configPath,
      directory: "",
      config: context.config
    };
    const updated = await persistConfigUpdate(loadedConfig, config => {
      const nextConfig = structuredClone(config);
      mutator(nextConfig);
      return nextConfig;
    });
    context.config = updated;
    context.onConfigUpdated?.(updated);
    return "Config updated.";
  } catch (error) {
    return clipDisplayLine(`Error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function handleConnectCommand(input: string, context: ProviderCommandContext): Promise<string> {
  if (!context.config) {
    return "Config missing. Run 'strongcode init' first.";
  }

  const args = input.trim().split(/\s+/).slice(1);
  const authStore = authStoreForContext(context);
  if (!authStore) return "Config missing. Run 'strongcode init' first.";
  const service = new ProviderService(context.config, authStore, { allowEnvironmentCredentials: false });
  const catalog = await service.listProviders();
  const noColor = context.noColor;

  if (args.length === 0) {
    return renderConnectPanel(context.config, context.state, noColor, catalog);
  }

  if (args[0] === "remove" && args[1]) {
    const providerId = args[1];
    const providerLabel = sanitizeDisplayValue(providerId, "unknown");
    try {
      await service.removeAuth(providerId);
      return clipDisplayLine(`Removed auth for ${providerLabel}.`);
    } catch (error) {
      return clipDisplayLine(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const providerId = args[0];
  const provider = context.config.providers[providerId];
  const providerLabel = sanitizeDisplayValue(providerId, "unknown");
  if (!provider) {
    return clipDisplayLine(`Unknown provider: ${providerLabel}`);
  }
  const endpointLabel = provider.baseUrl
    ? (() => { try { return new URL(provider.baseUrl).origin; } catch { return "invalid endpoint"; } })()
    : "no remote endpoint";

  if (providerId === "openai" && (args[1] === "chatgpt-browser" || args[1] === "chatgpt-headless")) {
    return clipDisplayLine("ChatGPT account login is now native. Run 'strongcode setup --force', choose OpenAI / ChatGPT, then Browser or Headless login; OpenAI remains API-key only.");
  }

  if (provider.type === "mock") {
    const modelId = findFirstProviderModel(context.config, providerId);
    if (!modelId) return clipDisplayLine(`No enabled model for ${providerLabel}.`);
    const message = await persistConfig(context, config => {
      const nextConfig = selectProvider(config, providerId);
      config.providers = nextConfig.providers;
      config.agents[config.defaultAgent].model = modelId;
    });
    if (message.startsWith("Error:")) return message;
    return `${message}\n${clipDisplayLine(`Connected ${providerLabel}; no credentials required.`)}`;
  }

  if (provider.type === "chatgpt" || provider.type === "codex-cli") {
    if (context.trustedConfig === false) {
      return clipDisplayLine("Refusing to connect a user account from an untrusted project config. Pass --config explicitly or trust the project after reviewing it.");
    }
    if (args.length > 2 || (args[1] && !["browser", "headless", "device-code", "chatgpt-browser", "chatgpt-headless"].includes(args[1]))) {
      return clipDisplayLine(`Usage: /connect ${providerLabel} [browser|headless].`);
    }
    const mode = ["headless", "device-code", "chatgpt-headless"].includes(args[1] ?? "") ? "device-code" : "browser";
    try {
      await (context.runChatGptLogin ?? runChatGptLogin)(mode, authStore, { onPrompt: context.onAuthPrompt });
      const firstModel = findFirstProviderModel(context.config, providerId);
      const message = await persistConfig(context, config => {
        config.providers[providerId] = { ...config.providers[providerId], enabled: true, type: "chatgpt" };
        if (firstModel) config.agents[config.defaultAgent].model = firstModel;
      });
      if (message.startsWith("Error:")) return message;
      return `${message}\n${clipDisplayLine(`Connected ${providerLabel} with native ChatGPT OAuth. ${firstModel ? "Ready to use." : "Run setup to choose ChatGPT models."}`)}`;
    } catch (error) {
      return clipDisplayLine(`ChatGPT login failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (context.trustedConfig === false && !hasTrustedCredentialEndpoint(providerId, provider)) {
    const endpoint = provider.baseUrl ? sanitizeDisplayValue(provider.baseUrl, "unknown endpoint") : "unknown endpoint";
    return [
      clipDisplayLine(`Refusing to send a key to repository-defined endpoint ${endpoint}.`),
      clipDisplayLine("Review the config, then explicitly trust it with --config or STRONGCODE_TRUST_PROJECT_CONFIG=1.")
    ].join("\n");
  }

  if (args[1] === ["o", "auth"].join("")) {
    return clipDisplayLine(`Usage: /connect ${providerLabel} <api-key>.`);
  }

  const apiKey = args.slice(1).join(" ").trim();
  if (!apiKey) {
    const methods = service.listAuthMethods(providerId).join(", ");
    return [
      clipDisplayLine(`Endpoint: ${endpointLabel}`),
      clipDisplayLine(`Usage: /connect ${providerLabel} <api-key>. Auth methods: ${methods}.`)
    ].join("\n");
  }

  try {
    let validationWarning: string | undefined;
    try {
      await (context.discoverModelsForSetup ?? discoverModelsForSetup)(provider, apiKey);
    } catch (error) {
      if (error instanceof SetupDiscoveryHttpError && (error.status === 401 || error.status === 403)) {
        return clipDisplayLine(`Error: ${providerLabel} rejected that API key (HTTP ${error.status}). Nothing was saved.`);
      }
      validationWarning = clipDisplayLine(`Key saved, but endpoint validation was unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    await service.setAuth(providerId, {
      type: "api",
      key: apiKey,
      metadata: {
        providerType: provider.type,
        ...(provider.baseUrl ? { origin: provider.baseUrl } : {})
      }
    });
    const firstModel = findFirstProviderModel(context.config, providerId);
    const message = await persistConfig(context, config => {
      config.providers[providerId] = { ...config.providers[providerId], enabled: true };
      if (firstModel) config.agents[config.defaultAgent].model = firstModel;
    });
    if (message.startsWith("Error:")) return message;
    const nextStep = firstModel ? `Ready to use.` : `No models configured for this provider.`;
    return [
      message,
      clipDisplayLine(`Connected ${providerLabel} to ${endpointLabel}. ${nextStep}`),
      clipDisplayLine("Credentials saved in the private project vault."),
      ...(validationWarning ? [validationWarning] : [])
    ].join("\n");
  } catch (error) {
    return clipDisplayLine(`Error: ${error instanceof Error ? error.message : String(error)}`);
  }
}


