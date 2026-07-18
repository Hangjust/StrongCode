import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import {
  BlenderInstallError,
  copyPathDurable,
  pathState,
  removePath,
  statesEqual,
  syncDirectory
} from "./durable-fs";
import type {
  BlenderInstallJournal,
  BlenderInstallReceipt,
  BlenderInstallTarget,
  PathState,
  TransactionFaultInjector
} from "./journal-schema";
import {
  homePathFromJournalPath,
  layoutFromJournalPath,
  readBlenderInstallJournal,
  transactionJournalPaths,
  writeBlenderInstallJournal,
  writeBlenderInstallReceipt
} from "./journal-store";
import {
  acquireBlenderInstallLock,
  assertBlenderInstallLock,
  releaseBlenderInstallLock,
  type BlenderInstallLock
} from "./install-lock";
import { protectPrivateFile } from "./private-files";

function receipt(journal: BlenderInstallJournal, status: BlenderInstallReceipt["status"]): BlenderInstallReceipt {
  return {
    schemaVersion: 1,
    transactionId: journal.transactionId,
    profileId: journal.profileId,
    status,
    completedAt: new Date().toISOString(),
    conflicts: journal.targets.flatMap(target => target.conflict ? [target.conflict] : [])
  };
}

export type RollbackFaultOptions = { readonly fault?: TransactionFaultInjector; readonly lock?: BlenderInstallLock;
  readonly releaseLock?: boolean };

async function removeOwnedPath(filePath: string, expected: PathState): Promise<boolean> {
  const state = await pathState(filePath);
  if (state.kind === "absent") return true;
  if (!statesEqual(state, expected)) return false;
  await removePath(filePath);
  return true;
}

async function restoreBackup(journalPath: string, target: BlenderInstallTarget, options: RollbackFaultOptions): Promise<void> {
  if (!target.preState) throw new BlenderInstallError("invalid-journal", `Target lacks a pre-state: ${target.canonicalPath}`);
  if (target.preState.kind === "absent") {
    await removePath(target.canonicalPath);
    return;
  }
  if (!target.backup) throw new BlenderInstallError("invalid-journal", `Target lacks a backup: ${target.canonicalPath}`);
  const backup = await pathState(target.backup.canonicalPath);
  if (!statesEqual(backup, target.preState)) throw new BlenderInstallError("conflict", `Backup hash mismatch: ${target.backup.canonicalPath}`);
  const temporary = path.join(path.dirname(target.canonicalPath), `.${path.basename(target.canonicalPath)}.${target.targetId}.restoring`);
  const temporaryState = await pathState(temporary);
  if (temporaryState.kind === "absent") await copyPathDurable(target.backup.canonicalPath, temporary, target.private);
  else if (!statesEqual(temporaryState, target.preState)) throw new BlenderInstallError("conflict", `Restore temporary hash mismatch: ${temporary}`);
  if (target.private && target.preState.kind === "file") await protectPrivateFile(temporary);
  if (target.expectedPost.kind === "absent") {
    await rename(temporary, target.canonicalPath);
    await syncDirectory(path.dirname(target.canonicalPath));
    await options.fault?.("after-rollback-restored");
    return;
  }
  if (target.preState.kind === "directory") {
    const transactionDirectory = layoutFromJournalPath(journalPath).transactionDirectory;
    const evidenceDirectory = path.join(transactionDirectory, "rollback-evidence");
    if ((await pathState(evidenceDirectory)).kind === "absent") {
      await mkdir(evidenceDirectory, { mode: 0o700 });
      await syncDirectory(transactionDirectory);
    }
    const displaced = path.join(evidenceDirectory, `${target.targetId}.post`);
    const live = await pathState(target.canonicalPath);
    const evidence = await pathState(displaced);
    if (statesEqual(live, target.expectedPost) && evidence.kind === "absent") {
      await rename(target.canonicalPath, displaced);
      await syncDirectory(path.dirname(target.canonicalPath));
      await syncDirectory(evidenceDirectory);
      await options.fault?.("after-rollback-displaced");
    } else if (!(live.kind === "absent" && statesEqual(evidence, target.expectedPost))) {
      throw new BlenderInstallError("conflict", `Directory rollback state changed: ${target.canonicalPath}`);
    }
    try {
      await rename(temporary, target.canonicalPath);
      await syncDirectory(path.dirname(target.canonicalPath));
      await options.fault?.("after-rollback-restored");
      if (!await removeOwnedPath(displaced, target.expectedPost)) {
        throw new BlenderInstallError("conflict", `Rollback evidence changed: ${displaced}`);
      }
    } catch (error) {
      throw error;
    }
    return;
  }
  await rename(temporary, target.canonicalPath);
  await syncDirectory(path.dirname(target.canonicalPath));
}

function withTarget(
  journal: BlenderInstallJournal,
  targetId: string,
  update: (target: BlenderInstallTarget) => BlenderInstallTarget
): BlenderInstallJournal {
  return {
    ...journal,
    updatedAt: new Date().toISOString(),
    targets: journal.targets.map(target => target.targetId === targetId ? update(target) : target)
  };
}

function conflictFor(target: BlenderInstallTarget, observed: PathState, journalPath: string): NonNullable<BlenderInstallTarget["conflict"]> {
  return {
    canonicalPath: target.canonicalPath,
    expectedPost: target.expectedPost,
    observed,
    evidencePath: layoutFromJournalPath(journalPath).transactionDirectory,
    reason: "live-state-mismatch"
  };
}

async function ensureJournalLock(
  journalPath: string,
  journal: BlenderInstallJournal,
  suppliedLock?: BlenderInstallLock
): Promise<BlenderInstallJournal> {
  const homePath = homePathFromJournalPath(journalPath);
  if (suppliedLock) {
    if (suppliedLock.homePath !== homePath || suppliedLock.profileId !== journal.profileId) {
      throw new BlenderInstallError("conflict", "Supplied recovery lock does not match the Blender journal");
    }
    if (journal.lockToken === suppliedLock.token) return journal;
    const updated = { ...journal, lockToken: suppliedLock.token, updatedAt: new Date().toISOString() };
    await writeBlenderInstallJournal(journalPath, updated);
    return updated;
  }
  try {
    await assertBlenderInstallLock(homePath, journal.profileId, journal.lockToken);
    return journal;
  } catch (error) {
    if (!(error instanceof BlenderInstallError) || error.reason !== "conflict") throw error;
  }
  const lock = await acquireBlenderInstallLock(homePath, journal.profileId);
  const updated = { ...journal, lockToken: lock.token, updatedAt: new Date().toISOString() };
  await writeBlenderInstallJournal(journalPath, updated);
  return updated;
}

async function releaseJournalLock(journalPath: string, journal: BlenderInstallJournal): Promise<void> {
  await releaseBlenderInstallLock(homePathFromJournalPath(journalPath), journal.profileId, journal.lockToken);
}

export async function rollbackBlenderInstall(
  journalPath: string,
  options: RollbackFaultOptions = {}
): Promise<BlenderInstallReceipt> {
  let journal = await readBlenderInstallJournal(journalPath);
  if (journal.status === "committed") throw new BlenderInstallError("invalid-transition", "Committed Blender installs cannot be rolled back");
  if (journal.status === "rolled_back" || journal.status === "recovery_conflict") {
    return receipt(journal, journal.status);
  }
  journal = await ensureJournalLock(journalPath, journal, options.lock);
  for (const original of [...journal.targets].reverse()) {
    const target = journal.targets.find(candidate => candidate.targetId === original.targetId);
    if (!target || !target.preState || target.status === "rolled_back") continue;
    const installing = path.join(path.dirname(target.canonicalPath), `.${path.basename(target.canonicalPath)}.${target.targetId}.installing`);
    await removeOwnedPath(installing, target.expectedPost);
    const displaced = path.join(path.dirname(target.canonicalPath),
      `.${path.basename(target.canonicalPath)}.${journal.transactionId}.displaced`);
    const displacedState = await pathState(displaced);
    const rollbackEvidence = path.join(layoutFromJournalPath(journalPath).transactionDirectory,
      "rollback-evidence", `${target.targetId}.post`);
    const rollbackEvidenceState = await pathState(rollbackEvidence);
    const observed = await pathState(target.canonicalPath);
    if (statesEqual(observed, target.preState)) {
      await removeOwnedPath(displaced, target.preState);
      await removeOwnedPath(rollbackEvidence, target.expectedPost);
      journal = withTarget(journal, target.targetId, current => ({ ...current, status: "rolled_back", conflict: null }));
      await writeBlenderInstallJournal(journalPath, journal);
      continue;
    }
    if (observed.kind === "absent" && target.preState.kind === "directory"
      && statesEqual(rollbackEvidenceState, target.expectedPost)) {
      await restoreBackup(journalPath, target, options);
      journal = withTarget(journal, target.targetId, current => ({ ...current, status: "rolled_back", conflict: null }));
      await writeBlenderInstallJournal(journalPath, journal);
      continue;
    }
    if (target.status === "activating" && observed.kind === "absent" && target.preState.kind !== "absent"
      && statesEqual(displacedState, target.preState)) {
      await rename(displaced, target.canonicalPath);
      await syncDirectory(path.dirname(target.canonicalPath));
      journal = withTarget(journal, target.targetId, current => ({ ...current, status: "rolled_back", conflict: null }));
      await writeBlenderInstallJournal(journalPath, journal);
      continue;
    }
    if (!statesEqual(observed, target.expectedPost)) {
      const conflict = conflictFor(target, observed, journalPath);
      journal = withTarget(journal, target.targetId, current => ({ ...current, status: "recovery_conflict", conflict }));
      await writeBlenderInstallJournal(journalPath, journal);
      continue;
    }
    const latest = await pathState(target.canonicalPath);
    if (!statesEqual(latest, target.expectedPost)) {
      const conflict = conflictFor(target, latest, journalPath);
      journal = withTarget(journal, target.targetId, current => ({ ...current, status: "recovery_conflict", conflict }));
      await writeBlenderInstallJournal(journalPath, journal);
      continue;
    }
    await restoreBackup(journalPath, target, options);
    await removeOwnedPath(displaced, target.preState);
    journal = withTarget(journal, target.targetId, current => ({ ...current, status: "rolled_back", conflict: null }));
    await writeBlenderInstallJournal(journalPath, journal);
  }
  const status = journal.targets.some(target => target.status === "recovery_conflict") ? "recovery_conflict" : "rolled_back";
  journal = { ...journal, status, updatedAt: new Date().toISOString() };
  await writeBlenderInstallJournal(journalPath, journal);
  const result = receipt(journal, status);
  await writeBlenderInstallReceipt(journalPath, result);
  if (options.releaseLock ?? options.lock === undefined) await releaseJournalLock(journalPath, journal);
  return result;
}

export async function recoverBlenderInstallations(options: {
  readonly homePath: string;
  readonly profileId: string;
  readonly lock?: BlenderInstallLock;
}): Promise<readonly BlenderInstallReceipt[]> {
  const receipts: BlenderInstallReceipt[] = [];
  for (const journalPath of await transactionJournalPaths(options.homePath, options.profileId)) {
    const journal = await readBlenderInstallJournal(journalPath);
    if (journal.status === "active") receipts.push(await rollbackBlenderInstall(journalPath, {
      ...(options.lock ? { lock: options.lock, releaseLock: false } : {})
    }));
  }
  return receipts;
}
