import { readFile, writeFile } from "node:fs/promises";
import YAML from "yaml";
import { StrongCodeConfig, strongCodeConfigSchema } from "./schema";
import { LoadedConfig } from "./load";
import { StrongCodeError } from "../core/errors";
import { isSecretLikeConfigKey } from "./security";

function removeUndefinedEntries(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(removeUndefinedEntries);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(Object.entries(value)
    .filter(([, nestedValue]) => nestedValue !== undefined)
    .map(([key, nestedValue]) => [key, removeUndefinedEntries(nestedValue)]));
}

function assertNoSecretFields(value: unknown, path: string[] = []): void {
  if (!value || typeof value !== "object") {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((nestedValue, index) => assertNoSecretFields(nestedValue, [...path, String(index)]));
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (isSecretLikeConfigKey(key)) {
      throw new StrongCodeError("CONFIG_ERROR", `Refusing to write secret-like config field '${[...path, key].join(".")}'`);
    }

    assertNoSecretFields(nestedValue, [...path, key]);
  }
}

export async function saveConfig(configPath: string, config: StrongCodeConfig): Promise<void> {
  const parsed = strongCodeConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new StrongCodeError("CONFIG_ERROR", parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  }

  assertNoSecretFields(parsed.data.providers, ["providers"]);
  assertNoSecretFields(parsed.data.models, ["models"]);

  await writeFile(configPath, YAML.stringify(removeUndefinedEntries(parsed.data)), "utf8");
}

export function setModelEnabled(config: StrongCodeConfig, modelId: string, enabled: boolean): StrongCodeConfig {
  const exactModelConfig = config.models[modelId];
  const resolvedModelId = exactModelConfig
    ? modelId
    : Object.entries(config.models).find(([, model]) => (model.model ?? "") === modelId)?.[0];
  if (!resolvedModelId) {
    throw new StrongCodeError("CONFIG_ERROR", `Model '${modelId}' is not defined`);
  }

  const modelConfig = config.models[resolvedModelId];
  if (!modelConfig) {
    throw new StrongCodeError("CONFIG_ERROR", `Model '${modelId}' is not defined`);
  }

  return {
    ...config,
    models: {
      ...config.models,
      [resolvedModelId]: {
        ...modelConfig,
        enabled
      }
    }
  };
}

export function selectProvider(config: StrongCodeConfig, providerId: string): StrongCodeConfig {
  const providerConfig = config.providers[providerId];
  if (!providerConfig) {
    throw new StrongCodeError("CONFIG_ERROR", `Provider '${providerId}' is not defined`);
  }

  return {
    ...config,
    providers: Object.fromEntries(Object.entries(config.providers).map(([id, provider]) => [id, {
      ...provider,
      enabled: id === providerId
    }]))
  };
}

export function selectModel(config: StrongCodeConfig, modelId: string): StrongCodeConfig {
  const exactModelConfig = config.models[modelId];
  const resolvedModelId = exactModelConfig
    ? modelId
    : Object.entries(config.models).find(([, model]) => (model.model ?? "") === modelId)?.[0];
  if (!resolvedModelId) {
    throw new StrongCodeError("CONFIG_ERROR", `Model '${modelId}' is not defined`);
  }

  const modelConfig = config.models[resolvedModelId];
  if (!modelConfig) {
    throw new StrongCodeError("CONFIG_ERROR", `Model '${modelId}' is not defined`);
  }

  return {
    ...config,
    agents: {
      ...config.agents,
      [config.defaultAgent]: {
        ...config.agents[config.defaultAgent],
        model: resolvedModelId
      }
    },
    providers: Object.fromEntries(Object.entries(config.providers).map(([id, provider]) => [id, {
      ...provider,
      enabled: id === modelConfig.provider
    }])),
    models: {
      ...config.models,
      [resolvedModelId]: {
        ...modelConfig,
        enabled: true
      }
    }
  };
}

export async function persistConfigUpdate(loadedConfig: LoadedConfig, update: (config: StrongCodeConfig) => StrongCodeConfig): Promise<StrongCodeConfig> {
  await readFile(loadedConfig.path, "utf8");
  const updated = update(loadedConfig.config);
  await saveConfig(loadedConfig.path, updated);
  loadedConfig.config = updated;
  return updated;
}
