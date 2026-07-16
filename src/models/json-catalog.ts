import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { StrongCodeConfig, modelConfigSchema, providerConfigSchema } from "../config/schema";
import { StrongCodeError } from "../core/errors";
import { readVerifiedRegularFile, revalidatePath, type PathReceipt } from "../core/path-identity";
import { isSecretLikeConfigKey } from "../config/security";
import { providerDefaults } from "./registry";

export const DEFAULT_MODEL_CATALOG_FILE = "models.json";
const MAX_MODEL_CATALOG_BYTES = 5 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

export interface ModelCatalogLoadResult {
  config: StrongCodeConfig;
  path: string;
  loaded: boolean;
}

export type ModelCatalogLoadOptions = {
  readonly automaticHomeReceipt?: PathReceipt;
};

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function recordValue(value: unknown): JsonObject | undefined {
  return isObject(value) ? value : undefined;
}

function definedEntries<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, nestedValue]) => nestedValue !== undefined)) as Partial<T>;
}

function assertNoCatalogSecrets(value: unknown, catalogPath: string, pathParts: string[] = []): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCatalogSecrets(item, catalogPath, [...pathParts, String(index)]));
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const nextPath = [...pathParts, key];
    if (key.toLowerCase() === "key" || isSecretLikeConfigKey(key)) {
      throw new StrongCodeError("CONFIG_ERROR", `Refusing to load secret-like model catalog field '${nextPath.join(".")}' from ${catalogPath}`);
    }
    assertNoCatalogSecrets(nestedValue, catalogPath, nextPath);
  }
}

export function modelCatalogPath(configDirectory: string, config: Pick<StrongCodeConfig, "dataDir">): string {
  return path.resolve(configDirectory, config.dataDir, DEFAULT_MODEL_CATALOG_FILE);
}

function providerTypeFor(providerId: string, value: JsonObject): string {
  const explicit = stringValue(value.type);
  if (explicit) return explicit;
  if (providerId === "mock") return "mock";
  if (providerId === "openai") return "openai";
  if (providerId === "anthropic") return "anthropic";
  if (providerId === "google") return "google";
  return "openai-compatible";
}

function normalizeProvider(providerId: string, value: unknown, hasTrustedDefaults: boolean): StrongCodeConfig["providers"][string] | undefined {
  if (!isObject(value)) return undefined;

  const candidate: Record<string, unknown> = {
    type: providerTypeFor(providerId, value),
    displayName: stringValue(value.displayName) ?? stringValue(value.name) ?? providerId
  };

  if (!hasTrustedDefaults) candidate.enabled = false;

  const parsed = providerConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new StrongCodeError("CONFIG_ERROR", parsed.error.issues.map(issue => `models.json providers.${providerId}.${issue.path.join(".")}: ${issue.message}`).join("; "));
  }
  return parsed.data;
}

function modelDisplayName(modelId: string, value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  return stringValue(value.displayName) ?? stringValue(value.name) ?? (stringValue(value.id) && stringValue(value.id) !== modelId ? modelId : undefined);
}

function modelApiId(modelId: string, value: unknown): string {
  if (!isObject(value)) return modelId;
  const api = recordValue(value.api);
  return stringValue(value.model) ?? stringValue(value.id) ?? stringValue(api?.id) ?? modelId;
}

function normalizeModel(modelKey: string, value: unknown, providerId?: string): StrongCodeConfig["models"][string] | undefined {
  if (!isObject(value)) return undefined;
  const resolvedProviderId = providerId ?? stringValue(value.provider);
  if (!resolvedProviderId) return undefined;

  const parsed = modelConfigSchema.safeParse({
    provider: resolvedProviderId,
    model: modelApiId(modelKey, value),
    displayName: modelDisplayName(modelKey, value),
    enabled: booleanValue(value.enabled) ?? true,
    source: stringValue(value.source) ?? "catalog",
    options: recordValue(value.options)
  });
  if (!parsed.success) {
    throw new StrongCodeError("CONFIG_ERROR", parsed.error.issues.map(issue => `models.json models.${modelKey}.${issue.path.join(".")}: ${issue.message}`).join("; "));
  }
  return parsed.data;
}

function mergeCatalog(config: StrongCodeConfig, catalog: unknown, catalogPath: string): StrongCodeConfig {
  if (!isObject(catalog)) {
    throw new StrongCodeError("CONFIG_ERROR", `Model catalog must be a JSON object: ${catalogPath}`);
  }

  assertNoCatalogSecrets(catalog, catalogPath);

  const providers = { ...config.providers };
  const models = { ...config.models };
  const defaults = providerDefaults();
  const catalogProviders = recordValue(catalog.providers) ?? recordValue(catalog.provider) ?? {};

  for (const [providerId, providerValue] of Object.entries(catalogProviders)) {
    const normalized = normalizeProvider(providerId, providerValue, Object.hasOwn(defaults, providerId) || Object.hasOwn(providers, providerId));
    providers[providerId] = {
      ...(defaults[providerId] ?? {}),
      ...(normalized ? definedEntries(normalized) : {}),
      ...providers[providerId]
    };

    const nestedModels = recordValue(providerValue)?.models;
    if (isObject(nestedModels)) {
      for (const [modelId, modelValue] of Object.entries(nestedModels)) {
        const normalizedModel = normalizeModel(modelId, modelValue, providerId);
        if (!normalizedModel) continue;
        const key = models[modelId] && models[modelId].provider !== providerId ? `${providerId}:${modelId}` : modelId;
        models[key] = { ...normalizedModel, ...models[key] };
      }
    }
  }

  const catalogModels = recordValue(catalog.models) ?? {};
  for (const [modelId, modelValue] of Object.entries(catalogModels)) {
    const providerId = isObject(modelValue) ? stringValue(modelValue.provider) : undefined;
    const normalizedModel = normalizeModel(modelId, modelValue, providerId);
    if (!normalizedModel) continue;
    if (!providers[normalizedModel.provider]) {
      providers[normalizedModel.provider] = defaults[normalizedModel.provider] ?? {
        type: providerTypeFor(normalizedModel.provider, {}),
        displayName: normalizedModel.provider,
        enabled: true
      };
    }
    const key = models[modelId] && models[modelId].provider !== normalizedModel.provider ? `${normalizedModel.provider}:${modelId}` : modelId;
    models[key] = { ...normalizedModel, ...models[key] };
  }

  return {
    ...config,
    providers,
    models
  };
}

export async function loadJsonModelCatalog(
  config: StrongCodeConfig,
  configDirectory: string,
  options: ModelCatalogLoadOptions = {}
): Promise<ModelCatalogLoadResult> {
  const catalogPath = modelCatalogPath(configDirectory, config);
  let stats;
  try {
    stats = await lstat(catalogPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { config, path: catalogPath, loaded: false };
    }
    throw new StrongCodeError("CONFIG_ERROR", `Failed to inspect model catalog ${catalogPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new StrongCodeError("CONFIG_ERROR", `Refusing to load non-regular model catalog: ${catalogPath}`);
  }
  if (stats.size > MAX_MODEL_CATALOG_BYTES) {
    throw new StrongCodeError("CONFIG_ERROR", `Model catalog exceeds ${MAX_MODEL_CATALOG_BYTES} bytes: ${catalogPath}`);
  }

  let parsed: unknown;
  try {
    if (options.automaticHomeReceipt !== undefined) {
      await revalidatePath(options.automaticHomeReceipt);
      const bytes = await readVerifiedRegularFile(catalogPath, {
        maxBytes: BigInt(MAX_MODEL_CATALOG_BYTES),
        requireSingleLink: true
      });
      parsed = JSON.parse(bytes.toString("utf8"));
    } else {
      parsed = JSON.parse(await readFile(catalogPath, "utf8"));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new StrongCodeError("CONFIG_ERROR", `Failed to read model catalog ${catalogPath}: ${message}`);
  }

  return {
    config: mergeCatalog(config, parsed, catalogPath),
    path: catalogPath,
    loaded: true
  };
}
