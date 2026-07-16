import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { StrongCodeError } from "../../core/errors";
import { resolveDelegatedExecutable } from "../../models/delegated-executable";
import type { ExecutableSource, TrustedExecutableCandidate } from "./types";

const BLENDER_COMMANDS = ["blender"] as const;
const PYTHON_COMMANDS = ["python", "python3", "python3.11.exe", "python3.11"] as const;
const SHELL_SHIM_EXTENSION = /\.(?:bat|cmd|com|ps1|sh|bash|zsh|fish|js|vbs)$/iu;
const BLENDER_EXECUTABLE = /^blender(?:\.exe)?$/iu;
const PYTHON_EXECUTABLE = /^(?:python(?:3(?:\.\d+)?)?|pythonw)(?:\.exe)?$/iu;
const MAX_EXECUTABLE_BYTES = 1024 * 1024 * 1024;

type CandidateKind = "blender" | "python";

function isInside(root: string, target: string, platform: NodeJS.Platform): boolean {
  const pathApi = platform === "win32" ? path.win32 : path;
  const normalizedRoot = platform === "win32" ? root.toLowerCase() : root;
  const normalizedTarget = platform === "win32" ? target.toLowerCase() : target;
  const relative = pathApi.relative(normalizedRoot, normalizedTarget);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative));
}

function acceptedName(candidate: string, kind: CandidateKind): boolean {
  if (SHELL_SHIM_EXTENSION.test(candidate)) return false;
  const name = path.basename(candidate);
  return kind === "blender" ? BLENDER_EXECUTABLE.test(name) : PYTHON_EXECUTABLE.test(name);
}

function identity(value: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? value.toLowerCase() : value;
}

async function resolvePathCommand(
  command: string,
  kind: CandidateKind,
  options: {
    readonly workspace: string;
    readonly env: NodeJS.ProcessEnv;
  }
): Promise<TrustedExecutableCandidate | undefined> {
  try {
    const resolved = await resolveDelegatedExecutable(command, { cwd: options.workspace, env: options.env });
    if (resolved.windowsCommandShim || !acceptedName(resolved.executable, kind)) return undefined;
    return { canonicalPath: resolved.executable, env: resolved.env, sources: ["path"] };
  } catch (error) {
    if (error instanceof StrongCodeError && error.code === "CONFIG_ERROR") return undefined;
    throw error;
  }
}

export async function trustExecutablePath(
  options: {
    readonly candidate: string;
    readonly kind: CandidateKind;
    readonly workspace: string;
    readonly env: NodeJS.ProcessEnv;
    readonly platform: NodeJS.Platform;
  }
): Promise<TrustedExecutableCandidate | undefined> {
  if (options.candidate.length === 0 || options.candidate.length > 4096 || options.candidate.includes("\0") || !path.isAbsolute(options.candidate)) return undefined;
  if (!acceptedName(options.candidate, options.kind)) return undefined;
  try {
    const [canonical, canonicalWorkspace] = await Promise.all([realpath(options.candidate), realpath(options.workspace)]);
    if (isInside(canonicalWorkspace, canonical, options.platform)) return undefined;
    const resolved = await resolveDelegatedExecutable(path.basename(canonical), {
      command: canonical,
      cwd: canonicalWorkspace,
      env: options.env
    });
    if (resolved.windowsCommandShim || !acceptedName(resolved.executable, options.kind)) return undefined;
    return { canonicalPath: resolved.executable, env: resolved.env, sources: ["association"] };
  } catch (error) {
    if (error instanceof StrongCodeError && error.code === "CONFIG_ERROR") return undefined;
    if (error instanceof Error && "code" in error) return undefined;
    throw error;
  }
}

async function mergeCandidates(
  candidates: readonly TrustedExecutableCandidate[],
  platform: NodeJS.Platform,
  maximum: number
): Promise<readonly TrustedExecutableCandidate[]> {
  const merged = new Map<string, TrustedExecutableCandidate>();
  for (const candidate of candidates.slice(0, maximum)) {
    const key = identity(candidate.canonicalPath, platform);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, candidate);
      continue;
    }
    const sources = [...new Set<ExecutableSource>([...existing.sources, ...candidate.sources])];
    merged.set(key, { ...existing, sources });
  }
  return [...merged.values()];
}

export async function discoverBlenderExecutables(options: {
  readonly workspace: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly associationPaths: readonly string[];
  readonly maxCandidates: number;
}): Promise<readonly TrustedExecutableCandidate[]> {
  const pathCandidates = await Promise.all(BLENDER_COMMANDS.map(command =>
    resolvePathCommand(command, "blender", options)
  ));
  const associations = await Promise.all(options.associationPaths.slice(0, options.maxCandidates).map(candidate =>
    trustExecutablePath({ ...options, candidate, kind: "blender" })
  ));
  return mergeCandidates(
    [...pathCandidates, ...associations].filter((value): value is TrustedExecutableCandidate => value !== undefined),
    options.platform,
    options.maxCandidates
  );
}

export async function discoverPythonExecutables(options: {
  readonly workspace: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly maxCandidates: number;
}): Promise<readonly TrustedExecutableCandidate[]> {
  const candidates = await Promise.all(PYTHON_COMMANDS.map(command =>
    resolvePathCommand(command, "python", options)
  ));
  return mergeCandidates(
    candidates.filter((value): value is TrustedExecutableCandidate => value !== undefined),
    options.platform,
    options.maxCandidates
  );
}

export async function hashExecutable(executable: string): Promise<string | undefined> {
  try {
    const metadata = await stat(executable);
    if (!metadata.isFile() || metadata.size > MAX_EXECUTABLE_BYTES) return undefined;
    await access(executable, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    const digest = createHash("sha256");
    await new Promise<void>((resolve, reject) => {
      const source = createReadStream(executable);
      source.on("data", chunk => digest.update(chunk));
      source.once("error", reject);
      source.once("end", resolve);
    });
    return digest.digest("hex");
  } catch (error) {
    if (error instanceof Error && "code" in error) return undefined;
    throw error;
  }
}
