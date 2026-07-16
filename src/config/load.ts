import { lstatSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { StrongCodeError, toStrongCodeError } from "../core/errors";
import {
  inspectPath,
  readVerifiedRegularFile,
  revalidatePath,
  type PathReceipt
} from "../core/path-identity";
import { err, ok, Result } from "../core/result";
import { StrongCodeConfig, strongCodeConfigSchema } from "./schema";
import { loadJsonModelCatalog } from "../models/json-catalog";
import { strongCodeHomePath } from "./paths";
import { loadRuntimeCatalog, type RuntimeCatalog } from "./runtime-catalog";

export const DEFAULT_CONFIG_PATH = "strongcode.config.yaml";
const MAX_IMPLICIT_PROJECT_CONFIG_BYTES = 1024 * 1024;

function pathEntryExists(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export interface ResolveConfigPathOptions {
  cwd?: string;
  homeDirectory?: string;
  strongCodeHome?: string;
}

type ConfigSelection =
  | { readonly kind: "automatic-home"; readonly path: string }
  | { readonly kind: "automatic-project"; readonly path: string }
  | { readonly kind: "explicit"; readonly path: string; readonly atHomePath: boolean };

export type ConfigSourceMetadata =
  | { readonly kind: "automatic-home"; readonly receipt: PathReceipt }
  | { readonly kind: "automatic-project" }
  | { readonly kind: "explicit"; readonly atHomePath: boolean };

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function selectedHomeConfigPath(options: ResolveConfigPathOptions): string {
  return path.resolve(options.strongCodeHome ?? strongCodeHomePath(DEFAULT_CONFIG_PATH));
}

/** Prefer a real project config, but never let a stale file in the OS home shadow completed global setup. */
export function resolveConfigPath(configPath?: string, options: ResolveConfigPathOptions = {}): string {
  return resolveConfigSelection(configPath, options, selectedHomeConfigPath(options)).path;
}

function resolveConfigSelection(
  configPath: string | undefined,
  options: ResolveConfigPathOptions,
  homePath: string
): ConfigSelection {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const userHome = path.resolve(options.homeDirectory ?? os.homedir());
  const projectPath = path.resolve(cwd, DEFAULT_CONFIG_PATH);
  if (configPath !== undefined) {
    const explicitPath = path.resolve(configPath);
    return Object.freeze({ kind: "explicit", path: explicitPath, atHomePath: samePath(explicitPath, homePath) });
  }
  if (samePath(cwd, userHome) && pathEntryExists(homePath)) {
    return Object.freeze({ kind: "automatic-home", path: homePath });
  }
  if (pathEntryExists(projectPath)) return Object.freeze({ kind: "automatic-project", path: projectPath });
  if (pathEntryExists(homePath)) return Object.freeze({ kind: "automatic-home", path: homePath });
  return Object.freeze({ kind: "automatic-project", path: projectPath });
}

export interface LoadedConfig {
  path: string;
  directory: string;
  config: StrongCodeConfig;
  runtimeCatalog?: RuntimeCatalog;
}

export interface LoadedConfigWithSource extends LoadedConfig {
  readonly source: ConfigSourceMetadata;
}

function pathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function assertNoSymlinkComponents(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) throw new StrongCodeError("CONFIG_ERROR", `Implicit project dataDir must not contain symlinks or junctions: ${current}`);
    } catch (error) {
      if (error instanceof StrongCodeError) throw error;
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  }
}

async function assertImplicitProjectPathsBeforeCatalog(config: StrongCodeConfig, configDirectory: string): Promise<void> {
  for (const [field, value] of [["workspace", config.workspace], ["dataDir", config.dataDir]] as const) {
    if (path.isAbsolute(value)) {
      throw new StrongCodeError("CONFIG_ERROR", `Implicit project ${field} must be relative and stay inside the project`);
    }
    const resolved = path.resolve(configDirectory, value);
    if (!pathInside(configDirectory, resolved)) {
      throw new StrongCodeError("CONFIG_ERROR", `Implicit project ${field} must stay inside the project`);
    }
    if (field === "dataDir") await assertNoSymlinkComponents(configDirectory, resolved);
  }
}

async function readSelectedConfig(selection: ConfigSelection): Promise<{
  readonly source: ConfigSourceMetadata;
  readonly text: string;
}> {
  switch (selection.kind) {
    case "automatic-home": {
      const receipt = await inspectPath(selection.path, { finalKind: "regular-file", requireSingleLink: true });
      const bytes = await readVerifiedRegularFile(selection.path, {
        maxBytes: BigInt(MAX_IMPLICIT_PROJECT_CONFIG_BYTES),
        requireSingleLink: true
      });
      await revalidatePath(receipt);
      return Object.freeze({
        source: Object.freeze({ kind: "automatic-home", receipt }),
        text: bytes.toString("utf8")
      });
    }
    case "automatic-project": {
      const stats = await lstat(selection.path);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new StrongCodeError("CONFIG_ERROR", `Refusing to load non-regular automatically selected config: ${selection.path}`);
      }
      if (stats.size > MAX_IMPLICIT_PROJECT_CONFIG_BYTES) {
        throw new StrongCodeError("CONFIG_ERROR", `Automatically selected config exceeds ${MAX_IMPLICIT_PROJECT_CONFIG_BYTES} bytes: ${selection.path}`);
      }
      return Object.freeze({ source: Object.freeze({ kind: "automatic-project" }), text: await readFile(selection.path, "utf8") });
    }
    case "explicit":
      return Object.freeze({
        source: Object.freeze({ kind: "explicit", atHomePath: selection.atHomePath }),
        text: await readFile(selection.path, "utf8")
      });
    default:
      return assertNeverSelection(selection);
  }
}

function assertNeverSelection(selection: never): never {
  throw new StrongCodeError("CONFIG_ERROR", `Unknown config selection: ${String(selection)}`);
}

export async function loadConfig(
  configPath?: string,
  options: ResolveConfigPathOptions = {}
): Promise<Result<LoadedConfigWithSource>> {
  const homeConfigPath = selectedHomeConfigPath(options);
  const selection = resolveConfigSelection(configPath, options, homeConfigPath);
  const resolvedPath = selection.path;
  if (!pathEntryExists(resolvedPath)) {
    return err(new StrongCodeError("CONFIG_ERROR", `Config file not found: ${resolvedPath}`));
  }

  try {
    const selected = await readSelectedConfig(selection);
    const parsed = YAML.parse(selected.text);
    const result = strongCodeConfigSchema.safeParse(parsed);

    if (!result.success) {
      return err(new StrongCodeError("CONFIG_ERROR", result.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")));
    }

    if (selected.source.kind === "automatic-project") {
      await assertImplicitProjectPathsBeforeCatalog(result.data, path.dirname(resolvedPath));
    }

    const withCatalog = selected.source.kind === "automatic-home"
      ? await loadJsonModelCatalog(result.data, path.dirname(resolvedPath), { automaticHomeReceipt: selected.source.receipt })
      : await loadJsonModelCatalog(result.data, path.dirname(resolvedPath));
    const merged = strongCodeConfigSchema.safeParse(withCatalog.config);

    if (!merged.success) {
      return err(new StrongCodeError("CONFIG_ERROR", merged.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")));
    }

    const runtimeCatalog = await loadRuntimeCatalog(merged.data, {
      directory: path.dirname(homeConfigPath),
      trustedAdjacentMetadata: true,
      automaticHomeReceipt: selected.source.kind === "automatic-home" ? selected.source.receipt : undefined,
      configSource: parsed
    });

    return ok({
      path: resolvedPath,
      directory: path.dirname(resolvedPath),
      config: merged.data,
      runtimeCatalog,
      source: selected.source
    });
  } catch (error) {
    if (error instanceof Error) return err(toStrongCodeError(error, "CONFIG_ERROR"));
    return err(new StrongCodeError("CONFIG_ERROR", String(error)));
  }
}
