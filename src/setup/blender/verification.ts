import path from "node:path";
import { probeInstalledBlenderAddon } from "./blender-preferences";
import { planGlobalBlenderConfigMerge } from "./config-merge";
import { BlenderInstallError, statesEqual } from "./durable-fs";
import { nodeBlenderInstallerFileSystem, type BlenderInstallerFileSystem } from "./install-files";
import { managedBlenderPaths, type ManagedBlenderPaths } from "./install-plan";
import {
  assertInstallationReceiptOwnership,
  installationReceiptMatches,
  readInstallationReceipt,
  type BlenderInstallationReceipt
} from "./installation-receipt";
import { inspectBlenderInstallLock, type BlenderInstallLockInspection } from "./install-lock";
import {
  inspectBlenderInstallJournals,
  type BlenderInstallJournalInspection
} from "./journal-store";
import { nodeProbeProcessAdapter } from "./probe";
import type { InstallBlenderIntegrationOptions, InstallBlenderIntegrationResult } from "./install";
import type { PathState } from "./journal-schema";

export const BLENDER_INTEGRATION_LOCK_ID = "blender-integration";
const RECOVERY_GUIDANCE = "Wait for the Blender installer to finish, run recovery, or rerun strongcode setup --blender --force";

type QuiescenceSnapshot = {
  readonly locks: readonly BlenderInstallLockInspection[];
  readonly transactions: readonly {
    readonly profileId: string;
    readonly inspection: BlenderInstallJournalInspection;
  }[];
};

type OwnedSnapshot = {
  readonly entries: readonly { readonly path: string; readonly state: PathState }[];
};

function profileIds(profileId: string): readonly string[] {
  return [...new Set([BLENDER_INTEGRATION_LOCK_ID, profileId])].sort();
}

function verificationConflict(message: string): BlenderInstallError {
  return new BlenderInstallError("conflict", `${message}. ${RECOVERY_GUIDANCE}`);
}

export async function assertBlenderVerificationQuiescent(options: {
  readonly homePath: string;
  readonly profileId: string;
}): Promise<QuiescenceSnapshot> {
  const ids = profileIds(options.profileId);
  let locks: readonly BlenderInstallLockInspection[];
  let transactions: QuiescenceSnapshot["transactions"];
  try {
    locks = await Promise.all(ids.map(profileId => inspectBlenderInstallLock(options.homePath, profileId)));
    transactions = await Promise.all(ids.map(async profileId => ({
      profileId,
      inspection: await inspectBlenderInstallJournals(options.homePath, profileId)
    })));
  } catch (error) {
    if (error instanceof BlenderInstallError) throw verificationConflict(error.message);
    throw error;
  }
  if (locks.some(lock => lock.kind === "present")) {
    throw verificationConflict("Blender installation verification found an install lock");
  }
  if (transactions.some(transaction => transaction.inspection.journals.some(
    journal => journal.status === "active" || journal.status === "recovery_conflict"
  ))) {
    throw verificationConflict("Blender installation verification found an incomplete transaction journal");
  }
  return { locks, transactions };
}

async function captureOwnedStates(
  paths: readonly string[],
  files: BlenderInstallerFileSystem
): Promise<OwnedSnapshot> {
  return { entries: await Promise.all(paths.map(async filePath => ({
    path: filePath,
    state: await files.state(filePath)
  }))) };
}

function ownedSnapshotsEqual(left: OwnedSnapshot, right: OwnedSnapshot): boolean {
  return left.entries.length === right.entries.length && left.entries.every((entry, index) => {
    const candidate = right.entries[index];
    return candidate !== undefined && entry.path === candidate.path && statesEqual(entry.state, candidate.state);
  });
}

export async function inspectOwnedBlenderInstallation(
  options: InstallBlenderIntegrationOptions,
  paths: ManagedBlenderPaths,
  files: BlenderInstallerFileSystem
): Promise<OwnedSnapshot> {
  const managedPaths = [
    options.profile.executable.canonicalPath,
    paths.receipt,
    paths.privateConfig,
    paths.addon,
    paths.runtime,
    paths.preferences,
    path.join(options.homePath, "mcp.json"),
    path.join(options.homePath, "strongcode.config.yaml")
  ].map(filePath => path.resolve(filePath));
  const before = await captureOwnedStates(managedPaths, files);
  const merge = await planGlobalBlenderConfigMerge({ homePath: options.homePath, pythonPath: paths.python,
    wrapperPath: paths.wrapper, privateConfigPath: paths.privateConfig });
  let receipt: BlenderInstallationReceipt | undefined;
  try {
    receipt = await readInstallationReceipt({ receiptPath: paths.receipt, files });
  } catch (error) {
    if (error instanceof BlenderInstallError) throw verificationConflict(error.message);
    throw error;
  }
  if (!receipt) throw verificationConflict("Blender ownership receipt is missing");
  const ownership = {
    receipt,
    profile: options.profile,
    immutableTargetPaths: [paths.privateConfig, paths.addon, paths.runtime],
    legacyTargetPaths: [paths.privateConfig, paths.addon, paths.preferences, merge.permissions.filePath,
      merge.mcp.filePath, paths.runtime],
    mcpPath: merge.mcp.filePath,
    permissionsPath: merge.permissions.filePath,
    preferencesPath: paths.preferences
  };
  assertInstallationReceiptOwnership(ownership);
  await files.verifyFile(options.profile.executable.canonicalPath, options.profile.executable.sha256);
  const matches = await installationReceiptMatches({ ...ownership, provenance: options.provenance,
    lock: options.lock, requirements: options.requirements, mcpFragmentSha256: merge.mcp.fragmentSha256,
    permissionsFragmentSha256: merge.permissions.fragmentSha256, files });
  if (!matches || merge.mcp.changed || merge.permissions.changed) {
    throw verificationConflict("Blender owned installation requires repair");
  }
  const after = await captureOwnedStates(managedPaths, files);
  if (!ownedSnapshotsEqual(before, after)) {
    throw verificationConflict("Blender owned installation changed during verification");
  }
  return after;
}

export async function verifyBlenderIntegration(
  options: InstallBlenderIntegrationOptions
): Promise<InstallBlenderIntegrationResult> {
  const files = options.files ?? nodeBlenderInstallerFileSystem;
  const paths = managedBlenderPaths(options);
  const beforeQuiescence = await assertBlenderVerificationQuiescent({
    homePath: options.homePath,
    profileId: options.profile.profileId
  });
  const beforeOwned = await inspectOwnedBlenderInstallation(options, paths, files);
  const enabled = await probeInstalledBlenderAddon({ profile: options.profile,
    privateProfilePath: path.dirname(paths.privateConfig), process: options.blenderProcess ?? nodeProbeProcessAdapter,
    ...(options.env ? { env: options.env } : {}) });
  const afterOwned = await inspectOwnedBlenderInstallation(options, paths, files);
  const afterQuiescence = await assertBlenderVerificationQuiescent({
    homePath: options.homePath,
    profileId: options.profile.profileId
  });
  if (!ownedSnapshotsEqual(beforeOwned, afterOwned)
    || JSON.stringify(beforeQuiescence) !== JSON.stringify(afterQuiescence)) {
    throw verificationConflict("Blender installation state changed during verification");
  }
  if (!enabled) throw verificationConflict("Blender addon health verification failed");
  return { status: "already-installed", profileId: options.profile.profileId, receiptPath: paths.receipt };
}
