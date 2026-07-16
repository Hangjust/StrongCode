import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  discoverBlenderExecutables,
  discoverPythonExecutables
} from "./executables";
import {
  BLENDER_PROBE_SENTINEL,
  CPYTHON_PROBE_SENTINEL,
  nodeProbeProcessAdapter,
  probeBlender,
  probeCpython
} from "./probe";
import { createPlatformAssociationAdapter } from "./discovery/platform";
import type {
  BlenderDiscoveryOptions,
  BlenderProfileCandidate,
  BlenderProfileSelection,
  BlenderSetupDiscovery,
  CpythonCandidate,
  PlatformAssociationAdapter
} from "./types";

export { BLENDER_PROBE_SENTINEL, CPYTHON_PROBE_SENTINEL };
export type {
  BlenderDiscoveryOptions,
  BlenderProfileCandidate,
  BlenderProfileSelection,
  BlenderSetupDiscovery,
  CpythonCandidate
} from "./types";

const DEFAULT_MAX_WORKSPACE_ENTRIES = 2_048;
const DEFAULT_MAX_WORKSPACE_DEPTH = 6;
const DEFAULT_MAX_CANDIDATES = 16;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;

export const noPlatformAssociations: PlatformAssociationAdapter = {
  async blenderExecutables(): Promise<readonly string[]> {
    return [];
  }
};

function isInside(root: string, target: string, platform: NodeJS.Platform): boolean {
  const pathApi = platform === "win32" ? path.win32 : path;
  const normalizedRoot = platform === "win32" ? root.toLowerCase() : root;
  const normalizedTarget = platform === "win32" ? target.toLowerCase() : target;
  const relative = pathApi.relative(normalizedRoot, normalizedTarget);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative));
}

export async function findWorkspaceBlendFile(options: {
  readonly workspace: string;
  readonly platform: NodeJS.Platform;
  readonly maxEntries: number;
  readonly maxDepth: number;
}): Promise<string | undefined> {
  if (options.maxEntries < 1 || options.maxDepth < 0) return undefined;
  const workspace = await realpath(options.workspace);
  if (!(await stat(workspace)).isDirectory()) return undefined;
  const pending: Array<{ readonly directory: string; readonly depth: number }> = [{ directory: workspace, depth: 0 }];
  let visited = 0;
  while (pending.length > 0 && visited < options.maxEntries) {
    const current = pending.shift();
    if (!current) break;
    const entries = (await readdir(current.directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      visited += 1;
      if (visited > options.maxEntries) return undefined;
      if (entry.isSymbolicLink()) continue;
      const candidate = path.join(current.directory, entry.name);
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".blend")) {
        const canonical = await realpath(candidate);
        if (isInside(workspace, canonical, options.platform)) return canonical;
      }
      if (entry.isDirectory() && current.depth < options.maxDepth) {
        const canonical = await realpath(candidate);
        if (isInside(workspace, canonical, options.platform)) {
          pending.push({ directory: canonical, depth: current.depth + 1 });
        }
      }
    }
  }
  return undefined;
}

export function selectBlenderProfile(
  profiles: readonly BlenderProfileCandidate[],
  selectedProfileId?: string
): BlenderProfileSelection {
  if (profiles.length === 0) return { kind: "none" };
  const selected = selectedProfileId
    ? profiles.find(profile => profile.profileId === selectedProfileId)
    : profiles.length === 1 ? profiles[0] : undefined;
  if (selected) return { kind: "selected", profileId: selected.profileId, profile: selected };
  return { kind: "required", profileIds: profiles.map(profile => profile.profileId) };
}

async function discoverCompatibleCpython(options: {
  readonly workspace: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly process: NonNullable<BlenderDiscoveryOptions["process"]>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxCandidates: number;
}): Promise<CpythonCandidate | undefined> {
  const candidates = await discoverPythonExecutables(options);
  for (const candidate of candidates) {
    const probed = await probeCpython(candidate, options);
    if (probed) return probed;
  }
  return undefined;
}

export async function discoverBlenderSetup(options: BlenderDiscoveryOptions): Promise<BlenderSetupDiscovery> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const processAdapter = options.process ?? nodeProbeProcessAdapter;
  const maxCandidates = options.limits?.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const maxOutputBytes = options.limits?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const timeoutMs = options.limits?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const workspaceBlendFile = await findWorkspaceBlendFile({
    workspace: options.workspace,
    platform,
    maxEntries: options.limits?.maxWorkspaceEntries ?? DEFAULT_MAX_WORKSPACE_ENTRIES,
    maxDepth: options.limits?.maxWorkspaceDepth ?? DEFAULT_MAX_WORKSPACE_DEPTH
  });
  const associations = options.associations ?? createPlatformAssociationAdapter({
    platform,
    runner: options.associationCommands ?? nodeProbeProcessAdapter,
    cwd: options.workspace,
    env,
    timeoutMs,
    maxOutputBytes,
    maxCandidates
  });
  const associationPaths = await associations
    .blenderExecutables(workspaceBlendFile);
  const executableCandidates = await discoverBlenderExecutables({
    workspace: options.workspace,
    env,
    platform,
    associationPaths,
    maxCandidates
  });
  const profiles = (await Promise.all(executableCandidates.map(candidate => probeBlender(candidate, {
    workspace: options.workspace,
    process: processAdapter,
    timeoutMs,
    maxOutputBytes
  })))).filter((candidate): candidate is BlenderProfileCandidate => candidate !== undefined);
  const python = await discoverCompatibleCpython({
    workspace: options.workspace,
    env,
    platform,
    process: processAdapter,
    timeoutMs,
    maxOutputBytes,
    maxCandidates
  });
  return {
    ...(workspaceBlendFile ? { workspaceBlendFile } : {}),
    profiles,
    selection: selectBlenderProfile(profiles, options.selectedProfileId),
    ...(python ? { python } : {})
  };
}
