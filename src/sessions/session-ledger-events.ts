import { randomUUID } from "node:crypto";
import { z } from "zod";
import { summaryResultSchema } from "../agents/preflight/contracts";
import {
  contextMetadataSchema,
  metadataProvenanceSchema,
  modelMetadataSchema,
  normalizedUsageSchema,
  attemptRoleSchema
} from "../agents/preflight/metadata";
import { modelReferenceSchema, preflightIdSchema } from "../agents/preflight/text";

const canonicalTimestampSchema = z.string().datetime({ offset: true }).refine(
  value => new Date(value).toISOString() === value,
  "Timestamp must be canonical UTC ISO"
);
const reasonCodeSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const amountSchema = z.number().nonnegative().finite();
const currencySchema = z.string().regex(/^[A-Z]{3}$/);
const envelope = {
  version: z.literal(1),
  eventId: preflightIdSchema,
  timestamp: canonicalTimestampSchema
} as const;

export const persistedModelMetadataSchema = modelMetadataSchema.unwrap().extend({
  providerRef: modelReferenceSchema
}).strict().readonly();

const providerUsageMetricSchema = z.object({
  source: z.literal("provider-reported"),
  provider: z.string().min(1),
  field: z.string().min(1),
  category: z.enum(["input", "output", "reasoning", "cache-read", "cache-write", "total", "provider-specific"]),
  tokens: z.number().int().nonnegative().safe(),
  semantics: z.enum([
    "exclusive", "input-includes-cache", "input-overlap", "output-includes-reasoning",
    "output-subset", "reported-total", "gemini-tool-use-prompt", "vertex-tool-execution-result-input"
  ])
}).strict().readonly();

const providerReportedCostSchema = z.object({
  kind: z.literal("provider-reported"),
  amount: amountSchema,
  currency: currencySchema.optional()
}).strict();
const estimatedCostSchema = z.object({
  kind: z.literal("estimated"),
  amount: amountSchema,
  currency: currencySchema,
  pricingVersion: z.string().min(1)
}).strict();

export const summaryReservedEventSchema = z.object({
  type: z.literal("summary_reserved"), ...envelope,
  reservationId: preflightIdSchema,
  logicalOperationId: preflightIdSchema,
  sourceMessageId: preflightIdSchema,
  originalPrompt: z.string().min(1).refine(value => value.trim().length > 0, "Original prompt must be meaningful")
}).strict().readonly();
export const summaryCommittedEventSchema = z.object({
  type: z.literal("summary_committed"), ...envelope,
  reservationId: preflightIdSchema,
  attemptId: preflightIdSchema,
  result: summaryResultSchema
}).strict().readonly();
export const summaryFailedOpenEventSchema = z.object({
  type: z.literal("summary_failed_open"), ...envelope,
  reservationId: preflightIdSchema,
  reasonCode: reasonCodeSchema
}).strict().readonly();
export const summaryCancelledEventSchema = z.object({
  type: z.literal("summary_cancelled"), ...envelope,
  reservationId: preflightIdSchema,
  reasonCode: reasonCodeSchema
}).strict().readonly();
export const attemptCreatedEventSchema = z.object({
  type: z.literal("attempt_created"), ...envelope,
  attemptId: preflightIdSchema,
  logicalOperationId: preflightIdSchema,
  role: attemptRoleSchema,
  model: persistedModelMetadataSchema,
  context: contextMetadataSchema.optional(),
  parentAttemptId: preflightIdSchema.optional(),
  forkedFromAttemptId: preflightIdSchema.optional()
}).strict().readonly();

export const attemptTransitionSchema = z.union([
  z.object({ kind: z.literal("started") }).strict(),
  z.object({ kind: z.literal("validation_failed"), code: reasonCodeSchema }).strict(),
  z.object({ kind: z.literal("cancelled"), code: reasonCodeSchema }).strict(),
  z.object({ kind: z.literal("ended"), outcome: z.literal("succeeded") }).strict(),
  z.object({ kind: z.literal("ended"), outcome: z.literal("failed"), code: reasonCodeSchema }).strict()
]).readonly();
export const attemptLifecycleEventSchema = z.object({
  type: z.literal("attempt_lifecycle"), ...envelope,
  attemptId: preflightIdSchema,
  transition: attemptTransitionSchema
}).strict().readonly();
export const attemptUsageEventSchema = z.object({
  type: z.literal("attempt_usage"), ...envelope,
  attemptId: preflightIdSchema,
  providerRef: modelReferenceSchema,
  modelRef: modelReferenceSchema,
  scope: z.literal("exclusive"),
  usage: normalizedUsageSchema.optional(),
  usageProvenance: metadataProvenanceSchema.optional(),
  providerUsage: z.array(providerUsageMetricSchema).min(1).readonly().optional(),
  providerRequestId: z.string().min(1).optional(),
  providerResponseId: z.string().min(1).optional(),
  cost: z.discriminatedUnion("kind", [providerReportedCostSchema, estimatedCostSchema]).optional()
}).strict().superRefine((event, context) => {
  if (event.usage === undefined !== (event.usageProvenance === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Usage and usage provenance must appear together" });
  }
  if (event.usage === undefined && event.providerUsage === undefined && event.cost === undefined
    && event.providerRequestId === undefined && event.providerResponseId === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Attempt usage requires usage, provider identity, or cost" });
  }
}).readonly();

export const sessionLedgerEventSchema = z.union([
  summaryReservedEventSchema, summaryCommittedEventSchema, summaryFailedOpenEventSchema,
  summaryCancelledEventSchema, attemptCreatedEventSchema, attemptLifecycleEventSchema,
  attemptUsageEventSchema
]).readonly();

export type SummaryReservedEvent = z.infer<typeof summaryReservedEventSchema>;
export type SummaryCommittedEvent = z.infer<typeof summaryCommittedEventSchema>;
export type SummaryFailedOpenEvent = z.infer<typeof summaryFailedOpenEventSchema>;
export type SummaryCancelledEvent = z.infer<typeof summaryCancelledEventSchema>;
export type AttemptCreatedEvent = z.infer<typeof attemptCreatedEventSchema>;
export type AttemptTransition = z.infer<typeof attemptTransitionSchema>;
export type AttemptLifecycleEvent = z.infer<typeof attemptLifecycleEventSchema>;
export type AttemptUsageEvent = z.infer<typeof attemptUsageEventSchema>;
export type SessionLedgerEvent = z.infer<typeof sessionLedgerEventSchema>;
export type LedgerCommitEvent = Exclude<SessionLedgerEvent, SummaryReservedEvent>;

export function parseSessionLedgerEvent(input: unknown): SessionLedgerEvent {
  return sessionLedgerEventSchema.parse(input);
}

type EventInput<S extends z.ZodTypeAny> = Omit<z.input<S>, "type" | "version" | "eventId" | "timestamp">;
const newEnvelope = (): Readonly<{ version: 1; eventId: string; timestamp: string }> => ({
  version: 1, eventId: randomUUID(), timestamp: new Date().toISOString()
});

export function summaryCommittedEvent(input: EventInput<typeof summaryCommittedEventSchema>): SummaryCommittedEvent {
  return summaryCommittedEventSchema.parse({ type: "summary_committed", ...newEnvelope(), ...input });
}
export function summaryFailedOpenEvent(input: EventInput<typeof summaryFailedOpenEventSchema>): SummaryFailedOpenEvent {
  return summaryFailedOpenEventSchema.parse({ type: "summary_failed_open", ...newEnvelope(), ...input });
}
export function summaryCancelledEvent(input: EventInput<typeof summaryCancelledEventSchema>): SummaryCancelledEvent {
  return summaryCancelledEventSchema.parse({ type: "summary_cancelled", ...newEnvelope(), ...input });
}
export function attemptCreatedEvent(input: EventInput<typeof attemptCreatedEventSchema>): AttemptCreatedEvent {
  return attemptCreatedEventSchema.parse({ type: "attempt_created", ...newEnvelope(), ...input });
}
export function attemptLifecycleEvent(input: EventInput<typeof attemptLifecycleEventSchema>): AttemptLifecycleEvent {
  return attemptLifecycleEventSchema.parse({ type: "attempt_lifecycle", ...newEnvelope(), ...input });
}
export function attemptUsageEvent(input: EventInput<typeof attemptUsageEventSchema>): AttemptUsageEvent {
  return attemptUsageEventSchema.parse({ type: "attempt_usage", ...newEnvelope(), ...input });
}

export function createSummaryReservation(input: {
  readonly sourceMessageId: string;
  readonly originalPrompt: string;
}): SummaryReservedEvent {
  return summaryReservedEventSchema.parse({
    type: "summary_reserved", ...newEnvelope(),
    reservationId: randomUUID(), logicalOperationId: randomUUID(), ...input
  });
}
