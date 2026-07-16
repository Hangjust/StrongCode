import { createHash, randomUUID } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  BlenderInstallError,
  canonicalTargetPath,
  copyPathDurable,
  pathState,
  removePath,
  statesEqual,
  syncDirectory,
  writeDurableFile
} from "./durable-fs";
import {
  JOURNAL_PHASES,
  type ActivationPhase,
  type BlenderInstallJournal,
  type BlenderInstallTarget,
  type JournalPhase,
  type PathState,
  type TransactionFaultInjector
} from "./journal-schema";
import {
  createTransactionLayout,
  homePathFromJournalPath,
  layoutFromJournalPath,
  readBlenderInstallJournal,
  writeBlenderInstallJournal
} from "./journal-store";
import { acquireBlenderInstallLock, assertBlenderInstallLock, type BlenderInstallLock } from "./install-lock";
import { protectPrivateFile, writePrivateFile } from "./private-files";

export type StagedTarget = { readonly kind: "file"; readonly content: string | Buffer } | { readonly kind: "directory"; readonly sourcePath: string };

export type BlenderInstallTargetPlan = {
  readonly canonicalPath: string;
  readonly activationPhase: ActivationPhase;
  readonly staged: StagedTarget;
  readonly private?: boolean;
  readonly requiredPreState: PathState;
};

export type CreateBlenderInstallJournalOptions = {
  readonly homePath: string;
  readonly profileId: string;
  readonly targets: readonly BlenderInstallTargetPlan[];
  readonly lock?: BlenderInstallLock;
  readonly fault?: TransactionFaultInjector;
};

export type TransactionFaultOptions = { readonly fault?: TransactionFaultInjector };

function targetId(canonicalPath: string): string {
  return createHash("sha256").update(process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath).digest("hex").slice(0, 16);
}

function stagedPath(journalPath: string, target: BlenderInstallTarget): string {
  return path.join(layoutFromJournalPath(journalPath).stageDirectory, `${target.targetId}.${target.expectedPost.kind}`);
}

async function stageTarget(
  stageDirectory: string,
  plan: BlenderInstallTargetPlan
): Promise<BlenderInstallTarget> {
  const canonicalPath = await canonicalTargetPath(plan.canonicalPath);
  const id = targetId(canonicalPath);
  const privateFile = plan.private ?? false;
  if (privateFile && plan.staged.kind === "directory") {
    throw new BlenderInstallError("unsafe-path", "Private Blender targets must be regular files");
  }
  const destination = path.join(stageDirectory, `${id}.${plan.staged.kind}`);
  if (plan.staged.kind === "file") {
    if (privateFile) await writePrivateFile(destination, plan.staged.content);
    else await writeDurableFile(destination, plan.staged.content, 0o600);
  } else {
    await copyPathDurable(plan.staged.sourcePath, destination);
  }
  const expectedPost = await pathState(destination);
  const current = await pathState(canonicalPath);
  if (current.kind !== "absent" && current.kind !== expectedPost.kind) {
    throw new BlenderInstallError("conflict", `Refusing managed target path type change: ${canonicalPath}`);
  }
  return {
    targetId: id,
    canonicalPath,
    activationPhase: plan.activationPhase,
    private: privateFile,
    status: "staged",
    requiredPreState: plan.requiredPreState,
    preState: null,
    backup: null,
    expectedPost,
    conflict: null
  };
}

export async function createBlenderInstallJournal(
  options: CreateBlenderInstallJournalOptions
): Promise<{ readonly transactionId: string; readonly journalPath: string }> {
  const transactionId = randomUUID();
  const lock = options.lock ?? await acquireBlenderInstallLock(options.homePath, options.profileId);
  if (lock.homePath !== path.resolve(options.homePath) || lock.profileId !== options.profileId) {
    throw new BlenderInstallError("conflict", "Provided Blender installer lock does not match the transaction scope");
  }
  let layout: Awaited<ReturnType<typeof createTransactionLayout>> | undefined;
  let result: { readonly transactionId: string; readonly journalPath: string } | undefined;
  try {
    layout = await createTransactionLayout(options.homePath, options.profileId, transactionId);
    const targets: BlenderInstallTarget[] = [];
    for (const plan of options.targets) targets.push(await stageTarget(layout.stageDirectory, plan));
    const targetPaths = targets.map(target => process.platform === "win32" ? target.canonicalPath.toLowerCase() : target.canonicalPath);
    if (new Set(targetPaths).size !== targets.length) {
      throw new BlenderInstallError("conflict", "Managed target paths must be unique within a transaction");
    }
    const now = new Date().toISOString();
    const journal: BlenderInstallJournal = {
      schemaVersion: 1,
      transactionId,
      lockToken: lock.token,
      profileId: options.profileId,
      phase: "created",
      status: "active",
      createdAt: now,
      updatedAt: now,
      targets
    };
    await writeBlenderInstallJournal(layout.journalPath, journal);
    result = { transactionId, journalPath: layout.journalPath };
  } catch (error) {
    if (layout) await rm(layout.transactionDirectory, { recursive: true });
    if (!options.lock) await lock.release();
    throw error;
  }
  if (!result) throw new BlenderInstallError("invalid-journal", "Blender transaction journal was not created");
  await options.fault?.("after-journal-sync");
  return result;
}

async function assertJournalMutationLock(journalPath: string, journal: BlenderInstallJournal): Promise<void> {
  await assertBlenderInstallLock(homePathFromJournalPath(journalPath), journal.profileId, journal.lockToken);
}

function nextPhase(current: JournalPhase): JournalPhase | undefined {
  const index = JOURNAL_PHASES.indexOf(current);
  return JOURNAL_PHASES[index + 1];
}

export async function advanceBlenderInstallPhase(journalPath: string, phase: JournalPhase): Promise<void> {
  const journal = await readBlenderInstallJournal(journalPath);
  await assertJournalMutationLock(journalPath, journal);
  if (journal.status !== "active" || nextPhase(journal.phase) !== phase || phase === "committed") {
    throw new BlenderInstallError("invalid-transition", `Cannot advance Blender install from ${journal.phase} to ${phase}`);
  }
  if (phase === "runtime_staged" && journal.targets.some(target => target.status !== "staged")) {
    throw new BlenderInstallError("invalid-transition", "All Blender targets must be staged before runtime_staged");
  }
  if (phase === "snapshots_complete" && journal.targets.some(target => target.status !== "snapshotted")) {
    throw new BlenderInstallError("invalid-transition", "All Blender targets must be snapshotted before snapshots_complete");
  }
  if (journal.targets.some(target => target.activationPhase === phase && target.status !== "active")) {
    throw new BlenderInstallError("invalid-transition", `All ${phase} targets must be active before phase advancement`);
  }
  await writeBlenderInstallJournal(journalPath, { ...journal, phase, updatedAt: new Date().toISOString() });
}

export async function snapshotBlenderInstallTargets(journalPath: string, options: TransactionFaultOptions = {}): Promise<void> {
  let journal = await readBlenderInstallJournal(journalPath);
  await assertJournalMutationLock(journalPath, journal);
  if (journal.status !== "active" || journal.phase !== "runtime_staged") {
    throw new BlenderInstallError("invalid-transition", "Snapshots require the runtime_staged phase");
  }
  const layout = layoutFromJournalPath(journalPath);
  for (const target of journal.targets) {
    if (target.status === "snapshotted") continue;
    const current = await pathState(target.canonicalPath);
    if (!statesEqual(current, target.requiredPreState)) {
      throw new BlenderInstallError("conflict", `Managed target changed after planning: ${target.canonicalPath}`);
    }
    if (current.kind !== "absent" && current.kind !== target.expectedPost.kind) {
      throw new BlenderInstallError("conflict", `Refusing managed target path type change: ${target.canonicalPath}`);
    }
    let backup = null;
    if (current.kind !== "absent") {
      const backupPath = path.join(layout.backupDirectory, `${target.targetId}.${current.kind}`);
      const existing = await pathState(backupPath);
      if (existing.kind === "absent") await copyPathDurable(target.canonicalPath, backupPath, target.private);
      else if (!statesEqual(existing, current)) throw new BlenderInstallError("conflict", `Backup hash mismatch: ${backupPath}`);
      if (target.private && current.kind === "file") await protectPrivateFile(backupPath);
      backup = { canonicalPath: backupPath, kind: current.kind, sha256: current.sha256 };
      await options.fault?.("after-backup-sync");
    }
    const targets = journal.targets.map(candidate => candidate.targetId === target.targetId
      ? { ...candidate, preState: current, backup, status: "snapshotted" as const }
      : candidate);
    journal = { ...journal, targets, updatedAt: new Date().toISOString() };
    await writeBlenderInstallJournal(journalPath, journal);
  }
  await writeBlenderInstallJournal(journalPath, { ...journal, phase: "snapshots_complete", updatedAt: new Date().toISOString() });
}

async function prepareAdjacentReplacement(journalPath: string, target: BlenderInstallTarget): Promise<string> {
  const temporary = path.join(path.dirname(target.canonicalPath), `.${path.basename(target.canonicalPath)}.${target.targetId}.installing`);
  const existing = await pathState(temporary);
  if (statesEqual(existing, target.expectedPost)) await removePath(temporary);
  else if (existing.kind !== "absent") throw new BlenderInstallError("conflict", `Activation temporary path is unowned: ${temporary}`);
  await copyPathDurable(stagedPath(journalPath, target), temporary, target.private);
  if (target.private && target.expectedPost.kind === "file") await protectPrivateFile(temporary);
  return temporary;
}

export async function activateBlenderInstallTarget(
  journalPath: string,
  canonicalPath: string,
  options: TransactionFaultOptions = {}
): Promise<void> {
  let journal = await readBlenderInstallJournal(journalPath);
  await assertJournalMutationLock(journalPath, journal);
  if (journal.status !== "active" || JOURNAL_PHASES.indexOf(journal.phase) < JOURNAL_PHASES.indexOf("snapshots_complete")) {
    throw new BlenderInstallError("invalid-transition", "Target activation requires durable snapshots");
  }
  const canonical = await canonicalTargetPath(canonicalPath);
  const target = journal.targets.find(candidate => candidate.canonicalPath === canonical);
  if (!target || !target.preState) throw new BlenderInstallError("invalid-transition", `Target is not snapshotted: ${canonical}`);
  const live = await pathState(canonical);
  if (target.status === "active" && statesEqual(live, target.expectedPost)) return;
  if (nextPhase(journal.phase) !== target.activationPhase) {
    throw new BlenderInstallError("invalid-transition", `Target activation is out of phase: ${target.activationPhase}`);
  }
  if (target.status !== "snapshotted" || !statesEqual(live, target.preState)) {
    throw new BlenderInstallError("conflict", `Managed target changed before activation: ${canonical}`);
  }
  const staged = await pathState(stagedPath(journalPath, target));
  if (!statesEqual(staged, target.expectedPost)) throw new BlenderInstallError("conflict", `Staged target hash mismatch: ${canonical}`);
  journal = { ...journal, updatedAt: new Date().toISOString(), targets: journal.targets.map(candidate =>
    candidate.targetId === target.targetId ? { ...candidate, status: "activating" as const } : candidate) };
  await writeBlenderInstallJournal(journalPath, journal);
  await options.fault?.("before-destructive-transition");

  const temporary = await prepareAdjacentReplacement(journalPath, target);
  const displaced = path.join(path.dirname(canonical), `.${path.basename(canonical)}.${journal.transactionId}.displaced`);
  try {
    const latest = await pathState(canonical);
    if (!statesEqual(latest, target.preState)) {
      throw new BlenderInstallError("conflict", `Managed target changed immediately before activation: ${canonical}`);
    }
    if (target.expectedPost.kind === "directory" && target.preState.kind === "directory") {
      if ((await pathState(displaced)).kind !== "absent") throw new BlenderInstallError("conflict", `Displaced target evidence already exists: ${displaced}`);
      await rename(canonical, displaced);
      await syncDirectory(path.dirname(canonical));
      await options.fault?.("after-target-displaced");
    }
    await rename(temporary, canonical);
    await syncDirectory(path.dirname(canonical));
    await options.fault?.("after-target-activated");
    const displacedState = await pathState(displaced);
    if (target.preState.kind !== "absent" && statesEqual(displacedState, target.preState)) await removePath(displaced);
    else if (displacedState.kind !== "absent") throw new BlenderInstallError("conflict", `Displaced target evidence changed: ${displaced}`);
  } finally {
    const temporaryState = await pathState(temporary);
    if (statesEqual(temporaryState, target.expectedPost)) await removePath(temporary);
  }
  journal = await readBlenderInstallJournal(journalPath);
  await writeBlenderInstallJournal(journalPath, { ...journal, updatedAt: new Date().toISOString(), targets: journal.targets.map(candidate =>
    candidate.targetId === target.targetId ? { ...candidate, status: "active" as const } : candidate) });
}
