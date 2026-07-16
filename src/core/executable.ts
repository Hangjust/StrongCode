import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { StrongCodeError } from "./errors";

export type TrustedExecutableOptions = {
  readonly command?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly excludedRoots?: readonly string[];
  readonly allowedExecutableRoots?: readonly string[];
};

export type TrustedExecutableResolution = {
  readonly executable: string;
  readonly env: NodeJS.ProcessEnv;
  readonly pathEntries: readonly string[];
  readonly excludedRoots: readonly string[];
  readonly allowedRoots: readonly string[];
};

const NATIVE_WINDOWS_EXTENSIONS = [".COM", ".EXE"] as const;
const DELEGATED_WINDOWS_EXTENSIONS = [".COM", ".EXE", ".BAT", ".CMD"] as const;
const WINDOWS_DEVICE_SEGMENT = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;

export function environmentValue(environment: NodeJS.ProcessEnv, key: string): string | undefined {
  if (process.platform !== "win32") return environment[key];
  const match = Object.keys(environment).find(candidate => candidate.toUpperCase() === key.toUpperCase());
  return match ? environment[match] : undefined;
}

export function setEnvironmentValue(environment: NodeJS.ProcessEnv, key: string, value: string): void {
  if (process.platform === "win32") {
    for (const existing of Object.keys(environment)) {
      if (existing.toUpperCase() === key.toUpperCase()) delete environment[existing];
    }
  }
  environment[key] = value;
}

export function isSafeAbsoluteWindowsPath(value: string): boolean {
  if (!path.win32.isAbsolute(value) || /[\u0000-\u001F\u007F]/u.test(value)) return false;
  const normalized = value.replaceAll("/", "\\");
  if (/^(?:\\\\[.?]\\|\\\?\?\\)/u.test(normalized)) return false;
  const root = path.win32.parse(normalized).root;
  if (!root || (root === "\\" && !normalized.startsWith("\\\\"))) return false;
  const remainder = normalized.slice(root.length);
  if (remainder.includes(":")) return false;
  return remainder.split("\\").every(segment =>
    segment !== "."
    && segment !== ".."
    && !segment.endsWith(".")
    && !segment.endsWith(" ")
    && !WINDOWS_DEVICE_SEGMENT.test(segment)
  );
}

export function resolveNativeExecutable(
  commandName: string,
  options: TrustedExecutableOptions = {}
): Promise<TrustedExecutableResolution> {
  return resolveTrustedExecutable(commandName, options, NATIVE_WINDOWS_EXTENSIONS);
}

export function resolveDelegatedExecutableTarget(
  commandName: string,
  options: TrustedExecutableOptions = {}
): Promise<TrustedExecutableResolution> {
  return resolveTrustedExecutable(commandName, options, DELEGATED_WINDOWS_EXTENSIONS);
}

export async function trustedExecutableCandidate(
  candidate: string,
  excludedRoots: readonly string[],
  allowedRoots: readonly string[] = []
): Promise<string | undefined> {
  try {
    const canonical = await realpath(candidate);
    if (isExcluded(canonical, excludedRoots, allowedRoots)) return undefined;
    if (!(await stat(canonical)).isFile()) return undefined;
    await access(canonical, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return canonical;
  } catch (error) {
    if (error instanceof Error && "code" in error) return undefined;
    throw error;
  }
}

async function resolveTrustedExecutable(
  commandName: string,
  options: TrustedExecutableOptions,
  windowsExtensions: readonly string[]
): Promise<TrustedExecutableResolution> {
  if (!commandName || path.basename(commandName) !== commandName) {
    throw new StrongCodeError("CONFIG_ERROR", "Executable name must be a bare command name");
  }
  const environment = options.env ?? process.env;
  const excludedRoots = await canonicalRoots(options.excludedRoots ?? [process.cwd(), options.cwd ?? process.cwd()]);
  const allowedRoots = await canonicalRoots(options.allowedExecutableRoots ?? []);
  const pathEntries = await trustedPathEntries(environmentValue(environment, "PATH") ?? "", excludedRoots, allowedRoots);
  const sanitizedEnvironment = withSanitizedPath(environment, pathEntries);

  if (options.command !== undefined) {
    if (!path.isAbsolute(options.command)) {
      throw new StrongCodeError("CONFIG_ERROR", `Explicit ${commandName} command must be an absolute path`);
    }
    const executable = await explicitExecutable(commandName, options.command, windowsExtensions);
    return { executable, env: sanitizedEnvironment, pathEntries, excludedRoots, allowedRoots };
  }

  for (const entry of pathEntries) {
    for (const name of executableNames(commandName, environment, windowsExtensions)) {
      const executable = await trustedExecutableCandidate(path.join(entry, name), excludedRoots, allowedRoots);
      if (executable) return { executable, env: sanitizedEnvironment, pathEntries, excludedRoots, allowedRoots };
    }
  }
  throw new StrongCodeError(
    "CONFIG_ERROR",
    `Could not resolve ${commandName} from an absolute PATH entry outside the current workspace`
  );
}

async function canonicalRoots(values: readonly string[]): Promise<readonly string[]> {
  return Promise.all([...new Set(values.map(value => path.resolve(value)))].map(async value => {
    try {
      return await realpath(value);
    } catch (error) {
      if (error instanceof Error && "code" in error) return value;
      throw error;
    }
  }));
}

async function trustedPathEntries(
  pathValue: string,
  excludedRoots: readonly string[],
  allowedRoots: readonly string[]
): Promise<readonly string[]> {
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const rawEntry of pathValue.split(path.delimiter)) {
    const trimmed = rawEntry.trim();
    const entry = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
      ? trimmed.slice(1, -1)
      : trimmed;
    if (!entry || !path.isAbsolute(entry) || isExcluded(path.resolve(entry), excludedRoots, allowedRoots)) continue;
    try {
      const canonical = await realpath(entry);
      if (!(await stat(canonical)).isDirectory() || isExcluded(canonical, excludedRoots, allowedRoots)) continue;
      const identity = process.platform === "win32" ? canonical.toLowerCase() : canonical;
      if (seen.has(identity)) continue;
      seen.add(identity);
      entries.push(canonical);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error)) throw error;
    }
  }
  return entries;
}

function withSanitizedPath(environment: NodeJS.ProcessEnv, entries: readonly string[]): NodeJS.ProcessEnv {
  const sanitized = { ...environment };
  for (const key of Object.keys(sanitized)) {
    const normalized = key.toUpperCase();
    if (normalized === "PATH" || normalized === "NODEFAULTCURRENTDIRECTORYINEXEPATH") delete sanitized[key];
  }
  sanitized.PATH = entries.join(path.delimiter);
  if (process.platform === "win32") sanitized.NoDefaultCurrentDirectoryInExePath = "1";
  return sanitized;
}

function executableNames(
  commandName: string,
  environment: NodeJS.ProcessEnv,
  windowsExtensions: readonly string[]
): readonly string[] {
  if (process.platform !== "win32") return [commandName];
  const extension = path.extname(commandName);
  if (extension) return windowsExtensions.some(candidate => candidate.toLowerCase() === extension.toLowerCase()) ? [commandName] : [];
  const configured = (environmentValue(environment, "PATHEXT") ?? windowsExtensions.join(";"))
    .split(";")
    .map(candidate => candidate.trim())
    .filter(candidate => windowsExtensions.some(allowed => allowed.toLowerCase() === candidate.toLowerCase()));
  return [...new Set(configured.map(candidate => `${commandName}${candidate}`))];
}

async function explicitExecutable(
  commandName: string,
  command: string,
  windowsExtensions: readonly string[]
): Promise<string> {
  try {
    if (process.platform === "win32" && !windowsExtensions.some(extension => extension.toLowerCase() === path.extname(command).toLowerCase())) {
      throw new StrongCodeError("CONFIG_ERROR", "Executable type is not allowed");
    }
    const canonical = await realpath(command);
    if (!(await stat(canonical)).isFile()) throw new StrongCodeError("CONFIG_ERROR", "Executable is not a file");
    await access(canonical, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return canonical;
  } catch (error) {
    if (error instanceof StrongCodeError && error.message === "Executable type is not allowed") {
      throw new StrongCodeError("CONFIG_ERROR", `Explicit ${commandName} command is not a native executable file: ${command}`);
    }
    if (error instanceof Error && ("code" in error || error instanceof StrongCodeError)) {
      throw new StrongCodeError("CONFIG_ERROR", `Explicit ${commandName} command is not an executable file: ${command}`);
    }
    throw error;
  }
}

function isExcluded(target: string, excludedRoots: readonly string[], allowedRoots: readonly string[]): boolean {
  return excludedRoots.some(root => isInside(root, target)) && !allowedRoots.some(root => isInside(root, target));
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
