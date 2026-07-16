import { chmod, lstat, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config/load";
import { saveConfig } from "../config/save";
import type { ModelConfig, ProviderConfig, StrongCodeConfig } from "../config/schema";
import { StrongCodeError } from "../core/errors";
import { providerDefaults } from "../models/registry";
import { DEFAULT_AGENT_TOOLS, DEFAULT_TOOL_PERMISSIONS } from "../tools/defaults";
import { withGeneratedPreflightDefaults } from "./preflight-defaults";

export const GLOBAL_CONFIG_FILE = "strongcode.config.yaml";

export function globalConfigPath(homePath: string): string {
  return path.join(path.resolve(homePath), GLOBAL_CONFIG_FILE);
}

export function createSetupConfig(): StrongCodeConfig {
  return {
    version: 1,
    workspace: ".",
    dataDir: ".",
    defaultAgent: "tesla",
    providers: providerDefaults(),
    agents: {
      tesla: {
        model: "mock",
        tools: [...DEFAULT_AGENT_TOOLS]
      }
    },
    models: {
      mock: {
        provider: "mock",
        model: "mock",
        displayName: "Mock",
        enabled: true,
        source: "built-in",
        options: undefined
      }
    },
    permissions: {
      tools: { ...DEFAULT_TOOL_PERMISSIONS }
    }
  };
}

export async function loadSetupConfig(homePath: string): Promise<StrongCodeConfig> {
  const filePath = globalConfigPath(homePath);
  const loaded = await loadConfig(filePath, { strongCodeHome: globalConfigPath(homePath) });
  if (loaded.ok) return { ...loaded.value.config, providers: { ...providerDefaults(), ...loaded.value.config.providers } };
  if (loaded.error.message.includes("Config file not found")) return createSetupConfig();
  throw loaded.error;
}

export function mergeConfiguredProvider(
  config: StrongCodeConfig,
  providerId: string,
  provider: ProviderConfig,
  models: Array<{ id: string; displayName?: string; enabled?: boolean; source?: string }>,
  options: { replaceExistingModels?: boolean; selectAsDefault?: boolean } = {}
): StrongCodeConfig {
  const nextModels = Object.fromEntries(Object.entries(config.models).map(([key, model]) => [
    key,
    options.replaceExistingModels && model.provider === providerId ? { ...model, enabled: false } : model
  ]));
  for (const discovered of models) {
    const existingKey = Object.entries(nextModels).find(([key, model]) => model.provider === providerId && (model.model === discovered.id || key === discovered.id))?.[0];
    const key = existingKey ?? (nextModels[discovered.id] ? `${providerId}:${discovered.id}` : discovered.id);
    const existing = nextModels[key];
    nextModels[key] = {
      provider: providerId,
      model: discovered.id,
      displayName: discovered.displayName ?? existing?.displayName ?? discovered.id,
      enabled: discovered.enabled ?? (options.replaceExistingModels ? true : existing?.enabled ?? true),
      source: discovered.source ?? existing?.source ?? "setup",
      options: existing?.options
    };
  }

  const preferredModelId = models[0]?.id;
  const firstModel = Object.entries(nextModels).find(([, model]) =>
    model.provider === providerId && model.enabled !== false && model.model === preferredModelId
  )?.[0] ?? Object.entries(nextModels).find(([, model]) => model.provider === providerId && model.enabled !== false)?.[0];
  const currentModel = config.agents[config.defaultAgent]?.model;
  const currentProvider = currentModel ? nextModels[currentModel]?.provider : undefined;
  const shouldSelect = options.selectAsDefault === true || !currentProvider || currentProvider === "mock";
  return {
    ...config,
    providers: {
      ...config.providers,
      [providerId]: { ...provider, enabled: true }
    },
    models: nextModels,
    agents: shouldSelect && firstModel ? {
      ...config.agents,
      [config.defaultAgent]: {
        ...config.agents[config.defaultAgent],
        model: firstModel
      }
    } : config.agents
  };
}

export function configuredProviderIds(config: StrongCodeConfig): string[] {
  return Object.entries(config.providers)
    .filter(([id, provider]) => id !== "mock" && id !== "custom" && provider.enabled !== false)
    .map(([id]) => id);
}

/** Disable every previously configured non-mock provider that was not kept during setup. */
export function disableProvidersExcept(config: StrongCodeConfig, providerIds: Iterable<string>): StrongCodeConfig {
  const kept = new Set(providerIds);
  return {
    ...config,
    providers: Object.fromEntries(Object.entries(config.providers).map(([id, provider]) => [
      id,
      id === "mock" || kept.has(id) ? provider : { ...provider, enabled: false }
    ]))
  };
}

export function hasModel(config: StrongCodeConfig, expression: RegExp): boolean {
  return Object.values(config.models).some(model => expression.test(model.model ?? ""));
}

async function assertNotSymlink(filePath: string): Promise<void> {
  try {
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink()) throw new StrongCodeError("CONFIG_ERROR", `Refusing to replace symlinked home config: ${filePath}`);
  } catch (error) {
    if (error instanceof StrongCodeError) throw error;
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  await assertNotSymlink(filePath);
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await chmod(tempPath, 0o600).catch(() => undefined);
  await rename(tempPath, filePath);
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
    if (error instanceof SyntaxError) throw new StrongCodeError("CONFIG_ERROR", `Invalid JSON in ${filePath}`);
    throw error;
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function mergeRecordEntries(existing: unknown, incoming: Record<string, unknown>): Record<string, unknown> {
  const current = object(existing);
  const merged = Object.fromEntries(Object.entries(incoming).map(([id, value]) => [id, {
    ...object(current[id]),
    ...object(value)
  }]));
  return { ...current, ...merged };
}

export async function saveSetupConfig(homePath: string, config: StrongCodeConfig): Promise<StrongCodeConfig> {
  const resolvedHome = path.resolve(homePath);
  const persistedConfig = withGeneratedPreflightDefaults(config);
  await saveConfig(globalConfigPath(resolvedHome), persistedConfig);

  const providersPath = path.join(resolvedHome, "providers.json");
  const agentsPath = path.join(resolvedHome, "agents.json");
  const modelsPath = path.join(resolvedHome, "models.json");
  const existingProviders = await readJsonObject(providersPath);
  const existingAgents = await readJsonObject(agentsPath);
  const existingModels = await readJsonObject(modelsPath);
  await atomicJson(providersPath, {
    ...existingProviders,
    version: 1,
    credentialStore: "auth.json",
    providers: mergeRecordEntries(existingProviders.providers, persistedConfig.providers)
  });
  await atomicJson(agentsPath, {
    ...existingAgents,
    version: 1,
    defaultAgent: persistedConfig.defaultAgent,
    agents: mergeRecordEntries(existingAgents.agents, persistedConfig.agents)
  });
  await atomicJson(modelsPath, {
    ...existingModels,
    version: 1,
    defaultModel: persistedConfig.agents[persistedConfig.defaultAgent]?.model ?? existingModels.defaultModel,
    models: mergeRecordEntries(existingModels.models, persistedConfig.models)
  });
  return persistedConfig;
}

export function modelsForProvider(config: StrongCodeConfig, providerId: string): Array<{ key: string; model: ModelConfig }> {
  return Object.entries(config.models)
    .filter(([, model]) => model.provider === providerId)
    .map(([key, model]) => ({ key, model }));
}
