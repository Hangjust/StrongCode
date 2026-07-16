import { chmod, lstat, open, readFile, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import YAML from "yaml";
import { strongCodeConfigSchema, type StrongCodeConfig } from "./schema";
import type { LoadedConfig } from "./load";
import { StrongCodeError } from "../core/errors";
import { isSecretLikeConfigKey } from "./security";

export type ExpectedSourceReplacement = {
  readonly filePath: string;
  readonly expectedSourceHash: string;
  readonly content: string | Buffer;
};

export function sha256Source(source: string | Buffer): string {
  return createHash("sha256").update(source).digest("hex");
}

export async function assertNoSymlinkPathComponents(filePath: string): Promise<void> {
  const resolvedPath = path.resolve(filePath);
  const root = path.parse(resolvedPath).root;
  const parent = path.dirname(resolvedPath);
  let current = root;
  for (const segment of path.relative(root, parent).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) {
      throw new StrongCodeError("CONFIG_ERROR", `Refusing config path with a symlink or junction component: ${current}`);
    }
    if (!stats.isDirectory()) {
      throw new StrongCodeError("CONFIG_ERROR", `Refusing config path with a non-directory parent: ${current}`);
    }
  }
}

async function expectedRegularFile(filePath: string): Promise<number> {
  let stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new StrongCodeError("CONFIG_ERROR", `Expected source file no longer exists: ${filePath}`);
    }
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new StrongCodeError("CONFIG_ERROR", `Refusing to replace non-regular or symlinked config file: ${filePath}`);
  }
  return stats.mode & 0o777;
}

export async function atomicReplaceExpectedSource(replacement: ExpectedSourceReplacement): Promise<void> {
  const filePath = path.resolve(replacement.filePath);
  await assertNoSymlinkPathComponents(filePath);
  const mode = await expectedRegularFile(filePath);
  if (sha256Source(await readFile(filePath)) !== replacement.expectedSourceHash) {
    throw new StrongCodeError("CONFIG_ERROR", `Config changed after planning; refusing stale replacement: ${filePath}`);
  }

  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.planned.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(tempPath, "wx", mode);
    await handle.writeFile(replacement.content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(tempPath, mode).catch(() => undefined);

    await assertNoSymlinkPathComponents(filePath);
    await expectedRegularFile(filePath);
    if (sha256Source(await readFile(filePath)) !== replacement.expectedSourceHash) {
      throw new StrongCodeError("CONFIG_ERROR", `Config changed after planning; refusing stale replacement: ${filePath}`);
    }
    await rename(tempPath, filePath);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

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

  const resolvedPath = path.resolve(configPath);
  try {
    const stats = await lstat(resolvedPath);
    if (stats.isSymbolicLink()) {
      throw new StrongCodeError("CONFIG_ERROR", `Refusing to replace symlinked config file: ${resolvedPath}`);
    }
  } catch (error) {
    if (error instanceof StrongCodeError) throw error;
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }

  const tempPath = path.join(path.dirname(resolvedPath), `.${path.basename(resolvedPath)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(tempPath, YAML.stringify(removeUndefinedEntries(parsed.data)), { encoding: "utf8", flag: "wx", mode: 0o600 });
  await chmod(tempPath, 0o600).catch(() => undefined);
  await rename(tempPath, resolvedPath);
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
    providers: {
      ...config.providers,
      [providerId]: {
        ...providerConfig,
        enabled: true
      }
    }
  };
}

export function selectModel(config: StrongCodeConfig, modelId: string, agentName = config.defaultAgent): StrongCodeConfig {
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

  const currentAgent = config.agents[agentName] ?? config.agents[config.defaultAgent];
  if (!currentAgent) {
    throw new StrongCodeError("CONFIG_ERROR", `Agent '${agentName}' is not defined and no default agent is available`);
  }

  return {
    ...config,
    agents: {
      ...config.agents,
      [agentName]: {
        ...currentAgent,
        model: resolvedModelId
      }
    },
    providers: {
      ...config.providers,
      [modelConfig.provider]: {
        ...config.providers[modelConfig.provider],
        enabled: true
      }
    },
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
