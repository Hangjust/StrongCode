import path from "node:path";
import { StrongCodeConfig } from "../config/schema";
import { LoadedConfig } from "../config/load";
import { persistConfigUpdate, selectProvider } from "../config/save";
import { ProviderAuthStore } from "../models/auth-store";
import { ProviderService } from "../models/provider-service";
import { ChatGptOAuthOptions } from "../models/chatgpt-oauth";
import { clipDisplayLine, renderConnectPanel, sanitizeDisplayValue, TuiState } from "./render";

export interface ProviderCommandContext {
  config: StrongCodeConfig | undefined;
  configPath: string;
  state: TuiState;
  noColor: boolean;
  authStore?: ProviderAuthStore;
  oauthOptions?: ChatGptOAuthOptions;
  onConfigUpdated?: (config: StrongCodeConfig) => void;
}

function findFirstProviderModel(config: StrongCodeConfig, providerId: string): string | undefined {
  return Object.entries(config.models).find(([, model]) => model.provider === providerId && model.enabled !== false)?.[0];
}


function authStoreForContext(context: ProviderCommandContext): ProviderAuthStore | undefined {
  if (context.authStore) return context.authStore;
  if (!context.config) return undefined;
  const configDirectory = path.dirname(path.resolve(context.configPath));
  return new ProviderAuthStore(path.resolve(configDirectory, context.config.dataDir));
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
  const service = new ProviderService(context.config, authStore, context.oauthOptions);
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

  if (provider.type === "openai" && args[1] === "chatgpt-browser") {
    try {
      const auth = await service.authorizeOAuth(providerId);
      return `${clipDisplayLine(`Started ChatGPT browser login for ${providerLabel}. ${auth.instructions}`)}\n${clipDisplayLine(auth.url)}`;
    } catch (error) {
      return clipDisplayLine(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (provider.type === "openai" && args[1] === "chatgpt-headless") {
    try {
      const auth = await service.callbackOAuth(providerId);
      return `${clipDisplayLine(`Started ChatGPT headless login for ${providerLabel}. ${auth.instructions}`)}\n${clipDisplayLine(auth.url)}`;
    } catch (error) {
      return clipDisplayLine(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (args[1] === ["o", "auth"].join("")) {
    return clipDisplayLine(provider.type === "openai" ? `Usage: /connect ${providerLabel} <api-key>|chatgpt-browser|chatgpt-headless.` : `Usage: /connect ${providerLabel} <api-key>.`);
  }

  const apiKey = args.slice(1).join(" ").trim();
  if (!apiKey) {
    const methods = service.listAuthMethods(providerId).join(", ");
    if (provider.type === "openai") {
      return [
        clipDisplayLine(`Usage: /connect ${providerLabel} <api-key>. Auth methods: ${methods}.`),
        clipDisplayLine(`/connect ${providerLabel} chatgpt-browser`),
        clipDisplayLine(`/connect ${providerLabel} chatgpt-headless`)
      ].join("\n");
    }
    return clipDisplayLine(`Usage: /connect ${providerLabel} <api-key>. Auth methods: ${methods}.`);
  }

  try {
    await service.setAuth(providerId, { type: "api", key: apiKey });
    const firstModel = findFirstProviderModel(context.config, providerId);
    const message = await persistConfig(context, config => {
      config.providers[providerId] = { ...config.providers[providerId], enabled: true };
      if (firstModel) config.agents[config.defaultAgent].model = firstModel;
    });
    if (message.startsWith("Error:")) return message;
    const nextStep = firstModel ? `Ready to use.` : `No models configured for this provider.`;
    return `${message}\n${clipDisplayLine(`Connected ${providerLabel}; credentials saved in auth.json. ${nextStep}`)}`;
  } catch (error) {
    return clipDisplayLine(`Error: ${error instanceof Error ? error.message : String(error)}`);
  }
}


