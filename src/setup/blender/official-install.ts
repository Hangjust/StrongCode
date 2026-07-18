import path from "node:path";
import { probeInstalledBlenderAddon } from "./blender-preferences";
import { BLENDER_MANAGED_MARKER, planGlobalBlenderConfigMerge } from "./config-merge";
import { BlenderInstallError } from "./durable-fs";
import { nodeBlenderInstallerFileSystem, type BlenderInstallerFileSystem } from "./install-files";
import type { InstallBlenderIntegrationResult, OfficialInstallBlenderIntegrationOptions } from "./install";
import {
  captureOfficialBlenderPreStates,
  createOfficialBlenderTargetPlans,
  officialManagedBlenderPaths,
  stageOfficialBlenderIntegration,
  type OfficialManagedBlenderPaths
} from "./official-install-plan";
import { parseOfficialRequirements } from "./official-artifact-parser";
import { probeOfficialBlenderMcp } from "./official-mcp-probe";
import { officialInstallationHealthy, verifyOfficialBlenderIntegration } from "./official-verification";
import { readInstallationReceipt } from "./installation-receipt";
import { createBlenderMigrationRemovalPlans, inspectBlenderMigrationPredecessor,
  inspectLegacyV2MigrationPredecessor,
  type BlenderMigrationPredecessor } from "./migration";
import { nodeProbeProcessAdapter } from "./probe";
import {
  ACTIVATION_PHASES,
  acquireBlenderInstallLock,
  activateBlenderInstallTarget,
  advanceBlenderInstallPhase,
  commitBlenderInstall,
  createBlenderInstallJournal,
  readBlenderInstallJournal,
  recoverBlenderInstallations,
  rollbackBlenderInstall,
  snapshotBlenderInstallTargets
} from "./journal";
import { BLENDER_INTEGRATION_LOCK_ID } from "./verification";

export async function installOfficialBlenderIntegration(
  options: OfficialInstallBlenderIntegrationOptions
): Promise<InstallBlenderIntegrationResult> {
  parseOfficialRequirements(options.lock, options.requirements);
  requireOfficialSelection(options);
  if (options.verifyOnly) return verifyOfficialBlenderIntegration(options);
  const files = options.files ?? nodeBlenderInstallerFileSystem;
  const legacyRecovery = options.selection.profile.profileId === BLENDER_INTEGRATION_LOCK_ID
    ? []
    : await recoverBlenderInstallations({ homePath: options.homePath, profileId: options.selection.profile.profileId });
  if (legacyRecovery.some(receipt => receipt.status === "recovery_conflict")) {
    throw new BlenderInstallError("conflict", "An incomplete Blender installation has recovery conflicts");
  }
  const lock = await acquireBlenderInstallLock(options.homePath, BLENDER_INTEGRATION_LOCK_ID);
  let lockOwner: "installer" | "journal" | "released" = "installer";
  const paths = officialManagedBlenderPaths(options);
  let temporaryRoot: string | undefined;
  let journalPath: string | undefined;
  let createdParents: readonly string[] = [];
  try {
    const recovery = await recoverBlenderInstallations({ homePath: options.homePath,
      profileId: BLENDER_INTEGRATION_LOCK_ID, lock });
    if (recovery.some(receipt => receipt.status === "recovery_conflict")) {
      throw new BlenderInstallError("conflict", "An incomplete Blender installation has recovery conflicts");
    }
    const receipt = await readInstallationReceipt({ receiptPath: paths.receipt, files });
    let predecessor: BlenderMigrationPredecessor | undefined;
    if (receipt !== undefined && (receipt.schemaVersion !== 3 || receipt.flavor !== "official")) {
      if (!options.repair) {
        throw new BlenderInstallError("conflict", "Blender integration flavor migration required; rerun strongcode setup --blender --force");
      }
      if (receipt.schemaVersion === 1) {
        throw new BlenderInstallError("conflict", "Blender flavor migration requires an exactly owned v2 or v3 predecessor receipt");
      }
      predecessor = receipt.schemaVersion === 2
        ? await inspectLegacyV2MigrationPredecessor({ homePath: options.homePath, receiptPath: paths.receipt, receipt, files })
        : await inspectBlenderMigrationPredecessor({ homePath: options.homePath, receiptPath: paths.receipt,
          receipt, successorFlavor: "official", files });
      const privateConfig = predecessor.immutableTargets.find(target => target.role === "private-config");
      if (privateConfig === undefined || !await probeInstalledBlenderAddon({
        profile: predecessor.profile,
        privateProfilePath: path.dirname(privateConfig.path),
        process: options.blenderProcess ?? nodeProbeProcessAdapter,
        ...(options.env ? { env: options.env } : {})
      })) {
        throw new BlenderInstallError("conflict", "Legacy Blender predecessor requires repair before migration");
      }
    }
    const merge = await planGlobalBlenderConfigMerge({ homePath: options.homePath,
      launch: { flavor: "official", pythonPath: paths.python, launcherPath: paths.launcher,
        privateConfigPath: paths.privateConfig },
      transition: predecessor?.transition });
    let mode: "install" | "repair" | "migration" = predecessor === undefined ? "install" : "migration";
    if (receipt !== undefined && receipt.schemaVersion === 3 && receipt.flavor === "official") {
      await files.verifyFile(options.selection.profile.executable.canonicalPath, options.selection.profile.executable.sha256);
      if (await officialInstallationHealthy({ install: options, paths, merge, receipt, files })) {
        return { status: "already-installed", profileId: options.selection.profile.profileId, receiptPath: paths.receipt };
      }
      if (!options.repair) {
        throw new BlenderInstallError("conflict", "Blender integration repair required; rerun strongcode setup --blender --force");
      }
      mode = "repair";
    } else if (receipt === undefined) {
      await rejectUnownedOfficialIntegration(paths, merge, files);
    }
    await files.verifyFile(options.selection.profile.executable.canonicalPath, options.selection.profile.executable.sha256);
    const preStates = await captureOfficialBlenderPreStates({ paths, merge, files, mode });
    temporaryRoot = await files.createTemporaryDirectory(options.homePath);
    const staged = await stageOfficialBlenderIntegration({ install: {
      ...options,
      blenderProcess: options.blenderProcess ?? nodeProbeProcessAdapter
    }, paths, temporaryRoot, files, preStates });
    await probeOfficialBlenderMcp({
      pythonPath: path.join(staged.runtime, "venv", "Scripts", "python.exe"),
      launcherPath: path.join(staged.runtime, "blender-mcp.py"),
      privateConfigPath: staged.privateConfigPath,
      cwd: staged.runtime,
      adapter: options.mcpProbe,
      env: options.env
    });
    const removalPlans = predecessor === undefined ? [] : createBlenderMigrationRemovalPlans({ predecessor,
      successorImmutablePaths: [paths.runtime, paths.addon] });
    const plans = await createOfficialBlenderTargetPlans({ install: options, paths, merge, staged, files, preStates,
      predecessor: predecessor?.predecessor, removalPlans });
    createdParents = await files.ensureParentDirectories(plans.map(plan => plan.canonicalPath));
    await files.verifyFile(merge.permissions.filePath, merge.permissions.expectedSourceHash);
    await files.verifyFile(merge.mcp.filePath, merge.mcp.expectedSourceHash);
    const journal = await createBlenderInstallJournal({ homePath: options.homePath,
      profileId: BLENDER_INTEGRATION_LOCK_ID, targets: plans, lock });
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
    return { status: "installed", profileId: options.selection.profile.profileId, receiptPath: paths.receipt };
  } catch (error) {
    if (journalPath !== undefined) {
      const journal = await readBlenderInstallJournal(journalPath);
      if (journal.status === "committed") {
        lockOwner = "released";
        throw new BlenderInstallError("conflict", "Blender integration activated but transaction finalization failed");
      }
      const rollback = await rollbackBlenderInstall(journalPath);
      lockOwner = "released";
      if (rollback.status === "recovery_conflict") {
        throw new BlenderInstallError("conflict", "Blender installation rollback encountered live-state conflicts");
      }
    }
    await files.removeEmptyDirectories(createdParents);
    throw error;
  } finally {
    if (temporaryRoot !== undefined) await files.removeTree(temporaryRoot);
    if (lockOwner === "installer") await lock.release();
  }
}

async function rejectUnownedOfficialIntegration(
  paths: OfficialManagedBlenderPaths,
  merge: Awaited<ReturnType<typeof planGlobalBlenderConfigMerge>>,
  files: BlenderInstallerFileSystem
): Promise<void> {
  for (const target of [paths.runtime, paths.addon, paths.receipt]) {
    if ((await files.state(target)).kind !== "absent") {
      throw new BlenderInstallError("conflict", `Unowned Blender integration target exists: ${target}`);
    }
  }
  const publicSources = await Promise.all([files.readFile(merge.mcp.filePath), files.readFile(merge.permissions.filePath)]);
  if (publicSources.some(source => source.toString("utf8").includes(BLENDER_MANAGED_MARKER))) {
    throw new BlenderInstallError("conflict", "Managed Blender config exists without an ownership receipt");
  }
}

function requireOfficialSelection(options: OfficialInstallBlenderIntegrationOptions): void {
  const version = options.selection.version;
  const target = options.lock.target;
  if (version.major < 5 || (version.major === 5 && version.minor < 1)
    || options.catalog.upstream.version !== "1.0.0" || target.implementation !== "cp" || target.python !== "3.11"
    || target.abi !== "cp311" || target.platform !== "win_amd64") {
    throw new BlenderInstallError("conflict", "Official Blender MCP requires Blender 5.1 or newer and the pinned v1.0.0 catalog");
  }
}
