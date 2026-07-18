import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  BLENDER_MCP_MANIFEST_PATHS,
  parseArtifactProvenanceJson,
  parseWheelLockJson
} from "./artifact-manifest";
import { StrongCodeError } from "../../core/errors";
import { blenderIntegrationConsentDetails } from "./consent";
import { discoveryEnvironment } from "./discovery-environment";
import { discoverBlenderSetup } from "./discovery";
import { installBlenderIntegration } from "./install";
import { parseLockedRequirements } from "./python-env";
import { OFFICIAL_BLENDER_MCP_PATHS } from "./official-artifact-manifest";
import {
  parseOfficialArtifactCatalogJson,
  parseOfficialRequirements,
  parseOfficialWheelLockJson
} from "./official-artifact-parser";
import { selectBlenderIntegration } from "./selection";
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
    env: discoveryEnvironment(environment, platform),
    platform
  });
  if (discovery.profiles.length === 0) return { status: "not-found", state: options.state };

  const selections = discovery.profiles.flatMap(profile => {
    const result = selectBlenderIntegration(profile);
    switch (result.kind) {
      case "selected":
        return [result.selection];
      case "malformed":
      case "unsupported":
        return [];
      default:
        return unsupportedSelectionResult(result);
    }
  });
  if (selections.length === 0) {
    options.prompter.note("Blender was found, but StrongCode requires a stable Blender version 4.2.0 or newer. Upgrade Blender, then run strongcode setup --blender.");
    return { status: "prerequisite-missing", state: options.state };
  }
  if (platform !== "win32" || architecture !== "x64" || !exactPythonPrerequisite(discovery.python)) {
    options.prompter.note("Blender was found, but installation requires CPython 3.11 win_amd64 on Windows x64. Install 64-bit CPython 3.11, ensure python3.11 or python is on PATH, then run strongcode setup --blender.");
    return { status: "prerequisite-missing", state: options.state };
  }

  try {
    const selectedProfileId = selections.length === 1
      ? selections[0]?.profile.profileId
      : await options.prompter.select(
        "Blender profile",
        selections.map(candidate => ({
          value: candidate.profile.profileId,
          label: `Blender ${candidate.profile.version}`,
          hint: `${candidate.profile.executable.canonicalPath} · ${candidate.profile.profileId}`
        }))
      );
    const selection = selections.find(candidate => candidate.profile.profileId === selectedProfileId);
    if (!selection) throw new SetupCancelledError();
    const profile = selection.profile;

    const receiptPath = path.resolve(options.homePath, "mcps", "blender", "installation.json");
    const verifiesOwnedInstall = !options.force
      && (options.state.blender !== undefined || existsSync(receiptPath));
    const installer = dependencies.install ?? installBlenderIntegration;
    const commonInstallOptions = {
      homePath: options.homePath,
      python: discovery.python,
      platform,
      architecture,
      repair: options.force ?? false,
      verifyOnly: verifiesOwnedInstall,
      env: environment
    };
    let installed: Awaited<ReturnType<typeof installBlenderIntegration>>;
    switch (selection.flavor) {
      case "official": {
        const assetRoot = path.resolve(dependencies.assetRootPath ?? path.join(__dirname, "..", "..", "..", "assets", "blender-mcp"));
        const [catalogSource, lockSource, requirements] = await Promise.all([
          readFile(path.join(assetRoot, OFFICIAL_BLENDER_MCP_PATHS.catalog), "utf8"),
          readFile(path.join(assetRoot, OFFICIAL_BLENDER_MCP_PATHS.wheels), "utf8"),
          readFile(path.join(assetRoot, OFFICIAL_BLENDER_MCP_PATHS.requirements), "utf8")
        ]);
        const catalog = parseOfficialArtifactCatalogJson(catalogSource);
        const lock = parseOfficialWheelLockJson(lockSource);
        parseOfficialRequirements(lock, requirements);
        if (!verifiesOwnedInstall) {
          options.prompter.note(blenderIntegrationConsentDetails(
            selection,
            catalog.release.assets[0].sha256,
            catalog.release.assets[1].sha256
          ));
          if (!await options.prompter.confirm("Install the StrongCode Blender integration with these exact settings?", false)) {
            return { status: "declined", state: options.state };
          }
        }
        installed = await installer({ ...commonInstallOptions, selection, catalog, lock, requirements,
          derivativeAssetsPath: path.join(assetRoot, "official-derivative") });
        break;
      }
      case "legacy": {
        const assetRoot = path.resolve(dependencies.assetRootPath ?? path.join(__dirname, "..", "..", "..", "assets", "blender-mcp"));
        const [provenanceSource, lockSource, requirementsSource] = await Promise.all([
          readFile(path.join(assetRoot, BLENDER_MCP_MANIFEST_PATHS.provenance), "utf8"),
          readFile(path.join(assetRoot, BLENDER_MCP_MANIFEST_PATHS.wheels), "utf8"),
          readFile(path.join(assetRoot, BLENDER_MCP_MANIFEST_PATHS.requirements), "utf8")
        ]);
        const provenance = parseArtifactProvenanceJson(provenanceSource);
        const lock = parseWheelLockJson(lockSource);
        const requirements = parseLockedRequirements(lock, requirementsSource);
        if (!verifiesOwnedInstall) {
          options.prompter.note(blenderIntegrationConsentDetails(selection, provenance.artifacts[0].sha256, provenance.artifacts[1].sha256));
          if (!await options.prompter.confirm("Install the StrongCode Blender integration with these exact settings?", false)) {
            return { status: "declined", state: options.state };
          }
        }
        installed = await installer({
          ...commonInstallOptions,
          selection,
          lock,
          provenance,
          requirements,
          wrapperAssetsPath: path.join(assetRoot, "runtime-wrapper"),
          addonAssetsPath: path.join(assetRoot, "addon", "strongcode_blender_mcp")
        });
        break;
      }
      default:
        return unsupportedSelectionResult(selection);
    }
    const verifiedIdentity = {
      flavor: selection.flavor,
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
        && originalBlender.flavor === verifiedIdentity.flavor
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

function unsupportedSelectionResult(result: never): never {
  throw new StrongCodeError("CONFIG_ERROR", `Unsupported Blender selection result: ${JSON.stringify(result)}`);
}

function exactPythonPrerequisite(python: Awaited<ReturnType<typeof discoverBlenderSetup>>["python"]): python is NonNullable<typeof python> {
  return python?.implementation === "cpython"
    && python.version.major === 3
    && python.version.minor === 11
    && python.pointerWidth === 64
    && python.sysconfigPlatform === "win_amd64";
}
