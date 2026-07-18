import { randomBytes } from "node:crypto";
import path from "node:path";
import { generateBlenderPreferences } from "./blender-preferences";
import type { GlobalBlenderConfigMergePlan } from "./config-merge";
import { BlenderInstallError, sha256, statesEqual } from "./durable-fs";
import { verifyDerivativeAddonAssets, verifyDerivativeWrapperAssets, type BlenderInstallerFileSystem } from "./install-files";
import type { LegacyInstallBlenderIntegrationOptions } from "./install";
import { createInstallationReceiptV3, type BlenderInstallationReceiptPredecessor } from "./installation-receipt";
import type { BlenderInstallTargetPlan, PathState } from "./journal";
import { nodeEnvironmentProcessAdapter, stageBlenderPythonEnvironment } from "./python-env";
import type { ProbeProcessAdapter } from "./types";

const ADDON_MODULE = "strongcode_blender_mcp";

export type ManagedBlenderPaths = {
  readonly runtime: string;
  readonly python: string;
  readonly wrapper: string;
  readonly receipt: string;
  readonly privateConfig: string;
  readonly addon: string;
  readonly preferences: string;
};

export type StagedBlenderIntegration = {
  readonly runtime: string;
  readonly addon: string;
  readonly preferences: string;
  readonly privateConfig: string;
};

export type ManagedBlenderPreStates = {
  readonly runtime: PathState;
  readonly receipt: PathState;
  readonly privateConfig: PathState;
  readonly addon: PathState;
  readonly preferences: PathState;
  readonly permissions: PathState;
  readonly mcp: PathState;
};

export function managedBlenderPaths(options: LegacyInstallBlenderIntegrationOptions): ManagedBlenderPaths {
  const runtime = path.resolve(options.homePath, "mcps", "blender", "runtime");
  return {
    runtime,
    python: path.join(runtime, "venv", "Scripts", "python.exe"),
    wrapper: path.join(runtime, "wrapper", "strongcode-blender-wrapper.py"),
    receipt: path.resolve(options.homePath, "mcps", "blender", "installation.json"),
    privateConfig: path.resolve(options.selection.profile.paths.config, ADDON_MODULE, "config.json"),
    addon: path.resolve(options.selection.profile.paths.resources.user, "scripts", "addons", ADDON_MODULE),
    preferences: path.resolve(options.selection.profile.paths.config, "userpref.blend")
  };
}

export async function captureManagedBlenderPreStates(options: {
  readonly paths: ManagedBlenderPaths;
  readonly merge: GlobalBlenderConfigMergePlan;
  readonly files: BlenderInstallerFileSystem;
  readonly mode: "install" | "repair" | "migration";
}): Promise<ManagedBlenderPreStates> {
  const [runtime, receipt, privateConfig, addon, preferences, permissions, mcp] = await Promise.all([
    options.files.state(options.paths.runtime),
    options.files.state(options.paths.receipt),
    options.files.state(options.paths.privateConfig),
    options.files.state(options.paths.addon),
    options.files.state(options.paths.preferences),
    options.files.state(options.merge.permissions.filePath),
    options.files.state(options.merge.mcp.filePath)
  ]);
  if (options.mode === "install") {
    for (const [targetPath, state] of [
      [options.paths.runtime, runtime],
      [options.paths.receipt, receipt],
      [options.paths.privateConfig, privateConfig],
      [options.paths.addon, addon]
    ] as const) {
      if (state.kind !== "absent") {
        throw new BlenderInstallError("conflict", `Unowned Blender integration target exists: ${targetPath}`);
      }
    }
  } else if (options.mode === "migration") {
    for (const [targetPath, state] of [
      [options.paths.runtime, runtime],
      [options.paths.privateConfig, privateConfig],
      [options.paths.addon, addon]
    ] as const) {
      if (state.kind !== "absent") {
        throw new BlenderInstallError("conflict", `Legacy migration successor target is unowned: ${targetPath}`);
      }
    }
    if (receipt.kind !== "file") {
      throw new BlenderInstallError("conflict", "Legacy migration requires the exact predecessor receipt");
    }
  } else {
    for (const [targetPath, state, expectedKind] of [
      [options.paths.runtime, runtime, "directory"],
      [options.paths.receipt, receipt, "file"],
      [options.paths.privateConfig, privateConfig, "file"],
      [options.paths.addon, addon, "directory"]
    ] as const) {
      if (state.kind !== "absent" && state.kind !== expectedKind) {
        throw new BlenderInstallError("unsafe-path", `Receipt-owned Blender target has an unsafe path type: ${targetPath}`);
      }
    }
  }
  if (preferences.kind === "directory") {
    throw new BlenderInstallError("unsafe-path", `Expected Blender preferences to be a regular file: ${options.paths.preferences}`);
  }
  const expectedPermissions = { kind: "file" as const, sha256: options.merge.permissions.expectedSourceHash };
  const expectedMcp = { kind: "file" as const, sha256: options.merge.mcp.expectedSourceHash };
  if (!statesEqual(permissions, expectedPermissions)) {
    throw new BlenderInstallError("conflict", `Managed target changed after planning: ${options.merge.permissions.filePath}`);
  }
  if (!statesEqual(mcp, expectedMcp)) {
    throw new BlenderInstallError("conflict", `Managed target changed after planning: ${options.merge.mcp.filePath}`);
  }
  return { runtime, receipt, privateConfig, addon, preferences, permissions, mcp };
}

export async function stageBlenderIntegration(options: {
  readonly install: LegacyInstallBlenderIntegrationOptions;
  readonly paths: ManagedBlenderPaths;
  readonly temporaryRoot: string;
  readonly files: BlenderInstallerFileSystem;
  readonly blenderProcess: ProbeProcessAdapter;
  readonly preStates: ManagedBlenderPreStates;
}): Promise<StagedBlenderIntegration> {
  const runtime = path.join(options.temporaryRoot, "runtime");
  const install = options.install;
  await stageBlenderPythonEnvironment({
    python: install.python,
    platform: install.platform,
    architecture: install.architecture,
    lock: install.lock,
    provenance: install.provenance,
    requirements: install.requirements,
    wrapperAssetsPath: install.wrapperAssetsPath,
    destination: runtime,
    ...(install.downloader ? { downloader: install.downloader } : {}),
    process: install.environmentProcess ?? nodeEnvironmentProcessAdapter,
    ...(install.environmentFiles ? { files: install.environmentFiles } : {}),
    wrapperVerifier: stagedWrapperPath => verifyDerivativeWrapperAssets({
      wrapperAssetsPath: stagedWrapperPath,
      provenance: install.provenance,
      files: options.files
    }),
    ...(install.env ? { env: install.env } : {})
  });
  const configDirectory = path.join(options.temporaryRoot, "blender-profile", "config");
  const scriptsDirectory = path.join(options.temporaryRoot, "blender-profile", "scripts");
  const addon = path.join(scriptsDirectory, "addons", ADDON_MODULE);
  const preferences = path.join(configDirectory, "userpref.blend");
  await options.files.ensureParentDirectories([preferences, addon]);
  const livePreferences = await options.files.state(options.paths.preferences);
  if (!statesEqual(livePreferences, options.preStates.preferences)) {
    throw new BlenderInstallError("conflict", `Managed target changed after planning: ${options.paths.preferences}`);
  }
  if (options.preStates.preferences.kind === "file") {
    await options.files.copyFileIfPresent(options.paths.preferences, preferences);
    const copiedPreferences = await options.files.state(preferences);
    if (!statesEqual(copiedPreferences, options.preStates.preferences)) {
      throw new BlenderInstallError("conflict", "Copied Blender preferences do not match the captured source");
    }
  }
  await options.files.copyDirectory(install.addonAssetsPath, addon);
  await verifyDerivativeAddonAssets({ addonAssetsPath: addon, provenance: install.provenance, files: options.files });
  await generateBlenderPreferences({
    profile: install.selection.profile,
    temporaryRoot: options.temporaryRoot,
    configDirectory,
    scriptsDirectory,
    privateProfilePath: path.dirname(options.paths.privateConfig),
    process: options.blenderProcess,
    ...(install.env ? { env: install.env } : {})
  });
  if ((await options.files.state(preferences)).kind !== "file") {
    throw new BlenderInstallError("conflict", "Blender did not generate a regular user preferences file");
  }
  return {
    runtime,
    addon,
    preferences,
    privateConfig: JSON.stringify({
      profileId: install.selection.profile.profileId,
      schemaVersion: 1,
      secret: randomBytes(32).toString("base64url")
    })
  };
}

export async function createBlenderTargetPlans(options: {
  readonly install: LegacyInstallBlenderIntegrationOptions;
  readonly paths: ManagedBlenderPaths;
  readonly merge: GlobalBlenderConfigMergePlan;
  readonly staged: StagedBlenderIntegration;
  readonly files: BlenderInstallerFileSystem;
  readonly preStates: ManagedBlenderPreStates;
  readonly predecessor?: BlenderInstallationReceiptPredecessor;
  readonly removalPlans?: readonly BlenderInstallTargetPlan[];
}): Promise<readonly BlenderInstallTargetPlan[]> {
  const immutableTargets = [
    { role: "private-config" as const, path: options.paths.privateConfig, state: fileState(options.staged.privateConfig) },
    { role: "addon" as const, path: options.paths.addon, state: await options.files.state(options.staged.addon) },
    { role: "runtime" as const, path: options.paths.runtime, state: await options.files.state(options.staged.runtime) }
  ];
  const receipt = createInstallationReceiptV3({ flavor: "legacy", profile: options.install.selection.profile,
    python: options.install.python, lock: options.install.lock, provenance: options.install.provenance,
    requirements: options.install.requirements, immutableTargets,
    managed: {
      mcp: { path: options.merge.mcp.filePath, fragmentSha256: options.merge.mcp.fragmentSha256 },
      permissions: { path: options.merge.permissions.filePath, fragmentSha256: options.merge.permissions.fragmentSha256 },
      preferencesPath: options.paths.preferences
    }, predecessor: options.predecessor });
  return [
    { canonicalPath: options.paths.privateConfig, activationPhase: "credential_active", private: true,
      requiredPreState: options.preStates.privateConfig,
      staged: { kind: "file", content: options.staged.privateConfig } },
    { canonicalPath: options.paths.runtime, activationPhase: "credential_active",
      requiredPreState: options.preStates.runtime,
      staged: { kind: "directory", sourcePath: options.staged.runtime } },
    { canonicalPath: options.paths.addon, activationPhase: "addon_active",
      requiredPreState: options.preStates.addon,
      staged: { kind: "directory", sourcePath: options.staged.addon } },
    { canonicalPath: options.paths.preferences, activationPhase: "preferences_active",
      requiredPreState: options.preStates.preferences,
      staged: { kind: "file", content: await options.files.readFile(options.staged.preferences) } },
    { canonicalPath: options.merge.permissions.filePath, activationPhase: "permissions_active",
      requiredPreState: options.preStates.permissions,
      staged: { kind: "file", content: options.merge.permissions.content } },
    { canonicalPath: options.merge.mcp.filePath, activationPhase: "mcp_active",
      requiredPreState: options.preStates.mcp,
      staged: { kind: "file", content: options.merge.mcp.content } },
    ...(options.removalPlans ?? []),
    { canonicalPath: options.paths.receipt, activationPhase: "state_active",
      requiredPreState: options.preStates.receipt,
      staged: { kind: "file", content: `${JSON.stringify(receipt, null, 2)}\n` } }
  ];
}

function fileState(content: string): PathState {
  return { kind: "file", sha256: sha256(content) };
}
