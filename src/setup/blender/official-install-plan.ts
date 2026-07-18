import path from "node:path";
import type { GlobalBlenderConfigMergePlan } from "./config-merge";
import { BlenderInstallError, sha256, statesEqual } from "./durable-fs";
import type { BlenderInstallerFileSystem } from "./install-files";
import type { OfficialInstallBlenderIntegrationOptions } from "./install";
import { createInstallationReceiptV3, type BlenderInstallationReceiptPredecessor } from "./installation-receipt";
import type { BlenderInstallTargetPlan, PathState } from "./journal";
import { OFFICIAL_ADDON_MODULE, enableOfficialBlenderExtension, stageOfficialBlenderAddon } from "./official-addon";
import { OFFICIAL_BLENDER_LAUNCHER_SOURCE, stageOfficialBlenderRuntime } from "./official-runtime";
import { nodeProbeProcessAdapter } from "./probe";
import { createOfficialPrivateConfig, serializeOfficialPrivateConfig } from "./official-private-config";
import { writePrivateFile } from "./private-files";

const RUNTIME_ID = "official-1.0.0-cp311-win_amd64";

export type OfficialManagedBlenderPaths = {
  readonly runtime: string;
  readonly python: string;
  readonly launcher: string;
  readonly receipt: string;
  readonly privateConfig: string;
  readonly addon: string;
  readonly preferences: string;
};

export type OfficialManagedBlenderPreStates = {
  readonly runtime: PathState;
  readonly receipt: PathState;
  readonly privateConfig: PathState;
  readonly addon: PathState;
  readonly preferences: PathState;
  readonly permissions: PathState;
  readonly mcp: PathState;
};

export type StagedOfficialBlenderIntegration = {
  readonly runtime: string;
  readonly addon: string;
  readonly preferences: string;
  readonly privateConfig: string;
  readonly privateConfigPath: string;
};

export function officialManagedBlenderPaths(options: OfficialInstallBlenderIntegrationOptions): OfficialManagedBlenderPaths {
  const runtime = path.resolve(options.homePath, "mcps", "blender", "runtimes", RUNTIME_ID);
  const extensions = requireOfficialExtensionsPath(options.selection.profile.paths.extensions);
  return {
    runtime,
    python: path.join(runtime, "venv", "Scripts", "python.exe"),
    launcher: path.join(runtime, "blender-mcp.py"),
    receipt: path.resolve(options.homePath, "mcps", "blender", "installation.json"),
    privateConfig: path.resolve(options.selection.profile.paths.config, "strongcode_blender_mcp", "official.json"),
    addon: path.join(extensions, "user_default", "mcp"),
    preferences: path.resolve(options.selection.profile.paths.config, "userpref.blend")
  };
}

export async function captureOfficialBlenderPreStates(options: {
  readonly paths: OfficialManagedBlenderPaths;
  readonly merge: GlobalBlenderConfigMergePlan;
  readonly files: BlenderInstallerFileSystem;
  readonly mode: "install" | "repair" | "migration";
}): Promise<OfficialManagedBlenderPreStates> {
  const [runtime, receipt, privateConfig, addon, preferences, permissions, mcp] = await Promise.all([
    options.files.state(options.paths.runtime),
    options.files.state(options.paths.receipt),
    options.files.state(options.paths.privateConfig),
    options.files.state(options.paths.addon),
    options.files.state(options.paths.preferences),
    options.files.state(options.merge.permissions.filePath),
    options.files.state(options.merge.mcp.filePath)
  ]);
  const owned = [[options.paths.runtime, runtime, "directory"], [options.paths.receipt, receipt, "file"],
    [options.paths.privateConfig, privateConfig, "file"],
    [options.paths.addon, addon, "directory"]] as const;
  for (const [targetPath, state, expectedKind] of owned) {
    if (options.mode === "install" && state.kind !== "absent") {
      throw new BlenderInstallError("conflict", `Unowned Blender integration target exists: ${targetPath}`);
    }
    if (options.mode === "migration" && targetPath !== options.paths.receipt && state.kind !== "absent") {
      throw new BlenderInstallError("conflict", `Official migration successor target is unowned: ${targetPath}`);
    }
    if (options.mode === "migration" && targetPath === options.paths.receipt && state.kind !== "file") {
      throw new BlenderInstallError("conflict", "Official migration requires the exact predecessor receipt");
    }
    if (options.mode === "repair" && state.kind !== "absent" && state.kind !== expectedKind) {
      throw new BlenderInstallError("unsafe-path", `Receipt-owned Blender target has an unsafe path type: ${targetPath}`);
    }
  }
  if (preferences.kind === "directory") {
    throw new BlenderInstallError("unsafe-path", `Expected Blender preferences to be a regular file: ${options.paths.preferences}`);
  }
  if (!statesEqual(permissions, { kind: "file", sha256: options.merge.permissions.expectedSourceHash })) {
    throw new BlenderInstallError("conflict", `Managed target changed after planning: ${options.merge.permissions.filePath}`);
  }
  if (!statesEqual(mcp, { kind: "file", sha256: options.merge.mcp.expectedSourceHash })) {
    throw new BlenderInstallError("conflict", `Managed target changed after planning: ${options.merge.mcp.filePath}`);
  }
  return { runtime, receipt, privateConfig, addon, preferences, permissions, mcp };
}

export async function stageOfficialBlenderIntegration(options: {
  readonly install: OfficialInstallBlenderIntegrationOptions;
  readonly paths: OfficialManagedBlenderPaths;
  readonly temporaryRoot: string;
  readonly files: BlenderInstallerFileSystem;
  readonly preStates: OfficialManagedBlenderPreStates;
}): Promise<StagedOfficialBlenderIntegration> {
  const runtime = path.join(options.temporaryRoot, "runtime");
  const install = options.install;
  const privateConfig = serializeOfficialPrivateConfig(createOfficialPrivateConfig({
    profileId: install.selection.profile.profileId
  }));
  const stagedPrivateConfigPath = path.join(options.temporaryRoot, "private", "official.json");
  await options.files.ensureParentDirectories([stagedPrivateConfigPath]);
  await writePrivateFile(stagedPrivateConfigPath, privateConfig);
  const runtimeStager = install.runtimeStager ?? stageOfficialBlenderRuntime;
  const stagedRuntime = await runtimeStager({
    python: install.python,
    platform: install.platform,
    architecture: install.architecture,
    catalog: install.catalog,
    lock: install.lock,
    requirements: install.requirements,
    derivativeRootPath: install.derivativeAssetsPath,
    privateConfigPath: stagedPrivateConfigPath,
    destination: runtime,
    downloader: install.downloader,
    process: install.environmentProcess,
    files: install.environmentFiles,
    env: install.env
  });
  if (path.resolve(stagedRuntime.pythonPath) !== path.join(runtime, "venv", "Scripts", "python.exe")
    || path.resolve(stagedRuntime.launcherPath) !== path.join(runtime, "blender-mcp.py")) {
    throw new BlenderInstallError("conflict", "Official runtime stager returned unexpected managed paths");
  }
  const addonArtifact = install.catalog.release.assets[0];
  const addonStager = install.addonStager ?? stageOfficialBlenderAddon;
  const stagedAddon = await addonStager({
    archivePath: path.join(runtime, "wheelhouse", addonArtifact.filename),
    artifact: addonArtifact,
    temporaryRoot: path.join(options.temporaryRoot, "blender-profile"),
    derivativeRootPath: install.derivativeAssetsPath
  });
  const configDirectory = path.join(options.temporaryRoot, "blender-profile", "config");
  const preferences = path.join(configDirectory, "userpref.blend");
  await options.files.ensureParentDirectories([preferences]);
  const livePreferences = await options.files.state(options.paths.preferences);
  if (!statesEqual(livePreferences, options.preStates.preferences)) {
    throw new BlenderInstallError("conflict", `Managed target changed after planning: ${options.paths.preferences}`);
  }
  if (options.preStates.preferences.kind === "file") {
    await options.files.copyFileIfPresent(options.paths.preferences, preferences);
    if (!statesEqual(await options.files.state(preferences), options.preStates.preferences)) {
      throw new BlenderInstallError("conflict", "Copied Blender preferences do not match the captured source");
    }
  }
  await (install.extensionEnabler ?? enableOfficialBlenderExtension)({
    profile: install.selection.profile,
    temporaryRoot: options.temporaryRoot,
    configDirectory,
    extensionsDirectory: stagedAddon.extensionsDirectory,
    privateConfigPath: stagedPrivateConfigPath,
    persistedPrivateConfigPath: options.paths.privateConfig,
    process: install.blenderProcess ?? nodeProbeProcessAdapter,
    env: install.env
  });
  if ((await options.files.state(preferences)).kind !== "file") {
    throw new BlenderInstallError("conflict", "Blender did not generate a regular official user preferences file");
  }
  return { runtime, addon: stagedAddon.extensionPath, preferences, privateConfig,
    privateConfigPath: stagedPrivateConfigPath };
}

function requireOfficialExtensionsPath(value: string | undefined): string {
  if (value === undefined || !path.isAbsolute(value) || path.resolve(value) !== value
    || /[\u0000-\u001F\u007F]/u.test(value) || value.split(/[\\/]/u).includes("..")) {
    throw new BlenderInstallError("unsafe-path", "Blender 5.1 official integration requires a safe discovered EXTENSIONS resource path");
  }
  return value;
}

export async function createOfficialBlenderTargetPlans(options: {
  readonly install: OfficialInstallBlenderIntegrationOptions;
  readonly paths: OfficialManagedBlenderPaths;
  readonly merge: GlobalBlenderConfigMergePlan;
  readonly staged: StagedOfficialBlenderIntegration;
  readonly files: BlenderInstallerFileSystem;
  readonly preStates: OfficialManagedBlenderPreStates;
  readonly predecessor?: BlenderInstallationReceiptPredecessor;
  readonly removalPlans?: readonly BlenderInstallTargetPlan[];
}): Promise<readonly BlenderInstallTargetPlan[]> {
  const runtimeState = await options.files.state(options.staged.runtime);
  const addonState = await options.files.state(options.staged.addon);
  const launcherState = await options.files.state(path.join(options.staged.runtime, "blender-mcp.py"));
  if (runtimeState.kind !== "directory" || addonState.kind !== "directory" || launcherState.kind !== "file") {
    throw new BlenderInstallError("conflict", "Official staged runtime, launcher, or addon is missing");
  }
  const launcherSha256 = sha256(OFFICIAL_BLENDER_LAUNCHER_SOURCE);
  if (launcherState.sha256 !== launcherSha256) {
    throw new BlenderInstallError("conflict", "Official staged launcher identity does not match the pinned source");
  }
  const immutableTargets = [
    { role: "private-config" as const, path: options.paths.privateConfig,
      state: { kind: "file" as const, sha256: sha256(options.staged.privateConfig) } },
    { role: "runtime" as const, path: options.paths.runtime, state: runtimeState },
    { role: "addon" as const, path: options.paths.addon, state: addonState }
  ];
  const receipt = createInstallationReceiptV3({
    flavor: "official",
    profile: options.install.selection.profile,
    python: options.install.python,
    catalog: options.install.catalog,
    lock: options.install.lock,
    requirements: options.install.requirements,
    addonModule: OFFICIAL_ADDON_MODULE,
    launcher: { path: options.paths.launcher, sha256: launcherSha256 },
    immutableTargets,
    managed: {
      mcp: { path: options.merge.mcp.filePath, fragmentSha256: options.merge.mcp.fragmentSha256 },
      permissions: { path: options.merge.permissions.filePath, fragmentSha256: options.merge.permissions.fragmentSha256 },
      preferencesPath: options.paths.preferences
    },
    predecessor: options.predecessor
  });
  return [
    { canonicalPath: options.paths.privateConfig, activationPhase: "credential_active", private: true,
      requiredPreState: options.preStates.privateConfig,
      staged: { kind: "file", content: options.staged.privateConfig } },
    { canonicalPath: options.paths.runtime, activationPhase: "credential_active", requiredPreState: options.preStates.runtime,
      staged: { kind: "directory", sourcePath: options.staged.runtime } },
    { canonicalPath: options.paths.addon, activationPhase: "addon_active", requiredPreState: options.preStates.addon,
      staged: { kind: "directory", sourcePath: options.staged.addon } },
    { canonicalPath: options.paths.preferences, activationPhase: "preferences_active", requiredPreState: options.preStates.preferences,
      staged: { kind: "file", content: await options.files.readFile(options.staged.preferences) } },
    { canonicalPath: options.merge.permissions.filePath, activationPhase: "permissions_active", requiredPreState: options.preStates.permissions,
      staged: { kind: "file", content: options.merge.permissions.content } },
    { canonicalPath: options.merge.mcp.filePath, activationPhase: "mcp_active", requiredPreState: options.preStates.mcp,
      staged: { kind: "file", content: options.merge.mcp.content } },
    ...(options.removalPlans ?? []),
    { canonicalPath: options.paths.receipt, activationPhase: "state_active", requiredPreState: options.preStates.receipt,
      staged: { kind: "file", content: `${JSON.stringify(receipt, null, 2)}\n` } }
  ];
}
