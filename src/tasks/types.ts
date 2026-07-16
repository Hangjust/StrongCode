import { z } from "zod";

export const TASK_STATUSES = [
  "queued",
  "running",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted"
] as const;

export const NONTERMINAL_TASK_STATUSES = ["queued", "running", "blocked"] as const;

const safeIdentifierSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._-]+$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });

export const taskIdSchema = z.string().regex(
  /^task-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  "Task id must use the canonical task-<uuid> form"
);

export const taskStatusSchema = z.enum(TASK_STATUSES);

export const taskTargetSchema = z.object({
  class: z.enum(["helper", "specialist"]),
  id: safeIdentifierSchema
}).strict();

export const taskSkillReceiptSchema = z.object({
  id: safeIdentifierSchema,
  path: z.string().min(1).max(4_096),
  hash: sha256Schema
}).strict();

export const taskTimestampsSchema = z.object({
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  startedAt: timestampSchema.optional(),
  completedAt: timestampSchema.optional()
}).strict();

export const taskResultMetadataSchema = z.object({
  summary: z.string().max(12_000),
  outputChars: z.number().int().nonnegative().max(1_000_000_000),
  truncated: z.boolean()
}).strict();

export const taskErrorSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  message: z.string().min(1).max(4_096)
}).strict();

export const taskRecordSchema = z.object({
  id: taskIdSchema,
  childSessionId: safeIdentifierSchema,
  parentSessionId: safeIdentifierSchema,
  rootSessionId: safeIdentifierSchema,
  target: taskTargetSchema,
  attempt: z.number().int().positive().max(100),
  depth: z.number().int().nonnegative().max(16),
  mode: z.enum(["foreground", "background"]),
  model: z.string().min(1).max(256).optional(),
  effectivePolicyHash: sha256Schema,
  skillReceipts: z.array(taskSkillReceiptSchema).max(8),
  ownedPaths: z.array(z.string().min(1).max(4_096)).max(256),
  timestamps: taskTimestampsSchema,
  status: taskStatusSchema,
  resultMetadata: taskResultMetadataSchema.optional(),
  artifactPointer: z.string().min(1).max(4_096).optional(),
  error: taskErrorSchema.optional()
}).strict().superRefine((record, context) => {
  if (record.timestamps.startedAt !== undefined && record.model === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["model"],
      message: "Started task records require a selected model"
    });
  }
});

export type TaskId = z.infer<typeof taskIdSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type TaskRecord = Readonly<z.infer<typeof taskRecordSchema>>;

export function parseTaskRecord(value: unknown): TaskRecord {
  return taskRecordSchema.parse(value);
}
