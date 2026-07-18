import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  snapshotBlenderInstallTargets
} from "../src/setup/blender/journal";

const PROFILE = "removal-profile";

async function removalFixture(kind: "file" | "directory"): Promise<{
  readonly homePath: string;
  readonly targetPath: string;
  readonly journalPath: string;
  readonly preState: Awaited<ReturnType<typeof pathState>>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "strongcode-blender-removal-"));
  const homePath = path.join(root, "home");
  const targetPath = path.join(root, "owned-target");
  await mkdir(homePath);
  if (kind === "file") {
    await writeFile(targetPath, "owned-before\n", "utf8");
  } else {
    await mkdir(targetPath);
    await writeFile(path.join(targetPath, "owned.txt"), "owned-before\n", "utf8");
  }
  const preState = await pathState(targetPath);
  const created = await createBlenderInstallJournal({
    homePath,
    profileId: PROFILE,
    targets: [{ canonicalPath: targetPath, activationPhase: "credential_active", requiredPreState: preState,
      staged: { kind: "absent" } }]
  });
  await advanceBlenderInstallPhase(created.journalPath, "artifacts_verified");
  await advanceBlenderInstallPhase(created.journalPath, "runtime_staged");
  await snapshotBlenderInstallTargets(created.journalPath);
  return { homePath, targetPath, journalPath: created.journalPath, preState };
}

describe("Blender transaction removal targets", () => {
  it.each(["file", "directory"] as const)("commits an exactly owned %s target as absent", async kind => {
    // Given
    const transaction = await removalFixture(kind);

    // When
    await activateBlenderInstallTarget(transaction.journalPath, transaction.targetPath);
    for (const phase of JOURNAL_PHASES.slice(4, -1)) await advanceBlenderInstallPhase(transaction.journalPath, phase);
    const receipt = await commitBlenderInstall(transaction.journalPath);

    // Then
    expect(receipt.status).toBe("committed");
    expect(await pathState(transaction.targetPath)).toEqual({ kind: "absent" });
    const journal = await readBlenderInstallJournal(transaction.journalPath);
    expect(journal.targets[0]).toMatchObject({ expectedPost: { kind: "absent" }, status: "active" });
  });

  it.each(["file", "directory"] as const)("restores exact %s bytes when an active removal rolls back", async kind => {
    // Given
    const transaction = await removalFixture(kind);
    await activateBlenderInstallTarget(transaction.journalPath, transaction.targetPath);

    // When
    const receipt = await rollbackBlenderInstall(transaction.journalPath);

    // Then
    expect(receipt.status).toBe("rolled_back");
    expect(await pathState(transaction.targetPath)).toEqual(transaction.preState);
    const restoredPath = kind === "file" ? transaction.targetPath : path.join(transaction.targetPath, "owned.txt");
    expect(await readFile(restoredPath, "utf8")).toBe("owned-before\n");
  });

  it("rejects a removal plan without an exact present pre-state", async () => {
    // Given
    const root = await mkdtemp(path.join(os.tmpdir(), "strongcode-blender-unowned-removal-"));
    const homePath = path.join(root, "home");
    const targetPath = path.join(root, "unowned-target");
    await mkdir(homePath);

    // When / Then
    await expect(createBlenderInstallJournal({
      homePath,
      profileId: PROFILE,
      targets: [{ canonicalPath: targetPath, activationPhase: "credential_active",
        requiredPreState: { kind: "absent" }, staged: { kind: "absent" } }]
    })).rejects.toThrow(/present pre-state|removal/i);
    expect(await pathState(targetPath)).toEqual({ kind: "absent" });
  });

  it("preserves a concurrent replacement made before removal activation", async () => {
    // Given
    const transaction = await removalFixture("file");
    await writeFile(transaction.targetPath, "concurrent replacement\n", "utf8");

    // When / Then
    await expect(activateBlenderInstallTarget(transaction.journalPath, transaction.targetPath)).rejects.toThrow(/changed before activation/i);
    const receipt = await rollbackBlenderInstall(transaction.journalPath);
    expect(receipt.status).toBe("recovery_conflict");
    expect(await readFile(transaction.targetPath, "utf8")).toBe("concurrent replacement\n");
  });

  it("preserves a concurrent creation made after removal activation", async () => {
    // Given
    const transaction = await removalFixture("directory");
    await activateBlenderInstallTarget(transaction.journalPath, transaction.targetPath);
    await writeFile(transaction.targetPath, "concurrent creation\n", "utf8");

    // When
    const receipt = await rollbackBlenderInstall(transaction.journalPath);

    // Then
    expect(receipt.status).toBe("recovery_conflict");
    expect(await readFile(transaction.targetPath, "utf8")).toBe("concurrent creation\n");
  });
});
