import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { StrongCodeError, toStrongCodeError } from "../core/errors";
import { err, ok, Result } from "../core/result";
import { StrongCodeConfig, strongCodeConfigSchema } from "./schema";
import { loadJsonModelCatalog } from "../models/json-catalog";

export const DEFAULT_CONFIG_PATH = "strongcode.config.yaml";

export interface LoadedConfig {
  path: string;
  directory: string;
  config: StrongCodeConfig;
}

export async function loadConfig(configPath = DEFAULT_CONFIG_PATH): Promise<Result<LoadedConfig>> {
  const resolvedPath = path.resolve(configPath);
  if (!existsSync(resolvedPath)) {
    return err(new StrongCodeError("CONFIG_ERROR", `Config file not found: ${resolvedPath}`));
  }

  try {
    const source = await readFile(resolvedPath, "utf8");
    const parsed = YAML.parse(source);
    const result = strongCodeConfigSchema.safeParse(parsed);

    if (!result.success) {
      return err(new StrongCodeError("CONFIG_ERROR", result.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")));
    }

    const withCatalog = await loadJsonModelCatalog(result.data, path.dirname(resolvedPath));
    const merged = strongCodeConfigSchema.safeParse(withCatalog.config);

    if (!merged.success) {
      return err(new StrongCodeError("CONFIG_ERROR", merged.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")));
    }

    return ok({
      path: resolvedPath,
      directory: path.dirname(resolvedPath),
      config: merged.data
    });
  } catch (error) {
    return err(toStrongCodeError(error, "CONFIG_ERROR"));
  }
}
