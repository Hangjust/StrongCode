import path from "node:path";
import {
  BLENDER_MANAGED_MARKER,
  planGlobalBlenderConfigMerge,
  type GlobalBlenderConfigMergePlan
} from "./config-merge";
import { BlenderInstallError } from "./durable-fs";
import {
  nodeBlenderInstallerFileSystem,
  verifyDerivativeAddonAssets,
  verifyDerivativeWrapperAssets,
  type BlenderInstallerFileSystem
} from "./install-files";
import {
  captureManagedBlenderPreStates,
  createBlenderTargetPlans,
  managedBlenderPaths,
  stageBlenderIntegration,
  type ManagedBlenderPaths
} from "./install-plan";
import { readInstallationReceipt } from "./installation-receipt";
import {
  ACTIVATION_PHASES,
  activateBlenderInstallTarget,
  advanceBlenderInstallPhase,
  commitBlenderInstall,
  createBlenderInstallJournal,
  recoverBlenderInstallations,
  rollbackBlenderInstall,
  readBlenderInstallJournal,
  snapshotBlenderInstallTargets,
  acquireBlenderInstallLock,
  type ActivationPhase
} from "./journal";
import { probeOfficialBlenderMcp, type OfficialMcpProbeAdapter } from "./official-mcp-probe";
import { installOfficialBlenderIntegration } from "./official-install";
import {
  enableOfficialBlenderExtension,
  probeOfficialBlenderExtension,
  stageOfficialBlenderAddon
} from "./official-addon";
import { stageOfficialBlenderRuntime } from "./official-runtime";
import { legacyInstallationHealthy } from "./legacy-install-state";
import { createBlenderMigrationRemovalPlans, inspectBlenderMigrationPredecessor,
  migrationPredecessorProfile, type BlenderMigrationPredecessor } from "./migration";
import { nodeProbeProcessAdapter } from "./probe";
import { BLENDER_INTEGRATION_LOCK_ID, verifyBlenderIntegration } from "./verification";
import type {
  InstallBlenderIntegrationOptions,
  LegacyInstallBlenderIntegrationOptions,
  OfficialInstallBlenderIntegrationOptions
} from "./install-options";

export type {
  InstallBlenderIntegrationOptions,
  LegacyInstallBlenderIntegrationOptions,
  OfficialInstallBlenderIntegrationOptions
} from "./install-options";

export { BLENDER_INTEGRATION_LOCK_ID } from "./verification";

export type InstallBlenderIntegrationResult = {
  readonly status: "installed" | "already-installed";
  readonly profileId: string;
  readonly receiptPath: string;
};

export async function installBlenderIntegration(
  options: InstallBlenderIntegrationOptions
): Promise<InstallBlenderIntegrationResult> {
  const verifyOnly = options.verifyOnly ?? false;
  if (verifyOnly && options.repair) {
    throw new BlenderInstallError("conflict", "Verification-only Blender setup cannot repair or install managed targets");
  }
  requirePlatformPrerequisite(options);
  if (!isLegacyInstall(options)) {
    switch (options.selection.flavor) {
      case "official":
        return installOfficialBlenderIntegration(options);
      default:
        return unsupportedSelection(options.selection.flavor);
    }
  }
  requireLockedRuntime(options);
  if (verifyOnly) return verifyBlenderIntegration(options);
  const profile = options.selection.profile;
  const legacyRecovery = profile.profileId === BLENDER_INTEGRATION_LOCK_ID
    ? []
    : await recoverBlenderInstallations({ homePath: options.homePath, profileId: profile.profileId });
  if (legacyRecovery.some(receipt => receipt.status === "recovery_conflict")) {
    throw new BlenderInstallError("conflict", "An incomplete Blender installation has recovery conflicts");
  }
  const files = options.files ?? nodeBlenderInstallerFileSystem;
  const blenderProcess = options.blenderProcess ?? nodeProbeProcessAdapter;
  const lock = await acquireBlenderInstallLock(options.homePath, BLENDER_INTEGRATION_LOCK_ID);
  let lockOwner: "installer" | "journal" | "released" = "installer";
  const paths = managedBlenderPaths(options);
  let temporaryRoot: string | undefined;
  let journalPath: string | undefined;
  let createdParents: readonly string[] = [];
  try {
    const recovery = await recoverBlenderInstallations({
      homePath: options.homePath,
      profileId: BLENDER_INTEGRATION_LOCK_ID,
      lock
    });
    if (recovery.some(receipt => receipt.status === "recovery_conflict")) {
      throw new BlenderInstallError("conflict", "An incomplete Blender installation has recovery conflicts");
    }
    const receipt = await readInstallationReceipt({ receiptPath: paths.receipt, files });
    let predecessor: BlenderMigrationPredecessor | undefined;
    if (receipt !== undefined && receipt.schemaVersion === 3 && receipt.flavor === "official") {
      if (!options.repair) {
        throw new BlenderInstallError("conflict", "Blender integration flavor migration required; rerun strongcode setup --blender --force");
      }
      predecessor = await inspectBlenderMigrationPredecessor({ homePath: options.homePath, receiptPath: paths.receipt,
        receipt, successorFlavor: "legacy", files });
      if (predecessor.launch.flavor !== "official") {
        throw new BlenderInstallError("conflict", "Official Blender predecessor launch evidence is invalid");
      }
      const predecessorProfile = migrationPredecessorProfile(receipt);
      const enabled = await (options.extensionProbe ?? probeOfficialBlenderExtension)({
        profile: predecessorProfile,
        privateConfigPath: predecessor.launch.privateConfigPath,
        process: blenderProcess,
        env: options.env
      });
      if (!enabled || (await probeOfficialBlenderMcp({ pythonPath: predecessor.launch.pythonPath,
          launcherPath: predecessor.launch.launcherPath, cwd: path.dirname(predecessor.launch.launcherPath),
          privateConfigPath: predecessor.launch.privateConfigPath,
          adapter: options.mcpProbe, env: options.env })).length === 0) {
        throw new BlenderInstallError("conflict", "Official Blender predecessor requires repair before migration");
      }
    } else if (receipt !== undefined && receipt.schemaVersion === 3 && receipt.flavor !== "legacy") {
      throw new BlenderInstallError("conflict", "Unsupported Blender migration receipt flavor");
    }
    const merge = await planGlobalBlenderConfigMerge({ homePath: options.homePath,
      launch: { flavor: "legacy", pythonPath: paths.python, wrapperPath: paths.wrapper,
        privateConfigPath: paths.privateConfig }, transition: predecessor?.transition });
    let mode: "install" | "repair" | "migration" = predecessor === undefined ? "install" : "migration";
    if (receipt !== undefined && predecessor === undefined) {
      if (receipt.profileId !== profile.profileId) {
        throw new BlenderInstallError("conflict", `Blender integration is owned by a different managed profile: ${receipt.profileId}`);
      }
      await files.verifyFile(profile.executable.canonicalPath, profile.executable.sha256);
      if (await legacyInstallationHealthy({ install: options, paths, merge, receipt, files, blenderProcess })) {
        return { status: "already-installed", profileId: profile.profileId, receiptPath: paths.receipt };
      }
      if (!options.repair) {
        throw new BlenderInstallError("conflict", "Blender integration repair required; rerun strongcode setup --blender --force");
      }
      mode = "repair";
    } else if (receipt === undefined) {
      await rejectUnownedIntegration(paths, merge, files);
    }
    await verifyDerivativeAddonAssets({ addonAssetsPath: options.addonAssetsPath, provenance: options.provenance, files });
    await verifyDerivativeWrapperAssets({ wrapperAssetsPath: options.wrapperAssetsPath, provenance: options.provenance, files });
    await files.verifyFile(profile.executable.canonicalPath, profile.executable.sha256);
    const preStates = await captureManagedBlenderPreStates({ paths, merge, files, mode });
    temporaryRoot = await files.createTemporaryDirectory(options.homePath);
    const staged = await stageBlenderIntegration({ install: options, paths, temporaryRoot, files, blenderProcess, preStates });
    const removalPlans = predecessor === undefined ? [] : createBlenderMigrationRemovalPlans({ predecessor,
      successorImmutablePaths: [paths.privateConfig, paths.addon, paths.runtime] });
    const plans = await createBlenderTargetPlans({ install: options, paths, merge, staged, files, preStates,
      predecessor: predecessor?.predecessor, removalPlans });
    createdParents = await files.ensureParentDirectories(plans.map(plan => plan.canonicalPath));
    await files.verifyFile(merge.permissions.filePath, merge.permissions.expectedSourceHash);
    await files.verifyFile(merge.mcp.filePath, merge.mcp.expectedSourceHash);
    const journal = await createBlenderInstallJournal({
      homePath: options.homePath,
      profileId: BLENDER_INTEGRATION_LOCK_ID,
      targets: plans,
      lock
    });
    journalPath = journal.journalPath;
    lockOwner = "journal";
    await advanceBlenderInstallPhase(journalPath, "artifacts_verified");
    await advanceBlenderInstallPhase(journalPath, "runtime_staged");
    await snapshotBlenderInstallTargets(journalPath);
    for (const phase of ACTIVATION_PHASES) {
      for (const plan of plans.filter(candidate => candidate.activationPhase === phase)) {
        await activateBlenderInstallTarget(journalPath, plan.canonicalPath);
      }
      await advanceBlenderInstallPhase(journalPath, phase);
      await options.phaseHook?.(phase);
    }
    await commitBlenderInstall(journalPath);
    lockOwner = "released";
    return { status: "installed", profileId: profile.profileId, receiptPath: paths.receipt };
  } catch (error) {
    if (journalPath) {
      const journal = await readBlenderInstallJournal(journalPath);
      if (journal.status === "committed") {
        lockOwner = "released";
        throw new BlenderInstallError("conflict", "Blender integration activated but transaction finalization failed");
      } else {
        const rollback = await rollbackBlenderInstall(journalPath);
        lockOwner = "released";
        if (rollback.status === "recovery_conflict") {
          throw new BlenderInstallError("conflict", "Blender installation rollback encountered live-state conflicts");
        }
      }
    }
    await files.removeEmptyDirectories(createdParents);
    throw error;
  } finally {
    if (temporaryRoot) await files.removeTree(temporaryRoot);
    if (lockOwner === "installer") await lock.release();
  }
}

function unsupportedSelection(selection: never): never {
  throw new BlenderInstallError("conflict", `Unsupported Blender integration selection: ${JSON.stringify(selection)}`);
}

async function rejectUnownedIntegration(
  paths: ManagedBlenderPaths,
  merge: GlobalBlenderConfigMergePlan,
  files: BlenderInstallerFileSystem
): Promise<void> {
  for (const target of [paths.runtime, paths.addon, paths.privateConfig]) {
    if ((await files.state(target)).kind !== "absent") throw new BlenderInstallError("conflict", `Unowned Blender integration target exists: ${target}`);
  }
  const publicSources = await Promise.all([files.readFile(merge.mcp.filePath), files.readFile(merge.permissions.filePath)]);
  if (publicSources.some(source => source.toString("utf8").includes(BLENDER_MANAGED_MARKER))) {
    throw new BlenderInstallError("conflict", "Managed Blender config exists without an ownership receipt");
  }
}

function isLegacyInstall(options: InstallBlenderIntegrationOptions): options is LegacyInstallBlenderIntegrationOptions {
  return options.selection.flavor === "legacy";
}

function requirePlatformPrerequisite(options: InstallBlenderIntegrationOptions): void {
  if (options.platform !== "win32" || options.architecture !== "x64"
    || options.python.implementation !== "cpython" || options.python.version.major !== 3 || options.python.version.minor !== 11
    || options.python.pointerWidth !== 64 || options.python.sysconfigPlatform !== "win_amd64") {
    throw new BlenderInstallError("conflict", "Blender integration requires the locked CPython 3.11 win_amd64 runtime");
  }
}

function requireLockedRuntime(options: LegacyInstallBlenderIntegrationOptions): void {
  const target = options.lock.target;
  if (target.implementation !== "cp" || target.python !== "3.11" || target.abi !== "cp311" || target.platform !== "win_amd64") {
    throw new BlenderInstallError("conflict", "Blender integration requires the locked CPython 3.11 win_amd64 runtime");
  }
}
