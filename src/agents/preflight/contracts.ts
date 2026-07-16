import { z } from "zod";
import { generatedDisplayTextSchema, normalizeSummaryTitle, preflightIdSchema } from "./text";

export const MAX_SUMMARY_TITLE_WORDS = 20;
export const MAX_PREFLIGHT_RESEARCH_REQUESTS = 25;

export const preflightResearchRoleSchema = z.enum(["analysis", "explorer"]);

export const summaryTitleSchema = generatedDisplayTextSchema
  .transform(normalizeSummaryTitle)
  .refine(
    value => value.split(" ").length <= MAX_SUMMARY_TITLE_WORDS,
    `Summary title must contain at most ${MAX_SUMMARY_TITLE_WORDS} words`
  )
  .brand("SummaryTitle");

export const analysisRequestSchema = z.object({
  id: preflightIdSchema,
  role: preflightResearchRoleSchema,
  question: generatedDisplayTextSchema
}).strict().readonly();

export const analysisSourceSchema = z.object({
  label: generatedDisplayTextSchema,
  reference: generatedDisplayTextSchema,
  excerpt: generatedDisplayTextSchema.optional()
}).strict().readonly();

export const analysisFindingSchema = z.object({
  requestId: preflightIdSchema,
  role: preflightResearchRoleSchema,
  summary: generatedDisplayTextSchema,
  sources: z.array(analysisSourceSchema).max(64).readonly().default([])
}).strict().readonly();

export const summaryResultSchema = z.object({
  title: summaryTitleSchema,
  generalSummary: generatedDisplayTextSchema,
  requestedItems: z.array(generatedDisplayTextSchema).readonly()
}).strict().readonly();

const completeSummaryDecisionSchema = z.object({
  kind: z.literal("complete"),
  result: summaryResultSchema
}).strict();

const researchSummaryDecisionSchema = z.object({
  kind: z.literal("research"),
  requests: z.array(analysisRequestSchema).max(MAX_PREFLIGHT_RESEARCH_REQUESTS).readonly()
}).strict();

export const summaryDecisionSchema = z.discriminatedUnion("kind", [
  completeSummaryDecisionSchema,
  researchSummaryDecisionSchema
]).readonly();

export type PreflightResearchRole = z.infer<typeof preflightResearchRoleSchema>;
export type AnalysisRequest = z.infer<typeof analysisRequestSchema>;
export type AnalysisSource = z.infer<typeof analysisSourceSchema>;
export type AnalysisFinding = z.infer<typeof analysisFindingSchema>;
export type SummaryResult = z.infer<typeof summaryResultSchema>;
export type SummaryDecision = z.infer<typeof summaryDecisionSchema>;

export type PreflightContractIssue = {
  readonly code: string;
  readonly path: string;
  readonly message: string;
};

export class PreflightContractError extends Error {
  readonly name = "PreflightContractError";
  readonly code = "PREFLIGHT_CONTRACT_INVALID";

  constructor(readonly issues: readonly PreflightContractIssue[]) {
    super(issues.map(issue => `${issue.path || "<root>"}: ${issue.message}`).join("; "));
  }
}

export type SummaryDecisionParseResult =
  | { readonly ok: true; readonly value: SummaryDecision }
  | { readonly ok: false; readonly error: PreflightContractError };

export function parseSummaryDecision(input: unknown): SummaryDecisionParseResult {
  const parsed = summaryDecisionSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: new PreflightContractError(parsed.error.issues.map(issue => ({
      code: issue.code,
      path: issue.path.join("."),
      message: issue.message
    })))
  };
}
