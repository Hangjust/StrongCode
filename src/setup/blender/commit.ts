import { BlenderInstallError, pathState, statesEqual } from "./durable-fs";
import type { BlenderInstallJournal, BlenderInstallReceipt } from "./journal-schema";
import {
  homePathFromJournalPath,
  pruneCommittedJournals,
  readBlenderInstallJournal,
  writeBlenderInstallJournal,
  writeBlenderInstallReceipt
} from "./journal-store";
import { acquireBlenderInstallLock, assertBlenderInstallLock, releaseBlenderInstallLock } from "./install-lock";

async function ensureCommitLock(journalPath: string, journal: BlenderInstallJournal): Promise<BlenderInstallJournal> {
  const homePath = homePathFromJournalPath(journalPath);
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

export async function commitBlenderInstall(journalPath: string): Promise<BlenderInstallReceipt> {
  let journal = await readBlenderInstallJournal(journalPath);
  if (journal.status !== "active" || journal.phase !== "state_active" || journal.targets.some(target => target.status !== "active")) {
    throw new BlenderInstallError("invalid-transition", "Commit requires state_active and every target active");
  }
  const homePath = homePathFromJournalPath(journalPath);
  journal = await ensureCommitLock(journalPath, journal);
  for (const target of journal.targets) {
    const observed = await pathState(target.canonicalPath);
    if (!statesEqual(observed, target.expectedPost)) {
      throw new BlenderInstallError("conflict", `Managed target changed before commit: ${target.canonicalPath}`);
    }
  }
  journal = { ...journal, phase: "committed", status: "committed", updatedAt: new Date().toISOString() };
  try {
    await writeBlenderInstallJournal(journalPath, journal);
    const result: BlenderInstallReceipt = {
      schemaVersion: 1,
      transactionId: journal.transactionId,
      profileId: journal.profileId,
      status: "committed",
      completedAt: new Date().toISOString(),
      conflicts: []
    };
    await writeBlenderInstallReceipt(journalPath, result);
    await pruneCommittedJournals(homePath, journal.profileId);
    return result;
  } finally {
    await releaseBlenderInstallLock(homePath, journal.profileId, journal.lockToken);
  }
}
