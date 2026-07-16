import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  BLENDER_MCP_MANIFEST_PATHS,
  parseArtifactProvenanceJson,
  parseWheelLockJson
} from "./artifact-manifest";
import { StrongCodeError } from "../../core/errors";
import { discoverBlenderSetup } from "./discovery";
import { installBlenderIntegration } from "./install";
import { parseLockedRequirements } from "./python-env";
import type { BlenderProfileCandidate } from "./types";
import { SetupCancelledError, type InstalledBlenderIntegration, type SetupPrompter, type SetupState } from "../types";

export type BlenderSetupDependencies = {
  readonly discover?: typeof discoverBlenderSetup;
  readonly install?: typeof installBlenderIntegration;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly assetRootPath?: string;
};

export type BlenderSetupOptions = {
  readonly homePath: string;
  readonly workspace: string;
  readonly state: SetupState;
  readonly prompter: SetupPrompter;
  readonly mode: "automatic" | "explicit";
  readonly force?: boolean;
};

type BlenderSetupState = SetupState & { readonly blender: InstalledBlenderIntegration };

export type BlenderSetupResult =
  | {
      readonly status: "installed" | "already-installed";
      readonly state: BlenderSetupState;
      readonly originalBlender: InstalledBlenderIntegration | undefined;
    }
  | {
      readonly status: "not-found" | "prerequisite-missing" | "declined" | "cancelled";
      readonly state: SetupState;
    };

export async function setupBlenderIntegration(
  options: BlenderSetupOptions,
  dependencies: BlenderSetupDependencies = {}
): Promise<BlenderSetupResult> {
  const originalBlender = options.state.blender;
  if (options.mode === "automatic" && originalBlender && !options.force) {
    return {
      status: "already-installed",
      originalBlender,
      state: { ...options.state, blender: originalBlender }
    };
  }
  const platform = dependencies.platform ?? process.platform;
  const architecture = dependencies.architecture ?? process.arch;
  const environment = dependencies.env ?? process.env;
  const discovery = await (dependencies.discover ?? discoverBlenderSetup)({
    workspace: options.workspace,
    env: discoveryEnvironment(normalizeDiscoveryEnvironmentForPlatform(environment, platform)),
    platform
  });
  if (discovery.profiles.length === 0) return { status: "not-found", state: options.state };

  const profiles = discovery.profiles.filter(profile => blenderVersionSupported(profile.version));
  if (profiles.length === 0) {
    options.prompter.note("Blender was found, but StrongCode requires Blender 4.2 or newer. Upgrade Blender, then run strongcode setup --blender.");
    return { status: "prerequisite-missing", state: options.state };
  }
  if (platform !== "win32" || architecture !== "x64" || !exactPythonPrerequisite(discovery.python)) {
    options.prompter.note("Blender was found, but installation requires CPython 3.11 win_amd64 on Windows x64. Install 64-bit CPython 3.11, ensure python3.11 or python is on PATH, then run strongcode setup --blender.");
    return { status: "prerequisite-missing", state: options.state };
  }

  try {
    const selectedProfileId = profiles.length === 1
      ? profiles[0]?.profileId
      : await options.prompter.select(
        "Blender profile",
        profiles.map(candidate => ({
          value: candidate.profileId,
          label: `Blender ${candidate.version}`,
          hint: `${candidate.executable.canonicalPath} · ${candidate.profileId}`
        }))
      );
    const profile = profiles.find(candidate => candidate.profileId === selectedProfileId);
    if (!profile) throw new SetupCancelledError();

    const assetRoot = path.resolve(dependencies.assetRootPath ?? path.join(__dirname, "..", "..", "..", "assets", "blender-mcp"));
    const [provenanceSource, lockSource, requirementsSource] = await Promise.all([
      readFile(path.join(assetRoot, BLENDER_MCP_MANIFEST_PATHS.provenance), "utf8"),
      readFile(path.join(assetRoot, BLENDER_MCP_MANIFEST_PATHS.wheels), "utf8"),
      readFile(path.join(assetRoot, BLENDER_MCP_MANIFEST_PATHS.requirements), "utf8")
    ]);
    const provenance = parseArtifactProvenanceJson(provenanceSource);
    const lock = parseWheelLockJson(lockSource);
    const requirements = parseLockedRequirements(lock, requirementsSource);
    const receiptPath = path.resolve(options.homePath, "mcps", "blender", "installation.json");
    const verifiesOwnedInstall = options.mode === "explicit" && !options.force
      && (options.state.blender !== undefined || existsSync(receiptPath));
    if (!verifiesOwnedInstall) {
      options.prompter.note(consentDetails(profile, provenance.artifacts[0].sha256, provenance.artifacts[1].sha256));
      if (!await options.prompter.confirm("Install the StrongCode Blender integration with these exact settings?", false)) {
        return { status: "declined", state: options.state };
      }
    }

    const installed = await (dependencies.install ?? installBlenderIntegration)({
      homePath: options.homePath,
      profile,
      python: discovery.python,
      platform,
      architecture,
      lock,
      provenance,
      requirements,
      wrapperAssetsPath: path.join(assetRoot, "runtime-wrapper"),
      addonAssetsPath: path.join(assetRoot, "addon", "strongcode_blender_mcp"),
      repair: options.force ?? false,
      verifyOnly: verifiesOwnedInstall,
      env: environment
    });
    const verifiedIdentity = {
      profileId: installed.profileId,
      version: profile.version,
      executablePath: profile.executable.canonicalPath,
      receiptPath: installed.receiptPath
    };
    const blender = {
      ...verifiedIdentity,
      installedAt: installed.status === "already-installed"
        && originalBlender !== undefined
        && originalBlender.profileId === verifiedIdentity.profileId
        && originalBlender.version === verifiedIdentity.version
        && originalBlender.executablePath === verifiedIdentity.executablePath
        && originalBlender.receiptPath === verifiedIdentity.receiptPath
        ? originalBlender.installedAt
        : (dependencies.now?.() ?? new Date()).toISOString()
    };
    return {
      status: installed.status,
      originalBlender,
      state: {
        ...options.state,
        blender
      }
    };
  } catch (error) {
    if (error instanceof SetupCancelledError) return { status: "cancelled", state: options.state };
    throw error;
  }
}

function blenderVersionSupported(version: string): boolean {
  const parsed = /^(\d+)\.(\d+)(?:\.|$)/u.exec(version);
  return parsed !== null && (Number(parsed[1]) > 4 || (Number(parsed[1]) === 4 && Number(parsed[2]) >= 2));
}

function exactPythonPrerequisite(python: Awaited<ReturnType<typeof discoverBlenderSetup>>["python"]): python is NonNullable<typeof python> {
  return python?.implementation === "cpython"
    && python.version.major === 3
    && python.version.minor === 11
    && python.pointerWidth === 64
    && python.sysconfigPlatform === "win_amd64";
}

const DISCOVERY_ENVIRONMENT = [
  "APPDATA",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "ProgramFiles",
  "ProgramW6432",
  "PROGRAMDATA",
  "SystemRoot",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "WINDIR"
] as const;

function conflictAliasError(canonicalName: string, first: string, second: string): never {
  throw new StrongCodeError(
    "CONFIG_ERROR",
    `Conflicting environment aliases for ${canonicalName}: ${first} and ${second}`
  );
}

function normalizeDiscoveryEnvironmentForPlatform(source: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  if (platform !== "win32") {
    return source;
  }

  const discovered = new Map<string, string>();
  const canonicalByKey = new Map<string, string>();

  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;

    const canonicalName = DISCOVERY_ENVIRONMENT.find(candidate => candidate.toUpperCase() === name.toUpperCase());
    if (canonicalName === undefined) continue;

    const firstAlias = canonicalByKey.get(canonicalName);
    if (firstAlias === undefined) {
      discovered.set(canonicalName, value);
      canonicalByKey.set(canonicalName, name);
      continue;
    }

    const firstValue = discovered.get(canonicalName);
    if (firstValue !== value) conflictAliasError(canonicalName, firstAlias, name);
  }

  return Object.fromEntries(discovered.entries());
}

function discoveryEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    DISCOVERY_ENVIRONMENT.flatMap(name => source[name] === undefined ? [] : [[name, source[name]]])
  );
}

function consentDetails(profile: BlenderProfileCandidate, wheelSha256: string, addonSha256: string): string {
  return [
    `Blender: ${profile.executable.canonicalPath} · version ${profile.version} · profile ${profile.profileId}.`,
    `Pinned blender-mcp 1.6.4 · wheel SHA-256 ${wheelSha256} · addon SHA-256 ${addonSha256}.`,
    "Installs a private StrongCode runtime and persists the addon plus Blender preferences so it auto-enables on future GUI launches.",
    `Persisted Blender targets: addon under ${profile.paths.resources.user}; preferences and private settings under ${profile.paths.config}.`,
    "A GUI launch starts an authenticated ephemeral loopback listener. The Blender MCP is read/write; execute_blender_code remains ask and is denied noninteractively.",
    "Telemetry and remote providers are off. StrongCode does not install Python or uv, create OS autostart, or modify project configuration.",
    "Installation is transactional and includes rollback of managed files and configuration if commit fails."
  ].join("\n");
}
