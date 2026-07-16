import { z } from "zod";
import { generatedDisplayTextSchema, modelReferenceSchema, preflightIdSchema } from "./text";

const tokenCountSchema = z.number().int().nonnegative().safe();
const positiveTokenCountSchema = z.number().int().positive().safe();
const priceSchema = z.number().nonnegative().finite();

export const preflightRoleSchema = z.enum(["summary", "analysis", "explorer"]);
export const attemptRoleSchema = z.enum(["primary", "summary", "analysis", "explorer"]);
export const metadataProvenanceSchema = z.enum(["provider-reported", "configured", "estimated"]);

export const preflightStatusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pending") }).strict(),
  z.object({ kind: z.literal("running"), attemptId: preflightIdSchema }).strict(),
  z.object({ kind: z.literal("succeeded"), attemptId: preflightIdSchema }).strict(),
  z.object({ kind: z.literal("failed-open"), reason: generatedDisplayTextSchema }).strict(),
  z.object({ kind: z.literal("cancelled") }).strict()
]).readonly();

export const firstPromptMetadataSchema = z.object({
  sourceMessageId: preflightIdSchema,
  originalPrompt: z.string().min(1),
  status: preflightStatusSchema
}).strict().readonly();

export const normalizedUsageSchema = z.object({
  inputTokens: tokenCountSchema.optional(),
  outputTokens: tokenCountSchema.optional(),
  reasoningTokens: tokenCountSchema.optional(),
  cacheReadTokens: tokenCountSchema.optional(),
  cacheWriteTokens: tokenCountSchema.optional(),
  totalTokens: tokenCountSchema.optional()
}).strict().superRefine((usage, context) => {
  if (Object.values(usage).every(value => value === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Reported usage must contain at least one token value" });
  }
}).readonly();

export const pricingMetadataSchema = z.object({
  version: generatedDisplayTextSchema,
  currency: z.string().regex(/^[A-Z]{3}$/, "Currency must be a three-letter uppercase code"),
  inputPerMillion: priceSchema.optional(),
  outputPerMillion: priceSchema.optional(),
  cacheReadPerMillion: priceSchema.optional(),
  cacheWritePerMillion: priceSchema.optional()
}).strict().superRefine((pricing, context) => {
  const rates = [pricing.inputPerMillion, pricing.outputPerMillion, pricing.cacheReadPerMillion, pricing.cacheWritePerMillion];
  if (rates.every(rate => rate === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Pricing metadata must contain at least one rate" });
  }
}).readonly();

export const contextMetadataSchema = z.object({
  windowTokens: positiveTokenCountSchema,
  usedTokens: tokenCountSchema.optional(),
  provenance: metadataProvenanceSchema
}).strict().superRefine((metadata, context) => {
  if (metadata.usedTokens !== undefined && metadata.usedTokens > metadata.windowTokens) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["usedTokens"],
      message: "Used context tokens must not exceed the context window"
    });
  }
}).readonly();

export const modelMetadataSchema = z.object({
  modelRef: modelReferenceSchema,
  providerRef: generatedDisplayTextSchema.optional(),
  displayName: generatedDisplayTextSchema.optional(),
  contextWindowTokens: positiveTokenCountSchema.optional(),
  pricing: pricingMetadataSchema.optional()
}).strict().readonly();

export const attemptUsageSchema = z.object({
  attemptId: preflightIdSchema,
  role: preflightRoleSchema,
  model: modelMetadataSchema,
  usage: normalizedUsageSchema,
  provenance: metadataProvenanceSchema
}).strict().readonly();

export type PreflightRole = z.infer<typeof preflightRoleSchema>;
export type AttemptRole = z.infer<typeof attemptRoleSchema>;
export type PreflightStatus = z.infer<typeof preflightStatusSchema>;
export type FirstPromptMetadata = z.infer<typeof firstPromptMetadataSchema>;
export type NormalizedUsage = z.infer<typeof normalizedUsageSchema>;
export type PricingMetadata = z.infer<typeof pricingMetadataSchema>;
export type ContextMetadata = z.infer<typeof contextMetadataSchema>;
export type ModelMetadata = z.infer<typeof modelMetadataSchema>;
export type AttemptUsage = z.infer<typeof attemptUsageSchema>;
