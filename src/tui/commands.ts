import { StrongCodeConfig } from "../config/schema";
import { LoadedConfig } from "../config/load";
import { persistConfigUpdate, selectModel, selectProvider, setModelEnabled } from "../config/save";
import { buildModelsUrl, discoverOpenAICompatibleModels, DiscoveryFetcher, globalFetchTransport } from "../models/discovery";
import { clipDisplayLine, renderModelList, renderProviderList, renderProviderPanel, sanitizeDisplayValue, TuiState } from "./render";
import { looksLikeProviderApiKeyEnv } from "../config/security";

export interface ProviderCommandContext {
  config: StrongCodeConfig | undefined;
  configPath: string;
  state: TuiState;
  noColor: boolean;
  discoverFetcher?: DiscoveryFetcher;
  onConfigUpdated?: (config: StrongCodeConfig) => void;
}

function findFirstProviderModel(config: StrongCodeConfig, providerId: string): string | undefined {
  return Object.entries(config.models).find(([, model]) => model.provider === providerId && model.enabled !== false)?.[0];
}

function resolveModelId(config: StrongCodeConfig, modelId: string): string | undefined {
  return config.models[modelId]
    ? modelId
    : Object.entries(config.models).find(([, model]) => (model.model ?? "") === modelId)?.[0];
}

function isOpenAICompatibleProvider(type: string): boolean {
  return type === "openai" || type === "openai-compatible";
}

function isApiKeyEnv(value: string): boolean {
  return looksLikeProviderApiKeyEnv(value);
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

export async function handleProviderCommand(input: string, context: ProviderCommandContext): Promise<string> {
  if (!context.config) {
    return "Config missing. Run 'strongcode init' first.";
  }

  const args = input.trim().split(/\s+/).slice(1);
  const noColor = context.noColor;
  
  if (args.length === 0) {
    return renderProviderPanel(context.config, context.state, noColor);
  }

  if (args.length === 1 && context.config.providers[args[0]]) {
    return handleProviderCommand(`/provider select ${args[0]}`, context);
  }

  if (args[0] === "list") {
    return renderProviderList(context.config, context.state, noColor);
  }

  if (args[0] === "select" && args[1]) {
    const providerId = args[1];
    const providerLabel = sanitizeDisplayValue(providerId, "unknown");
    if (!context.config.providers[providerId]) {
      return clipDisplayLine(`Unknown provider: ${providerLabel}`);
    }

    const modelId = findFirstProviderModel(context.config, providerId);
    if (!modelId) {
      return clipDisplayLine(`No enabled model for ${providerLabel}. Enable one with /provider enable model <model-id>.`);
    }

    const message = await persistConfig(context, config => {
      const nextConfig = selectProvider(config, providerId);
      config.providers = nextConfig.providers;
      config.agents[config.defaultAgent].model = modelId;
    });
    if (message.startsWith("Error:")) {
      return message;
    }

    return `${message}\n${clipDisplayLine(`Selected ${providerLabel} using model ${sanitizeDisplayValue(modelId, "unknown")}.`)}`;
  }

  if (args[0] === "models" && args[1]) {
    const providerId = args[1];
    const providerLabel = sanitizeDisplayValue(providerId, "unknown");
    const provider = context.config.providers[providerId];
    if (!provider) {
      return clipDisplayLine(`Unknown provider: ${providerLabel}`);
    }

    if (!isOpenAICompatibleProvider(provider.type)) {
      return renderModelList(context.config, providerId, context.state, noColor);
    }

    if (!provider.baseUrl) {
      return clipDisplayLine(`Provider ${providerLabel} discovery needs providers.${providerLabel}.baseUrl and optional modelsEndpoint. Store only apiKeyEnv, never raw keys.`);
    }

    try {
      const discovered = await discoverOpenAICompatibleModels({ ...provider, id: providerId }, context.discoverFetcher ?? globalFetchTransport());
      const message = await persistConfig(context, config => {
        for (const model of discovered) {
          const existing = config.models[model.id];
          config.models[model.id] = {
            provider: model.provider,
            model: model.id,
            enabled: existing?.enabled ?? model.enabled,
            source: model.source,
            displayName: existing?.displayName ?? model.displayName,
            options: existing?.options
          };
        }
      });
      if (message.startsWith("Error:")) {
        return message;
      }

      return `${message}\n${renderModelList(context.config, providerId, context.state, noColor)}`;
    } catch (error) {
      return clipDisplayLine(`Discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (args[0] === "configure" && args[1] === "custom") {
    const [baseUrl, apiKeyEnv] = args.slice(2);
    if (!baseUrl || !apiKeyEnv) {
      return "Usage: /provider configure custom <base-url> <api-key-env>";
    }

    if (!isApiKeyEnv(apiKeyEnv)) {
      return clipDisplayLine(`Invalid api-key-env: ${sanitizeDisplayValue(apiKeyEnv, "unknown")}. Use an API-key environment variable name such as CUSTOM_PROVIDER_API_KEY.`);
    }

    try {
      buildModelsUrl({ baseUrl, modelsEndpoint: "/models" });
    } catch (error) {
      return clipDisplayLine(`Invalid base-url: ${error instanceof Error ? error.message : String(error)}`);
    }

    const message = await persistConfig(context, config => {
      const existing = config.providers.custom;
      config.providers.custom = {
        type: "openai-compatible",
        displayName: existing?.displayName ?? "Custom Provider",
        apiKeyEnv,
        baseUrl,
        modelsEndpoint: existing?.modelsEndpoint ?? "/models",
        enabled: existing?.enabled ?? false
      };
    });
    if (message.startsWith("Error:")) {
      return message;
    }

    return `${message}\n${clipDisplayLine(`Configured custom provider with ${sanitizeDisplayValue(apiKeyEnv, "unknown")}. Run /provider models custom to discover models.`)}`;
  }

  if ((args[0] === "enable" || args[0] === "disable") && args[1] === "model" && args[2]) {
    const modelId = args.slice(2).join(" ");
    const resolvedModelId = resolveModelId(context.config, modelId);
    if (!resolvedModelId) {
      return clipDisplayLine(`Unknown model: ${sanitizeDisplayValue(modelId, "unknown")}`);
    }

    const enabled = args[0] === "enable";
    const message = await persistConfig(context, config => {
      const nextConfig = setModelEnabled(config, resolvedModelId, enabled);
      config.models = nextConfig.models;
    });
    if (message.startsWith("Error:")) {
      return message;
    }

    return `${message}\n${clipDisplayLine(`${enabled ? "Enabled" : "Disabled"} model ${sanitizeDisplayValue(resolvedModelId, "unknown")}.`)}`;
  }

  return "Usage: /provider, /provider list, /provider select <id>, /provider models <id>, /provider configure custom <base-url> <api-key-env>, /provider enable model <id>, /provider disable model <id>";
}

export async function handleModelCommand(input: string, context: ProviderCommandContext): Promise<string> {
  if (!context.config) {
    return "Config missing. Run 'strongcode init' first.";
  }

  const args = input.trim().split(/\s+/).slice(1);
  const noColor = context.noColor;
  if (args.length === 0 || args[0] === "list") {
    return renderModelList(context.config, context.state.provider, context.state, noColor);
  }

  const modelId = args.join(" ");
  const resolvedModelId = resolveModelId(context.config, modelId);
  if (!resolvedModelId) {
    return clipDisplayLine(`Unknown model: ${sanitizeDisplayValue(modelId, "unknown")}`);
  }

  const selectedModel = context.config.models[resolvedModelId];
  if (!selectedModel) {
    return clipDisplayLine(`Unknown model: ${sanitizeDisplayValue(modelId, "unknown")}`);
  }

  const message = await persistConfig(context, config => {
    const nextConfig = selectModel(config, resolvedModelId);
    config.agents = nextConfig.agents;
    config.providers = nextConfig.providers;
    config.models = nextConfig.models;
  });
  if (message.startsWith("Error:")) {
    return message;
  }

  return `${message}\n${clipDisplayLine(`Selected model ${sanitizeDisplayValue(resolvedModelId, "unknown")} using provider ${sanitizeDisplayValue(selectedModel.provider, "unknown")}.`)}`;
}
