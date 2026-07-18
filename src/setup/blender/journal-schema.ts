import path from "node:path";
import { z } from "zod";

export const JOURNAL_PHASES = [
  "created",
  "artifacts_verified",
  "runtime_staged",
  "snapshots_complete",
  "credential_active",
  "addon_active",
  "preferences_active",
  "permissions_active",
  "mcp_active",
  "state_active",
  "committed"
] as const;

export const ACTIVATION_PHASES = [
  "credential_active",
  "addon_active",
  "preferences_active",
  "permissions_active",
  "mcp_active",
  "state_active"
] as const;

export const TRANSACTION_FAULT_POINTS = [
  "after-journal-sync",
  "after-backup-sync",
  "before-destructive-transition",
  "after-target-displaced",
  "after-target-activated",
  "after-rollback-displaced",
  "after-rollback-restored"
] as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const canonicalPathSchema = z.string().min(1).refine(
  value => path.isAbsolute(value) && path.resolve(value) === value,
  "path must be absolute and normalized"
);
const timestampSchema = z.string().datetime();
export const profileIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);

export const pathStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }).strict(),
  z.object({ kind: z.literal("file"), sha256: sha256Schema }).strict(),
  z.object({ kind: z.literal("directory"), sha256: sha256Schema }).strict()
]).readonly();

type ParsedPathState = z.infer<typeof pathStateSchema>;

function pathStatesEqual(left: ParsedPathState, right: ParsedPathState): boolean {
  return left.kind === right.kind
    && (!("sha256" in left) || ("sha256" in right && left.sha256 === right.sha256));
}

export const backupStateSchema = z.object({
  canonicalPath: canonicalPathSchema,
  kind: z.enum(["file", "directory"]),
  sha256: sha256Schema
}).strict().readonly();

export const recoveryConflictSchema = z.object({
  canonicalPath: canonicalPathSchema,
  expectedPost: pathStateSchema,
  observed: pathStateSchema,
  evidencePath: canonicalPathSchema,
  reason: z.literal("live-state-mismatch")
}).strict().readonly();

export const blenderInstallTargetSchema = z.object({
  targetId: z.string().regex(/^[a-f0-9]{16}$/u),
  canonicalPath: canonicalPathSchema,
  activationPhase: z.enum(ACTIVATION_PHASES),
  private: z.boolean(),
  status: z.enum(["staged", "snapshotted", "activating", "active", "rolled_back", "recovery_conflict"]),
  requiredPreState: pathStateSchema,
  preState: pathStateSchema.nullable(),
  backup: backupStateSchema.nullable(),
  expectedPost: pathStateSchema,
  conflict: recoveryConflictSchema.nullable()
}).strict().superRefine((target, context) => {
  if ((target.status === "recovery_conflict") !== (target.conflict !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["conflict"],
      message: "conflict data must be present exactly for recovery-conflict targets" });
  }
  if (target.status !== "staged" && target.preState === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["preState"],
      message: "non-staged targets require a pre-state" });
  }
  if (target.status === "staged" && target.preState !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["preState"],
      message: "staged targets cannot have a pre-state" });
  }
  if (target.preState !== null && !pathStatesEqual(target.preState, target.requiredPreState)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["preState"],
      message: "pre-state must equal the required pre-state" });
  }
  if (target.expectedPost.kind === "absent" && target.requiredPreState.kind === "absent") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["requiredPreState"],
      message: "removal targets require a present required pre-state" });
  }
  if (target.preState === null || target.preState.kind === "absent") {
    if (target.backup !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["backup"],
        message: "targets without a present pre-state cannot have a backup" });
    }
  } else if (target.backup === null || target.backup.kind !== target.preState.kind
    || target.backup.sha256 !== target.preState.sha256) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["backup"],
      message: "present pre-state requires a matching backup" });
  }
}).readonly();

export const blenderInstallJournalSchema = z.object({
  schemaVersion: z.literal(1),
  transactionId: z.string().uuid(),
  lockToken: z.string().uuid(),
  profileId: profileIdSchema,
  phase: z.enum(JOURNAL_PHASES),
  status: z.enum(["active", "committed", "rolled_back", "recovery_conflict"]),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  targets: z.array(blenderInstallTargetSchema).readonly()
}).strict().superRefine((journal, context) => {
  if ((journal.phase === "committed") !== (journal.status === "committed")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["status"],
      message: "committed phase and status must occur together" });
  }
  if (journal.status === "committed" && journal.targets.some(target => target.status !== "active")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["targets"],
      message: "committed journals require every target to be active" });
  }
  if (journal.status === "rolled_back" && journal.targets.some(
    target => target.status !== "staged" && target.status !== "rolled_back"
  )) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["targets"],
      message: "rolled-back journals may contain only staged or rolled-back targets" });
  }
  if (journal.status === "recovery_conflict") {
    if (!journal.targets.some(target => target.status === "recovery_conflict")) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["targets"],
        message: "recovery-conflict journals require at least one conflicting target" });
    }
    if (journal.targets.some(target => target.status !== "staged" && target.status !== "rolled_back"
      && target.status !== "recovery_conflict")) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["targets"],
        message: "recovery-conflict journals may contain only terminal rollback target states" });
    }
  }
}).readonly();

export const blenderInstallReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  transactionId: z.string().uuid(),
  profileId: profileIdSchema,
  status: z.enum(["committed", "rolled_back", "recovery_conflict"]),
  completedAt: timestampSchema,
  conflicts: z.array(recoveryConflictSchema).readonly()
}).strict().superRefine((receipt, context) => {
  if (receipt.status === "recovery_conflict" && receipt.conflicts.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["conflicts"],
      message: "recovery-conflict receipts require at least one conflict" });
  }
  if (receipt.status !== "recovery_conflict" && receipt.conflicts.length !== 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["conflicts"],
      message: "committed and rolled-back receipts cannot contain conflicts" });
  }
}).readonly();

export type BlenderInstallJournal = z.infer<typeof blenderInstallJournalSchema>;
export type BlenderInstallReceipt = z.infer<typeof blenderInstallReceiptSchema>;
export type BlenderInstallTarget = z.infer<typeof blenderInstallTargetSchema>;
export type PathState = z.infer<typeof pathStateSchema>;
export type ActivationPhase = (typeof ACTIVATION_PHASES)[number];
export type JournalPhase = (typeof JOURNAL_PHASES)[number];
export type TransactionFaultPoint = (typeof TRANSACTION_FAULT_POINTS)[number];
export type TransactionFaultInjector = (point: TransactionFaultPoint) => void | Promise<void>;
