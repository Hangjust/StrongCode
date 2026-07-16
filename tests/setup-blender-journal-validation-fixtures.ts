import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathState } from "../src/setup/blender/durable-fs";
import {
  JOURNAL_PHASES,
  activateBlenderInstallTarget,
  advanceBlenderInstallPhase,
  commitBlenderInstall,
  createBlenderInstallJournal,
  readBlenderInstallJournal,
  rollbackBlenderInstall,
  snapshotBlenderInstallTargets,
  type BlenderInstallJournal
} from "../src/setup/blender/journal";

const PROFILE = "journal-validation";
const fixtureRoots = new Set<string>();

async function fixtureRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  fixtureRoots.add(root);
  return root;
}

export async function cleanupJournalValidationFixtures(): Promise<void> {
  for (const root of [...fixtureRoots]) {
    await rm(root, { recursive: true, force: true });
    fixtureRoots.delete(root);
  }
}

async function preparedJournal(initialContent?: string) {
  const root = await fixtureRoot("strongcode-journal-validation-");
  const homePath = path.join(root, "home");
  const targetPath = path.join(root, "managed.txt");
  await mkdir(homePath);
  if (initialContent !== undefined) await writeFile(targetPath, initialContent, "utf8");
  const created = await createBlenderInstallJournal({
    homePath,
    profileId: PROFILE,
    targets: [{
      canonicalPath: targetPath,
      activationPhase: "credential_active",
      requiredPreState: await pathState(targetPath),
      staged: { kind: "file", content: "managed\n" }
    }]
  });
  await advanceBlenderInstallPhase(created.journalPath, "artifacts_verified");
  await advanceBlenderInstallPhase(created.journalPath, "runtime_staged");
  await snapshotBlenderInstallTargets(created.journalPath);
  return { ...created, homePath, targetPath };
}

export async function committedJournal() {
  const prepared = await preparedJournal("before\n");
  await activateBlenderInstallTarget(prepared.journalPath, prepared.targetPath);
  for (const phase of JOURNAL_PHASES.slice(4, -1)) {
    await advanceBlenderInstallPhase(prepared.journalPath, phase);
  }
  const receipt = await commitBlenderInstall(prepared.journalPath);
  return { journal: await readBlenderInstallJournal(prepared.journalPath), receipt };
}

export async function rolledBackJournal(initialContent?: string) {
  const prepared = await preparedJournal(initialContent);
  const receipt = await rollbackBlenderInstall(prepared.journalPath);
  return { journal: await readBlenderInstallJournal(prepared.journalPath), receipt };
}

export async function stagedRollbackJournal() {
  const root = await fixtureRoot("strongcode-staged-rollback-");
  const homePath = path.join(root, "home");
  const targetPath = path.join(root, "managed.txt");
  await mkdir(homePath);
  const created = await createBlenderInstallJournal({
    homePath,
    profileId: PROFILE,
    targets: [{ canonicalPath: targetPath, activationPhase: "credential_active",
      requiredPreState: { kind: "absent" }, staged: { kind: "file", content: "managed\n" } }]
  });
  const receipt = await rollbackBlenderInstall(created.journalPath);
  return { journal: await readBlenderInstallJournal(created.journalPath), receipt };
}

export async function conflictJournal() {
  const prepared = await preparedJournal("before\n");
  await activateBlenderInstallTarget(prepared.journalPath, prepared.targetPath);
  await writeFile(prepared.targetPath, "concurrent\n", "utf8");
  const receipt = await rollbackBlenderInstall(prepared.journalPath);
  return { journal: await readBlenderInstallJournal(prepared.journalPath), receipt };
}

export async function conflictJournalWithResolvedTarget(): Promise<BlenderInstallJournal> {
  const root = await fixtureRoot("strongcode-mixed-conflict-");
  const homePath = path.join(root, "home");
  const firstPath = path.join(root, "first.txt");
  const secondPath = path.join(root, "second.txt");
  await mkdir(homePath);
  await writeFile(firstPath, "first-before\n", "utf8");
  await writeFile(secondPath, "second-before\n", "utf8");
  const created = await createBlenderInstallJournal({
    homePath,
    profileId: PROFILE,
    targets: [
      { canonicalPath: firstPath, activationPhase: "credential_active", requiredPreState: await pathState(firstPath),
        staged: { kind: "file", content: "first-managed\n" } },
      { canonicalPath: secondPath, activationPhase: "credential_active", requiredPreState: await pathState(secondPath),
        staged: { kind: "file", content: "second-managed\n" } }
    ]
  });
  await advanceBlenderInstallPhase(created.journalPath, "artifacts_verified");
  await advanceBlenderInstallPhase(created.journalPath, "runtime_staged");
  await snapshotBlenderInstallTargets(created.journalPath);
  await activateBlenderInstallTarget(created.journalPath, firstPath);
  await activateBlenderInstallTarget(created.journalPath, secondPath);
  await writeFile(firstPath, "concurrent\n", "utf8");
  await rollbackBlenderInstall(created.journalPath);
  return readBlenderInstallJournal(created.journalPath);
}

export async function zeroTargetJournal() {
  const root = await fixtureRoot("strongcode-zero-target-");
  const homePath = path.join(root, "home");
  await mkdir(homePath);
  return createBlenderInstallJournal({ homePath, profileId: PROFILE, targets: [] });
}
