import os from "node:os";
import path from "node:path";

export const STRONGCODE_HOME_ENV = "STRONGCODE_HOME";

export interface ResolveStrongCodeHomeOptions {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  cwd?: string;
}

function expandHome(value: string, homeDirectory: string): string {
  if (value === "~") return homeDirectory;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(homeDirectory, value.slice(2));
  }
  return value;
}

/**
 * Resolve the one user-owned StrongCode home.
 *
 * Precedence is deliberately small and predictable:
 * STRONGCODE_HOME, XDG_CONFIG_HOME/strongcode, ~/.config/strongcode.
 */
export function resolveStrongCodeHome(options: ResolveStrongCodeHomeOptions = {}): string {
  const env = options.env ?? process.env;
  const homeDirectory = path.resolve(options.homeDirectory ?? os.homedir());
  const cwd = options.cwd ?? process.cwd();
  const explicitHome = env[STRONGCODE_HOME_ENV]?.trim();

  if (explicitHome) {
    return path.resolve(cwd, expandHome(explicitHome, homeDirectory));
  }

  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  const configRoot = xdgConfigHome
    ? path.resolve(cwd, expandHome(xdgConfigHome, homeDirectory))
    : path.join(homeDirectory, ".config");

  return path.join(configRoot, "strongcode");
}

export function strongCodeHomePath(...parts: string[]): string {
  return path.join(resolveStrongCodeHome(), ...parts);
}
