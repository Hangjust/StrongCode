import path from "node:path";
import type { ArtifactProvenance, WheelLock } from "./artifact-manifest";
import type { VerifiedArtifactDownloader } from "./artifacts";
import {
  probeInstalledBlenderAddon
} from "./blender-preferences";
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
import {
  assertInstallationReceiptOwnership,
  installationReceiptMatches,
  readInstallationReceipt
} from "./installation-receipt";
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
import {
  type EnvironmentFileSystem,
  type EnvironmentProcessAdapter
} from "./python-env";
import { nodeProbeProcessAdapter } from "./probe";
import type { BlenderProfileCandidate, CpythonCandidate, ProbeProcessAdapter } from "./types";
import { BLENDER_INTEGRATION_LOCK_ID, verifyBlenderIntegration } from "./verification";

export { BLENDER_INTEGRATION_LOCK_ID } from "./verification";

export type InstallBlenderIntegrationOptions = {
  readonly homePath: string;
  readonly profile: BlenderProfileCandidate;
  readonly python: CpythonCandidate;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly lock: WheelLock;
  readonly provenance: ArtifactProvenance;
  readonly requirements: string;
  readonly wrapperAssetsPath: string;
  readonly addonAssetsPath: string;
  readonly downloader?: VerifiedArtifactDownloader;
  readonly environmentProcess?: EnvironmentProcessAdapter;
  readonly environmentFiles?: EnvironmentFileSystem;
  readonly blenderProcess?: ProbeProcessAdapter;
  readonly files?: BlenderInstallerFileSystem;
  readonly env?: NodeJS.ProcessEnv;
  readonly repair?: boolean;
  readonly verifyOnly?: boolean;
  readonly phaseHook?: (phase: ActivationPhase) => void | Promise<void>;
};

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
  requireSupportedSelection(options);
  if (verifyOnly) return verifyBlenderIntegration(options);
  const legacyRecovery = options.profile.profileId === BLENDER_INTEGRATION_LOCK_ID
    ? []
    : await recoverBlenderInstallations({ homePath: options.homePath, profileId: options.profile.profileId });
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
    const merge = await planGlobalBlenderConfigMerge({ homePath: options.homePath, pythonPath: paths.python,
      wrapperPath: paths.wrapper, privateConfigPath: paths.privateConfig });
    const existingReceipt = await readInstallationReceipt({ receiptPath: paths.receipt, files });
    let mode: "install" | "repair" = "install";
    if (existingReceipt) {
      if (existingReceipt.profileId !== options.profile.profileId) {
        throw new BlenderInstallError("conflict", `Blender integration is owned by a different managed profile: ${existingReceipt.profileId}`);
      }
      const immutableTargetPaths = [paths.privateConfig, paths.addon, paths.runtime];
      const legacyTargetPaths = [paths.privateConfig, paths.addon, paths.preferences, merge.permissions.filePath,
        merge.mcp.filePath, paths.runtime];
      const ownership = { receipt: existingReceipt, profile: options.profile, immutableTargetPaths, legacyTargetPaths,
        mcpPath: merge.mcp.filePath, permissionsPath: merge.permissions.filePath, preferencesPath: paths.preferences };
      assertInstallationReceiptOwnership(ownership);
      await files.verifyFile(options.profile.executable.canonicalPath, options.profile.executable.sha256);
      const matches = await installationReceiptMatches({ ...ownership, provenance: options.provenance,
        lock: options.lock, requirements: options.requirements, mcpFragmentSha256: merge.mcp.fragmentSha256,
        permissionsFragmentSha256: merge.permissions.fragmentSha256, files });
      const enabled = matches && !merge.mcp.changed && !merge.permissions.changed
        ? await probeInstalledBlenderAddon({ profile: options.profile, privateProfilePath: path.dirname(paths.privateConfig),
          process: blenderProcess, ...(options.env ? { env: options.env } : {}) })
        : false;
      if (matches && !merge.mcp.changed && !merge.permissions.changed && enabled) {
        return { status: "already-installed", profileId: options.profile.profileId, receiptPath: paths.receipt };
      }
      if (!options.repair) {
        throw new BlenderInstallError("conflict", "Blender integration repair required; rerun strongcode setup --blender --force");
      }
      mode = "repair";
    } else {
      await rejectUnownedIntegration(paths, merge, files);
    }
    await verifyDerivativeAddonAssets({ addonAssetsPath: options.addonAssetsPath, provenance: options.provenance, files });
    await verifyDerivativeWrapperAssets({ wrapperAssetsPath: options.wrapperAssetsPath, provenance: options.provenance, files });
    await files.verifyFile(options.profile.executable.canonicalPath, options.profile.executable.sha256);
    const preStates = await captureManagedBlenderPreStates({ paths, merge, files, mode });
    temporaryRoot = await files.createTemporaryDirectory(options.homePath);
    const staged = await stageBlenderIntegration({ install: options, paths, temporaryRoot, files, blenderProcess, preStates });
    const plans = await createBlenderTargetPlans({ install: options, paths, merge, staged, files, preStates });
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
    return { status: "installed", profileId: options.profile.profileId, receiptPath: paths.receipt };
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

function requireSupportedSelection(options: InstallBlenderIntegrationOptions): void {
  const version = /^(\d+)\.(\d+)(?:\.|$)/u.exec(options.profile.version);
  const blenderSupported = version !== null && (Number(version[1]) > 4 || (Number(version[1]) === 4 && Number(version[2]) >= 2));
  if (!blenderSupported) throw new BlenderInstallError("conflict", "StrongCode Blender integration requires Blender 4.2 or newer");
  const target = options.lock.target;
  if (options.platform !== "win32" || options.architecture !== "x64"
    || options.python.implementation !== "cpython" || options.python.version.major !== 3 || options.python.version.minor !== 11
    || target.implementation !== "cp" || target.python !== "3.11" || target.abi !== "cp311" || target.platform !== "win_amd64") {
    throw new BlenderInstallError("conflict", "Blender integration requires the locked CPython 3.11 win_amd64 runtime");
  }
}
