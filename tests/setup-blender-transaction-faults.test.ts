import { lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathState } from "../src/setup/blender/durable-fs";
import {
  acquireBlenderInstallLock,
  activateBlenderInstallTarget,
  advanceBlenderInstallPhase,
  createBlenderInstallJournal,
  recoverBlenderInstallations,
  rollbackBlenderInstall,
  snapshotBlenderInstallTargets,
  type TransactionFaultPoint
} from "../src/setup/blender/journal";

const PROFILE = "fault-profile";

async function paths(prefix: string): Promise<{
  readonly root: string;
  readonly homePath: string;
  readonly targetPath: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const homePath = path.join(root, "home");
  await mkdir(homePath);
  return { root, homePath, targetPath: path.join(root, "target") };
}

async function reachRuntimeStaged(journalPath: string): Promise<void> {
  await advanceBlenderInstallPhase(journalPath, "artifacts_verified");
  await advanceBlenderInstallPhase(journalPath, "runtime_staged");
}

async function removalFixture(kind: "file" | "directory"): Promise<{
  readonly homePath: string;
  readonly journalPath: string;
  readonly targetPath: string;
  readonly preState: Awaited<ReturnType<typeof pathState>>;
}> {
  const fixture = await paths("strongcode-blender-removal-fault-");
  if (kind === "file") {
    await writeFile(fixture.targetPath, "owned-before\n", "utf8");
  } else {
    await mkdir(fixture.targetPath);
    await writeFile(path.join(fixture.targetPath, "owned.txt"), "owned-before\n", "utf8");
  }
  const preState = await pathState(fixture.targetPath);
  const created = await createBlenderInstallJournal({
    homePath: fixture.homePath,
    profileId: PROFILE,
    targets: [{ canonicalPath: fixture.targetPath, activationPhase: "credential_active", requiredPreState: preState,
      staged: { kind: "absent" } }]
  });
  await reachRuntimeStaged(created.journalPath);
  await snapshotBlenderInstallTargets(created.journalPath);
  return { homePath: fixture.homePath, journalPath: created.journalPath, targetPath: fixture.targetPath, preState };
}

function crashAt(faultPoint: TransactionFaultPoint): (point: TransactionFaultPoint) => void {
  return point => {
    if (point === faultPoint) throw new Error(`${faultPoint} crash`);
  };
}

describe("Blender transaction fault boundaries", () => {
  it("recovers a durable journal when creation crashes after journal fsync", async () => {
    // Given
    const fixture = await paths("strongcode-blender-journal-fault-");
    const crash = (point: string): void => { if (point === "after-journal-sync") throw new Error("journal crash"); };

    // When
    await expect(createBlenderInstallJournal({ homePath: fixture.homePath, profileId: PROFILE, targets: [], fault: crash }))
      .rejects.toThrow("journal crash");
    const receipts = await recoverBlenderInstallations({ homePath: fixture.homePath, profileId: PROFILE });
    const lock = await acquireBlenderInstallLock(fixture.homePath, PROFILE);

    // Then
    expect(receipts[0]?.status).toBe("rolled_back");
    await lock.release();
  });

  it("recovers unchanged live state when snapshotting crashes after backup fsync", async () => {
    // Given
    const fixture = await paths("strongcode-blender-backup-fault-");
    await writeFile(fixture.targetPath, "before\n", "utf8");
    const created = await createBlenderInstallJournal({ homePath: fixture.homePath, profileId: PROFILE,
      targets: [{ canonicalPath: fixture.targetPath, activationPhase: "credential_active",
        requiredPreState: await pathState(fixture.targetPath), staged: { kind: "file", content: "after\n" } }] });
    await reachRuntimeStaged(created.journalPath);
    const crash = (point: string): void => { if (point === "after-backup-sync") throw new Error("backup crash"); };

    // When
    await expect(snapshotBlenderInstallTargets(created.journalPath, { fault: crash })).rejects.toThrow("backup crash");
    await expect(acquireBlenderInstallLock(fixture.homePath, PROFILE)).rejects.toThrow(/already running/i);
    const receipts = await recoverBlenderInstallations({ homePath: fixture.homePath, profileId: PROFILE });

    // Then
    expect(receipts[0]?.status).toBe("rolled_back");
    expect(await readFile(fixture.targetPath, "utf8")).toBe("before\n");
  });

  it("restores a directory crash after transaction-owned displacement", async () => {
    // Given
    const fixture = await paths("strongcode-blender-displaced-fault-");
    const sourcePath = path.join(fixture.root, "source");
    await mkdir(fixture.targetPath);
    await mkdir(sourcePath);
    await writeFile(path.join(fixture.targetPath, "old.txt"), "old\n", "utf8");
    await writeFile(path.join(sourcePath, "new.txt"), "new\n", "utf8");
    const created = await createBlenderInstallJournal({ homePath: fixture.homePath, profileId: PROFILE,
      targets: [{ canonicalPath: fixture.targetPath, activationPhase: "credential_active",
        requiredPreState: await pathState(fixture.targetPath), staged: { kind: "directory", sourcePath } }] });
    await reachRuntimeStaged(created.journalPath);
    await snapshotBlenderInstallTargets(created.journalPath);
    const crash = (point: string): void => { if (point === "after-target-displaced") throw new Error("displaced crash"); };

    // When
    await expect(activateBlenderInstallTarget(created.journalPath, fixture.targetPath, { fault: crash })).rejects.toThrow("displaced crash");
    await expect(lstat(fixture.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    const receipts = await recoverBlenderInstallations({ homePath: fixture.homePath, profileId: PROFILE });

    // Then
    expect(receipts[0]?.status).toBe("rolled_back");
    expect(await readFile(path.join(fixture.targetPath, "old.txt"), "utf8")).toBe("old\n");
    await expect(lstat(path.join(fixture.targetPath, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["after-rollback-displaced", "after-rollback-restored"])("resumes directory rollback after %s", async faultPoint => {
    // Given
    const fixture = await paths("strongcode-blender-rollback-fault-");
    const sourcePath = path.join(fixture.root, "source");
    await mkdir(fixture.targetPath);
    await mkdir(sourcePath);
    await writeFile(path.join(fixture.targetPath, "old.txt"), "old\n", "utf8");
    await writeFile(path.join(sourcePath, "new.txt"), "new\n", "utf8");
    const created = await createBlenderInstallJournal({ homePath: fixture.homePath, profileId: PROFILE,
      targets: [{ canonicalPath: fixture.targetPath, activationPhase: "credential_active",
        requiredPreState: await pathState(fixture.targetPath), staged: { kind: "directory", sourcePath } }] });
    await reachRuntimeStaged(created.journalPath);
    await snapshotBlenderInstallTargets(created.journalPath);
    await activateBlenderInstallTarget(created.journalPath, fixture.targetPath);
    const crash = (point: string): void => { if (point === faultPoint) throw new Error("rollback crash"); };

    // When
    await expect(rollbackBlenderInstall(created.journalPath, { fault: crash })).rejects.toThrow("rollback crash");
    if (faultPoint === "after-rollback-displaced") await expect(lstat(fixture.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await readFile(path.join(fixture.targetPath, "old.txt"), "utf8")).toBe("old\n");
    const receipts = await recoverBlenderInstallations({ homePath: fixture.homePath, profileId: PROFILE });

    // Then
    expect(receipts[0]?.status).toBe("rolled_back");
    expect(await readFile(path.join(fixture.targetPath, "old.txt"), "utf8")).toBe("old\n");
    await expect(lstat(path.join(fixture.targetPath, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(path.join(path.dirname(created.journalPath), "rollback-evidence"))).toEqual([]);
  });

  it.each([
    ["file", "before-destructive-transition"],
    ["file", "after-target-displaced"],
    ["file", "after-target-activated"],
    ["directory", "before-destructive-transition"],
    ["directory", "after-target-displaced"],
    ["directory", "after-target-activated"]
  ] as const)("recovers an owned %s removal after %s", async (kind, faultPoint) => {
    // Given
    const fixture = await removalFixture(kind);

    // When
    await expect(activateBlenderInstallTarget(fixture.journalPath, fixture.targetPath, { fault: crashAt(faultPoint) }))
      .rejects.toThrow(`${faultPoint} crash`);
    const receipts = await recoverBlenderInstallations({ homePath: fixture.homePath, profileId: PROFILE });

    // Then
    expect(receipts[0]?.status).toBe("rolled_back");
    expect(await pathState(fixture.targetPath)).toEqual(fixture.preState);
    const restoredPath = kind === "file" ? fixture.targetPath : path.join(fixture.targetPath, "owned.txt");
    expect(await readFile(restoredPath, "utf8")).toBe("owned-before\n");
  });

  it.each(["file", "directory"] as const)("recovers an active %s removal after process loss", async kind => {
    // Given
    const fixture = await removalFixture(kind);
    await activateBlenderInstallTarget(fixture.journalPath, fixture.targetPath);
    expect(await pathState(fixture.targetPath)).toEqual({ kind: "absent" });

    // When
    const receipts = await recoverBlenderInstallations({ homePath: fixture.homePath, profileId: PROFILE });

    // Then
    expect(receipts[0]?.status).toBe("rolled_back");
    expect(await pathState(fixture.targetPath)).toEqual(fixture.preState);
  });

  it.each(["file", "directory"] as const)("resumes %s removal rollback after restored bytes are durable", async kind => {
    // Given
    const fixture = await removalFixture(kind);
    await activateBlenderInstallTarget(fixture.journalPath, fixture.targetPath);

    // When
    await expect(rollbackBlenderInstall(fixture.journalPath, { fault: crashAt("after-rollback-restored") }))
      .rejects.toThrow("after-rollback-restored crash");
    const receipts = await recoverBlenderInstallations({ homePath: fixture.homePath, profileId: PROFILE });

    // Then
    expect(receipts[0]?.status).toBe("rolled_back");
    expect(await pathState(fixture.targetPath)).toEqual(fixture.preState);
  });

  it("preserves a concurrent creation after a removal crashes with displaced evidence", async () => {
    // Given
    const fixture = await removalFixture("file");
    await expect(activateBlenderInstallTarget(fixture.journalPath, fixture.targetPath,
      { fault: crashAt("after-target-displaced") })).rejects.toThrow("after-target-displaced crash");
    await writeFile(fixture.targetPath, "concurrent creation\n", "utf8");

    // When
    const receipts = await recoverBlenderInstallations({ homePath: fixture.homePath, profileId: PROFILE });

    // Then
    expect(receipts[0]?.status).toBe("recovery_conflict");
    expect(await readFile(fixture.targetPath, "utf8")).toBe("concurrent creation\n");
  });
});
