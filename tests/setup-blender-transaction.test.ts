import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathState } from "../src/setup/blender/durable-fs";
import {
  JOURNAL_PHASES,
  acquireBlenderInstallLock,
  activateBlenderInstallTarget,
  advanceBlenderInstallPhase,
  blenderInstallJournalSchema,
  blenderInstallReceiptSchema,
  commitBlenderInstall,
  createBlenderInstallJournal,
  inspectBlenderInstallLock,
  readBlenderInstallJournal,
  recoverBlenderInstallations,
  rollbackBlenderInstall,
  snapshotBlenderInstallTargets
} from "../src/setup/blender/journal";
import {
  protectPrivateFile,
  writePrivateFile,
  type PrivateFileProcessAdapter,
  type PrivateFileProcessRequest
} from "../src/setup/blender/private-files";
import "./setup-blender-journal-validation-cases";

const PROFILE = "blender-4.3";

async function fixture(prefix: string): Promise<{ readonly homePath: string; readonly targetPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const homePath = path.join(root, "home");
  await mkdir(homePath);
  return { homePath, targetPath: path.join(root, "managed.json") };
}

async function journalWithFile(
  content: string,
  options: { readonly phase?: "credential_active" | "addon_active"; readonly fault?: (point: string) => void } = {}
): Promise<{ readonly homePath: string; readonly targetPath: string; readonly journalPath: string }> {
  const { homePath, targetPath } = await fixture("strongcode-blender-transaction-");
  await writeFile(targetPath, "user-before\n", "utf8");
  const created = await createBlenderInstallJournal({
    homePath,
    profileId: PROFILE,
    targets: [{ canonicalPath: targetPath, activationPhase: options.phase ?? "credential_active",
      requiredPreState: await pathState(targetPath), staged: { kind: "file", content } }],
    fault: options.fault
  });
  await advanceBlenderInstallPhase(created.journalPath, "artifacts_verified");
  await advanceBlenderInstallPhase(created.journalPath, "runtime_staged");
  await snapshotBlenderInstallTargets(created.journalPath, { fault: options.fault });
  return { homePath, targetPath, journalPath: created.journalPath };
}

describe("durable Blender installation transactions", () => {
  it("uses strict schemas and the complete ordered phase contract", async () => {
    // Given
    const transaction = await journalWithFile("managed\n");
    const journal = await readBlenderInstallJournal(transaction.journalPath);

    // When
    const journalResult = blenderInstallJournalSchema.safeParse({ ...journal, secret: "must-not-serialize" });
    const missingPreStateResult = blenderInstallJournalSchema.safeParse({
      ...journal,
      targets: journal.targets.map(({ requiredPreState: _requiredPreState, ...target }) => target)
    });
    const receiptResult = blenderInstallReceiptSchema.safeParse({ schemaVersion: 1, transactionId: journal.transactionId,
      profileId: PROFILE, status: "committed", completedAt: new Date().toISOString(), conflicts: [], extra: true });

    // Then
    expect(JOURNAL_PHASES).toEqual(["created", "artifacts_verified", "runtime_staged", "snapshots_complete",
      "credential_active", "addon_active", "preferences_active", "permissions_active", "mcp_active", "state_active", "committed"]);
    expect(journal.targets[0]).toMatchObject({ canonicalPath: path.resolve(transaction.targetPath),
      preState: { kind: "file" }, backup: { kind: "file" }, expectedPost: { kind: "file" }, status: "snapshotted" });
    expect(journalResult.success).toBe(false);
    expect(missingPreStateResult.success).toBe(false);
    expect(receiptResult.success).toBe(false);
    expect(JSON.stringify(journal)).not.toContain("managed\\n");
  });

  it("holds an exclusive lock per StrongCode home and profile", async () => {
    // Given
    const { homePath } = await fixture("strongcode-blender-lock-");
    const first = await acquireBlenderInstallLock(homePath, PROFILE);

    // When / Then
    await expect(acquireBlenderInstallLock(homePath, PROFILE)).rejects.toThrow(/already running|lock/i);
    const otherProfile = await acquireBlenderInstallLock(homePath, "blender-4.4");
    await otherProfile.release();
    await first.release();
    await writeFile(first.path, `${JSON.stringify({ token: "00000000-0000-4000-8000-000000000000", profileId: PROFILE,
      pid: 2_147_483_646, createdAt: new Date().toISOString() })}\n`, "utf8");
    const reacquired = await acquireBlenderInstallLock(homePath, PROFILE);
    await reacquired.release();
    await writeFile(first.path, `${JSON.stringify({ token: "00000000-0000-4000-8000-000000000001", profileId: PROFILE,
      pid: process.pid, createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() })}\n`, "utf8");
    const ageReclaimed = await acquireBlenderInstallLock(homePath, PROFILE);
    await ageReclaimed.release();
    await writeFile(first.path, `${JSON.stringify({ token: "00000000-0000-4000-8000-000000000002", profileId: PROFILE,
      pid: process.pid, createdAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString() })}\n`, "utf8");
    const futureReclaimed = await acquireBlenderInstallLock(homePath, PROFILE);
    await futureReclaimed.release();
  });

  it("inspects lock presence without creating or parsing the lock", async () => {
    // Given
    const { homePath } = await fixture("strongcode-blender-lock-inspection-");
    const lockName = createHash("sha256").update(PROFILE).digest("hex").slice(0, 24);
    const lockPath = path.join(homePath, "locks", `blender-install-${lockName}.lock`);

    // When
    const absent = await inspectBlenderInstallLock(homePath, PROFILE);
    await expect(lstat(path.dirname(lockPath))).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(path.dirname(lockPath));
    await writeFile(lockPath, "malformed lock bytes\n", "utf8");
    const present = await inspectBlenderInstallLock(homePath, PROFILE);

    // Then
    expect(absent).toEqual({ kind: "absent", path: lockPath });
    expect(present).toEqual({ kind: "present", path: lockPath });
    expect(await readFile(lockPath, "utf8")).toBe("malformed lock bytes\n");
  });

  it("restores an activated transaction-owned post-state in reverse rollback", async () => {
    // Given
    const transaction = await journalWithFile("managed\n");
    await activateBlenderInstallTarget(transaction.journalPath, transaction.targetPath);

    // When
    const receipt = await rollbackBlenderInstall(transaction.journalPath);

    // Then
    expect(receipt.status).toBe("rolled_back");
    expect(await readFile(transaction.targetPath, "utf8")).toBe("user-before\n");
  });

  it("preserves a concurrent edit and records an explicit recovery conflict", async () => {
    // Given
    const transaction = await journalWithFile("managed\n");
    await activateBlenderInstallTarget(transaction.journalPath, transaction.targetPath);
    await writeFile(transaction.targetPath, "concurrent-user-edit\n", "utf8");

    // When
    const receipt = await rollbackBlenderInstall(transaction.journalPath);

    // Then
    expect(receipt.status).toBe("recovery_conflict");
    expect(receipt.conflicts).toHaveLength(1);
    expect(await readFile(transaction.targetPath, "utf8")).toBe("concurrent-user-edit\n");
    expect(await readFile(transaction.journalPath, "utf8")).not.toContain("concurrent-user-edit");
    for (let index = 0; index < 6; index += 1) {
      const created = await createBlenderInstallJournal({ homePath: transaction.homePath, profileId: PROFILE, targets: [] });
      for (const phase of JOURNAL_PHASES.slice(1, -1)) await advanceBlenderInstallPhase(created.journalPath, phase);
      await commitBlenderInstall(created.journalPath);
    }
    expect((await readdir(path.dirname(path.dirname(transaction.journalPath)))).length).toBe(6);
    expect((await lstat(transaction.journalPath)).isFile()).toBe(true);
  });

  it("refuses commit when an active target no longer matches its expected post-state", async () => {
    // Given
    const transaction = await journalWithFile("managed\n");
    await activateBlenderInstallTarget(transaction.journalPath, transaction.targetPath);
    for (const phase of JOURNAL_PHASES.slice(4, -1)) await advanceBlenderInstallPhase(transaction.journalPath, phase);
    await writeFile(transaction.targetPath, "concurrent post-activation edit\n", "utf8");

    // When / Then
    await expect(commitBlenderInstall(transaction.journalPath)).rejects.toThrow(/changed before commit|live-state/i);
    const receipt = await rollbackBlenderInstall(transaction.journalPath);
    expect(receipt.status).toBe("recovery_conflict");
    expect(await readFile(transaction.targetPath, "utf8")).toBe("concurrent post-activation edit\n");
  });

  it("rejects a planned config target changed before its transaction snapshot", async () => {
    // Given
    const { homePath, targetPath } = await fixture("strongcode-blender-required-prestate-");
    await writeFile(targetPath, "planned-before\n", "utf8");
    const created = await createBlenderInstallJournal({
      homePath,
      profileId: PROFILE,
      targets: [{
        canonicalPath: targetPath,
        activationPhase: "mcp_active",
        requiredPreState: { kind: "file", sha256: createHash("sha256").update("planned-before\n").digest("hex") },
        staged: { kind: "file", content: "managed-after\n" }
      }]
    });
    await advanceBlenderInstallPhase(created.journalPath, "artifacts_verified");
    await advanceBlenderInstallPhase(created.journalPath, "runtime_staged");
    await writeFile(targetPath, "concurrent-edit\n", "utf8");

    // When / Then
    await expect(snapshotBlenderInstallTargets(created.journalPath)).rejects.toThrow(/changed after planning/i);
    expect(await readFile(targetPath, "utf8")).toBe("concurrent-edit\n");
    await rollbackBlenderInstall(created.journalPath);
  });

  it("activates and rolls back an initially absent directory target", async () => {
    // Given
    const { homePath, targetPath } = await fixture("strongcode-blender-directory-");
    const sourcePath = path.join(path.dirname(targetPath), "runtime-source");
    await mkdir(sourcePath);
    await writeFile(path.join(sourcePath, "runtime.py"), "managed-runtime\n", "utf8");
    const created = await createBlenderInstallJournal({ homePath, profileId: PROFILE,
      targets: [{ canonicalPath: targetPath, activationPhase: "addon_active", requiredPreState: { kind: "absent" },
        staged: { kind: "directory", sourcePath } }] });
    await advanceBlenderInstallPhase(created.journalPath, "artifacts_verified");
    await advanceBlenderInstallPhase(created.journalPath, "runtime_staged");
    await snapshotBlenderInstallTargets(created.journalPath);

    // When
    await expect(activateBlenderInstallTarget(created.journalPath, targetPath)).rejects.toThrow(/out of phase/i);
    await advanceBlenderInstallPhase(created.journalPath, "credential_active");
    const crash = (point: string): void => { if (point === "after-target-activated") throw new Error("directory crash"); };
    await expect(activateBlenderInstallTarget(created.journalPath, targetPath, { fault: crash })).rejects.toThrow("directory crash");
    const active = await readFile(path.join(targetPath, "runtime.py"), "utf8");
    const receipts = await recoverBlenderInstallations({ homePath, profileId: PROFILE });
    const journal = await readBlenderInstallJournal(created.journalPath);
    const displaced = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${journal.transactionId}.displaced`);

    // Then
    expect(active).toBe("managed-runtime\n");
    expect(receipts[0]?.status).toBe("rolled_back");
    await expect(lstat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(displaced)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["before-destructive-transition", "after-target-activated"])("recovers a crash injected at %s", async faultPoint => {
    // Given
    const crash = (point: string): void => {
      if (point === faultPoint) throw new Error("injected crash");
    };
    const transaction = await journalWithFile("managed-after-crash\n", { fault: crash });
    await expect(activateBlenderInstallTarget(transaction.journalPath, transaction.targetPath, { fault: crash })).rejects.toThrow("injected crash");

    // When
    const receipts = await recoverBlenderInstallations({ homePath: transaction.homePath, profileId: PROFILE });

    // Then
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.status).toBe("rolled_back");
    expect(await readFile(transaction.targetPath, "utf8")).toBe("user-before\n");
  });

  it("rejects symlink staging and path-type changes", async () => {
    // Given
    const { homePath, targetPath } = await fixture("strongcode-blender-types-");
    const source = path.join(path.dirname(targetPath), "source");
    const linkedDirectory = path.join(path.dirname(targetPath), "linked-directory");
    await mkdir(source);
    await mkdir(linkedDirectory);
    await symlink(linkedDirectory, path.join(source, "escape"), "junction");

    // When / Then
    await expect(createBlenderInstallJournal({ homePath, profileId: PROFILE,
      targets: [{ canonicalPath: targetPath, activationPhase: "addon_active", requiredPreState: { kind: "absent" },
        staged: { kind: "directory", sourcePath: source } }] }))
      .rejects.toThrow(/symlink/i);
    await writeFile(targetPath, "file-before\n", "utf8");
    const cleanSource = path.join(path.dirname(targetPath), "clean-source");
    await mkdir(cleanSource);
    await expect(createBlenderInstallJournal({ homePath, profileId: PROFILE,
      targets: [{ canonicalPath: targetPath, activationPhase: "addon_active", requiredPreState: await pathState(targetPath),
        staged: { kind: "directory", sourcePath: cleanSource } }] }))
      .rejects.toThrow(/path type|type change/i);
  });

});

describe("Blender private files", () => {
  it("writes a private regular file with mode 0600 and the current POSIX uid", async () => {
    // Given
    const { targetPath } = await fixture("strongcode-blender-private-");

    // When
    await writePrivateFile(targetPath, "private-value\n");
    const stats = await lstat(targetPath);

    // Then
    expect(await readFile(targetPath, "utf8")).toBe("private-value\n");
    if (process.platform !== "win32") {
      const uid = process.getuid?.();
      expect(stats.mode & 0o777).toBe(0o600);
      expect(uid).toBeDefined();
      expect(stats.uid).toBe(uid);
    }
  });

  it("uses fixed System32 binaries without a shell or secret-bearing arguments on Windows", async () => {
    // Given
    const { targetPath } = await fixture("strongcode-blender-acl-");
    await writeFile(targetPath, "private-value\n", "utf8");
    await chmod(targetPath, 0o600);
    const requests: PrivateFileProcessRequest[] = [];
    const adapter: PrivateFileProcessAdapter = { run: async request => {
      requests.push(request);
      return request.executable.endsWith("whoami.exe")
        ? { exitCode: 0, stdout: '"user","S-1-5-21-1-2-3-1001"\r\n', stderr: "" }
        : { exitCode: 0, stdout: "processed", stderr: "" };
    } };

    // When
    await protectPrivateFile(targetPath, { platform: "win32", systemRoot: "C:\\Windows", process: adapter });

    // Then
    expect(requests.map(request => request.executable)).toEqual([
      path.win32.join("C:\\Windows", "System32", "whoami.exe"), path.win32.join("C:\\Windows", "System32", "icacls.exe"),
      path.win32.join("C:\\Windows", "System32", "icacls.exe")]);
    expect(requests.every(request => request.shell === false)).toBe(true);
    expect(requests.flatMap(request => request.args)).not.toContain("private-value");
  });
});
