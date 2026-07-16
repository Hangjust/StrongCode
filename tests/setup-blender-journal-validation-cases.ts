import {
  JOURNAL_PHASES,
  advanceBlenderInstallPhase,
  blenderInstallJournalSchema,
  blenderInstallReceiptSchema,
  commitBlenderInstall,
  readBlenderInstallJournal,
  rollbackBlenderInstall,
  type BlenderInstallJournal,
  type BlenderInstallTarget
} from "../src/setup/blender/journal";
import {
  cleanupJournalValidationFixtures,
  committedJournal,
  conflictJournal,
  conflictJournalWithResolvedTarget,
  rolledBackJournal,
  stagedRollbackJournal,
  zeroTargetJournal
} from "./setup-blender-journal-validation-fixtures";

afterEach(cleanupJournalValidationFixtures);

const NON_TERMINAL_TARGET_STATUSES: readonly BlenderInstallTarget["status"][] = [
  "active",
  "snapshotted",
  "activating"
];

function onlyTarget(journal: BlenderInstallJournal): BlenderInstallTarget {
  const target = journal.targets[0];
  if (!target) throw new Error("production journal target is required");
  return target;
}

describe("Blender terminal journal semantic validation", () => {
  it("rejects committed status before the committed phase", async () => {
    const created = await zeroTargetJournal();
    await rollbackBlenderInstall(created.journalPath);
    const journal = await readBlenderInstallJournal(created.journalPath);

    const result = blenderInstallJournalSchema.safeParse({ ...journal, status: "committed" });

    expect(result.success).toBe(false);
  });

  it("rejects committed phase without committed status", async () => {
    const created = await zeroTargetJournal();
    for (const phase of JOURNAL_PHASES.slice(1, -1)) await advanceBlenderInstallPhase(created.journalPath, phase);
    await commitBlenderInstall(created.journalPath);
    const journal = await readBlenderInstallJournal(created.journalPath);

    const result = blenderInstallJournalSchema.safeParse({ ...journal, status: "rolled_back" });

    expect(result.success).toBe(false);
  });

  it("rejects a committed journal with a non-active target", async () => {
    const { journal } = await committedJournal();
    const target = onlyTarget(journal);

    const result = blenderInstallJournalSchema.safeParse({
      ...journal,
      targets: [{ ...target, status: "rolled_back" }]
    });

    expect(result.success).toBe(false);
  });

  it.each(NON_TERMINAL_TARGET_STATUSES)(
    "rejects a rolled-back journal with a %s target",
    async status => {
      const { journal } = await rolledBackJournal("before\n");
      const target = onlyTarget(journal);

      const result = blenderInstallJournalSchema.safeParse({ ...journal, targets: [{ ...target, status }] });

      expect(result.success).toBe(false);
    }
  );

  it("rejects a rolled-back journal with a coherent recovery-conflict target", async () => {
    const journal = await conflictJournalWithResolvedTarget();

    const result = blenderInstallJournalSchema.safeParse({ ...journal, status: "rolled_back" });

    expect(result.success).toBe(false);
  });

  it("accepts a production early rollback that retains an unsnapshotted staged target", async () => {
    const { journal } = await stagedRollbackJournal();

    const result = blenderInstallJournalSchema.safeParse(journal);

    expect(result.success).toBe(true);
    expect(onlyTarget(journal).status).toBe("staged");
  });

  it("rejects recovery-conflict status without a conflicting target", async () => {
    const { journal } = await stagedRollbackJournal();

    const result = blenderInstallJournalSchema.safeParse({ ...journal, status: "recovery_conflict" });

    expect(result.success).toBe(false);
  });

  it("rejects a recovery-conflict journal with a non-terminal target", async () => {
    const journal = await conflictJournalWithResolvedTarget();
    const resolved = journal.targets.find(target => target.status === "rolled_back");
    if (!resolved) throw new Error("production rollback must resolve one target");

    const result = blenderInstallJournalSchema.safeParse({ ...journal, targets: journal.targets.map(target =>
      target.targetId === resolved.targetId ? { ...target, status: "active" } satisfies BlenderInstallTarget : target) });

    expect(result.success).toBe(false);
  });

  it("rejects a recovery-conflict target without conflict data", async () => {
    const { journal } = await conflictJournal();
    const target = onlyTarget(journal);

    const result = blenderInstallJournalSchema.safeParse({ ...journal, targets: [{ ...target, conflict: null }] });

    expect(result.success).toBe(false);
  });

  it("rejects conflict data on a non-conflicting target", async () => {
    const rolledBack = await rolledBackJournal("before\n");
    const conflicted = await conflictJournal();
    const conflict = conflicted.receipt.conflicts[0];
    if (!conflict) throw new Error("production conflict receipt is required");

    const result = blenderInstallJournalSchema.safeParse({ ...rolledBack.journal,
      targets: [{ ...onlyTarget(rolledBack.journal), conflict }] });

    expect(result.success).toBe(false);
  });

  it("rejects a non-staged target without a pre-state", async () => {
    const { journal } = await rolledBackJournal();
    const target = onlyTarget(journal);

    const result = blenderInstallJournalSchema.safeParse({ ...journal, targets: [{ ...target, preState: null }] });

    expect(result.success).toBe(false);
  });

  it("rejects a staged target with production pre-state and backup data", async () => {
    const { journal } = await rolledBackJournal("before\n");
    const target = onlyTarget(journal);

    const result = blenderInstallJournalSchema.safeParse({
      ...journal,
      targets: [{ ...target, status: "staged" }]
    });

    expect(result.success).toBe(false);
  });

  it("rejects a present pre-state that differs from the required pre-state", async () => {
    const { journal } = await rolledBackJournal("before\n");
    const target = onlyTarget(journal);

    const result = blenderInstallJournalSchema.safeParse({ ...journal,
      targets: [{ ...target, requiredPreState: { kind: "absent" } }] });

    expect(result.success).toBe(false);
  });

  it("rejects backup data for an absent pre-state", async () => {
    const absent = await rolledBackJournal();
    const present = await rolledBackJournal("before\n");
    const backup = onlyTarget(present.journal).backup;
    if (!backup) throw new Error("production backup is required");

    const result = blenderInstallJournalSchema.safeParse({ ...absent.journal,
      targets: [{ ...onlyTarget(absent.journal), backup }] });

    expect(result.success).toBe(false);
  });

  it("rejects a missing backup for a non-absent pre-state", async () => {
    const { journal } = await rolledBackJournal("before\n");
    const target = onlyTarget(journal);

    const result = blenderInstallJournalSchema.safeParse({ ...journal, targets: [{ ...target, backup: null }] });

    expect(result.success).toBe(false);
  });

  it("rejects conflicts on committed and rolled-back receipts", async () => {
    const committed = await committedJournal();
    const rolledBack = await rolledBackJournal("before\n");
    const conflicted = await conflictJournal();

    const committedResult = blenderInstallReceiptSchema.safeParse({ ...committed.receipt,
      conflicts: conflicted.receipt.conflicts });
    const rolledBackResult = blenderInstallReceiptSchema.safeParse({ ...rolledBack.receipt,
      conflicts: conflicted.receipt.conflicts });

    expect(committedResult.success).toBe(false);
    expect(rolledBackResult.success).toBe(false);
  });

  it("rejects a recovery-conflict receipt without conflicts", async () => {
    const { receipt } = await conflictJournal();

    const result = blenderInstallReceiptSchema.safeParse({ ...receipt, conflicts: [] });

    expect(result.success).toBe(false);
  });
});
