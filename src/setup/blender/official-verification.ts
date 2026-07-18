import path from "node:path";
import type { GlobalBlenderConfigMergePlan } from "./config-merge";
import { planGlobalBlenderConfigMerge } from "./config-merge";
import { BlenderInstallError, sha256, statesEqual } from "./durable-fs";
import { nodeBlenderInstallerFileSystem, type BlenderInstallerFileSystem } from "./install-files";
import type { InstallBlenderIntegrationResult, OfficialInstallBlenderIntegrationOptions } from "./install";
import { assertInstallationReceiptV3Ownership, installationReceiptV3Matches, readInstallationReceipt, type OfficialBlenderInstallationReceiptV3 } from "./installation-receipt";
import type { PathState } from "./journal";
import { OFFICIAL_ADDON_MODULE, OfficialAddonError, probeOfficialBlenderExtension } from "./official-addon";
import { OfficialMcpProbeError, probeOfficialBlenderMcp } from "./official-mcp-probe";
import { officialManagedBlenderPaths, type OfficialManagedBlenderPaths } from "./official-install-plan";
import { OFFICIAL_BLENDER_LAUNCHER_SOURCE } from "./official-runtime";
import { nodeProbeProcessAdapter } from "./probe";
import { assertBlenderVerificationQuiescent } from "./verification";

type OwnedSnapshot = {
  readonly entries: readonly { readonly path: string; readonly state: PathState }[];
};

const RECOVERY_GUIDANCE = "Wait for the Blender installer to finish, run recovery, or rerun strongcode setup --blender --force";

function verificationConflict(message: string): BlenderInstallError {
  return new BlenderInstallError("conflict", `${message}. ${RECOVERY_GUIDANCE}`);
}

async function captureOwnedStates(paths: readonly string[], files: BlenderInstallerFileSystem): Promise<OwnedSnapshot> {
  return { entries: await Promise.all(paths.map(async filePath => ({ path: filePath, state: await files.state(filePath) }))) };
}

function snapshotsEqual(left: OwnedSnapshot, right: OwnedSnapshot): boolean {
  return left.entries.length === right.entries.length && left.entries.every((entry, index) => {
    const candidate = right.entries[index];
    return candidate !== undefined && entry.path === candidate.path && statesEqual(entry.state, candidate.state);
  });
}

export async function readOfficialInstallationReceipt(options: {
  readonly receiptPath: string;
  readonly files: BlenderInstallerFileSystem;
}): Promise<OfficialBlenderInstallationReceiptV3 | undefined> {
  const receipt = await readInstallationReceipt(options);
  if (receipt === undefined) return undefined;
  if (receipt.schemaVersion !== 3 || receipt.flavor !== "official") {
    throw new BlenderInstallError("conflict", "Blender integration flavor migration is required before installing the official integration");
  }
  return receipt;
}

export async function officialInstallationHealthy(options: {
  readonly install: OfficialInstallBlenderIntegrationOptions;
  readonly paths: OfficialManagedBlenderPaths;
  readonly merge: GlobalBlenderConfigMergePlan;
  readonly receipt: OfficialBlenderInstallationReceiptV3;
  readonly files: BlenderInstallerFileSystem;
}): Promise<boolean> {
  const currentTargets = await Promise.all([
    options.files.state(options.paths.privateConfig),
    options.files.state(options.paths.runtime),
    options.files.state(options.paths.addon)
  ]);
  const immutableTargets = [
    { role: "private-config" as const, path: options.paths.privateConfig, state: currentTargets[0] },
    { role: "runtime" as const, path: options.paths.runtime, state: currentTargets[1] },
    { role: "addon" as const, path: options.paths.addon, state: currentTargets[2] }
  ];
  const managed = {
    mcp: { path: options.merge.mcp.filePath, fragmentSha256: options.merge.mcp.fragmentSha256 },
    permissions: { path: options.merge.permissions.filePath, fragmentSha256: options.merge.permissions.fragmentSha256 },
    preferencesPath: options.paths.preferences
  };
  assertInstallationReceiptV3Ownership({ receipt: options.receipt, flavor: "official",
    profile: options.install.selection.profile, immutableTargets, managed });
  if (currentTargets.some(state => state.kind === "absent")) {
    return false;
  }
  const matches = await installationReceiptV3Matches({
    flavor: "official",
    profile: options.install.selection.profile,
    python: options.install.python,
    catalog: options.install.catalog,
    lock: options.install.lock,
    requirements: options.install.requirements,
    addonModule: OFFICIAL_ADDON_MODULE,
    launcher: { path: options.paths.launcher, sha256: sha256(OFFICIAL_BLENDER_LAUNCHER_SOURCE) },
    immutableTargets,
    managed,
    receipt: options.receipt,
    files: options.files
  });
  if (!matches || options.merge.mcp.changed || options.merge.permissions.changed) return false;
  try {
    const enabled = await (options.install.extensionProbe ?? probeOfficialBlenderExtension)({
      profile: options.install.selection.profile,
      privateConfigPath: options.paths.privateConfig,
      process: options.install.blenderProcess ?? nodeProbeProcessAdapter,
      env: options.install.env
    });
    if (!enabled) return false;
    const tools = await probeOfficialBlenderMcp({
      pythonPath: options.paths.python,
      launcherPath: options.paths.launcher,
      privateConfigPath: options.paths.privateConfig,
      cwd: options.paths.runtime,
      adapter: options.install.mcpProbe,
      env: options.install.env
    });
    return tools.length > 0;
  } catch (error) {
    if (error instanceof OfficialAddonError || error instanceof OfficialMcpProbeError) return false;
    throw error;
  }
}

export async function verifyOfficialBlenderIntegration(
  options: OfficialInstallBlenderIntegrationOptions
): Promise<InstallBlenderIntegrationResult> {
  const files = options.files ?? nodeBlenderInstallerFileSystem;
  const paths = officialManagedBlenderPaths(options);
  const ownedPaths = [options.selection.profile.executable.canonicalPath, paths.receipt, paths.privateConfig, paths.runtime, paths.addon,
    paths.preferences, path.join(options.homePath, "mcp.json"), path.join(options.homePath, "strongcode.config.yaml")]
    .map(filePath => path.resolve(filePath));
  const beforeQuiescence = await assertBlenderVerificationQuiescent({
    homePath: options.homePath,
    profileId: options.selection.profile.profileId
  });
  const beforeOwned = await captureOwnedStates(ownedPaths, files);
  const receipt = await readOfficialInstallationReceipt({ receiptPath: paths.receipt, files });
  if (receipt === undefined) throw verificationConflict("Blender ownership receipt is missing");
  const merge = await planGlobalBlenderConfigMerge({
    homePath: options.homePath,
    launch: { flavor: "official", pythonPath: paths.python, launcherPath: paths.launcher,
      privateConfigPath: paths.privateConfig }
  });
  await files.verifyFile(options.selection.profile.executable.canonicalPath, options.selection.profile.executable.sha256);
  const healthy = await officialInstallationHealthy({ install: options, paths, merge, receipt, files });
  const afterOwned = await captureOwnedStates(ownedPaths, files);
  const afterQuiescence = await assertBlenderVerificationQuiescent({
    homePath: options.homePath,
    profileId: options.selection.profile.profileId
  });
  if (!snapshotsEqual(beforeOwned, afterOwned)
    || JSON.stringify(beforeQuiescence) !== JSON.stringify(afterQuiescence)) {
    throw verificationConflict("Blender installation state changed during verification");
  }
  if (!healthy) throw verificationConflict("Blender owned official installation requires repair");
  return { status: "already-installed", profileId: options.selection.profile.profileId, receiptPath: paths.receipt };
}
