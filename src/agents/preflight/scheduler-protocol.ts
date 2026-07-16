import { z } from "zod";
import {
  analysisFindingSchema,
  summaryDecisionSchema,
  summaryResultSchema,
  type AnalysisFinding,
  type AnalysisRequest,
  type SummaryDecision,
  type SummaryResult
} from "./contracts";
import type {
  PreflightFailureCode,
  PreflightGapCode,
  PreflightLimits
} from "./scheduler-types";
import type { PreflightResearchEvidence } from "./scheduler-execution-types";

const UTF8 = new TextEncoder();
const JSON_EDGE_WHITESPACE = /^[ \t\r\n]+|[ \t\r\n]+$/gu;

export type PreflightProtocolCode = PreflightFailureCode | PreflightGapCode;
export type PreflightProtocolResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; code: PreflightProtocolCode }>;

type WholeOutputSpec<S extends z.ZodTypeAny> = Readonly<{
  maxBytes: number;
  schema: S;
  tooLarge: PreflightProtocolCode;
  invalidJson: PreflightProtocolCode;
  invalidContract: PreflightProtocolCode;
  mapSchemaError: (error: z.ZodError) => PreflightProtocolCode;
}>;

function utf8Bytes(value: string): number {
  return UTF8.encode(value).byteLength;
}

function mapDisplayIssue(error: z.ZodError, fallback: PreflightProtocolCode): PreflightProtocolCode {
  for (const issue of error.issues) {
    if (issue.message.includes("terminal control")) return "unsafe_display_text";
    if (issue.path.some(segment => segment === "title") && issue.message.includes("at most 20 words")) {
      return "title_word_limit";
    }
    if (issue.path.some(segment => segment === "requests") && issue.code === "too_big") {
      return "research_limit_exceeded";
    }
  }
  return fallback;
}

function parseWholeObject<S extends z.ZodTypeAny>(
  text: string,
  spec: WholeOutputSpec<S>
): PreflightProtocolResult<z.output<S>> {
  if (utf8Bytes(text) > spec.maxBytes) return { ok: false, code: spec.tooLarge };
  const withoutBom = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const source = withoutBom.replace(JSON_EDGE_WHITESPACE, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { ok: false, code: spec.invalidJson };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, code: spec.invalidContract };
  }
  const validated = spec.schema.safeParse(parsed);
  return validated.success
    ? { ok: true, value: validated.data }
    : { ok: false, code: spec.mapSchemaError(validated.error) };
}

export function parseRootDecision(text: string, limits: PreflightLimits): PreflightProtocolResult<SummaryDecision> {
  return parseWholeObject(text, {
    maxBytes: limits.maxFinalTextBytes,
    schema: summaryDecisionSchema,
    tooLarge: "root_output_too_large",
    invalidJson: "root_json_invalid",
    invalidContract: "root_decision_invalid",
    mapSchemaError: error => mapDisplayIssue(error, "root_decision_invalid")
  });
}

export function parseFinalResult(text: string, limits: PreflightLimits): PreflightProtocolResult<SummaryResult> {
  return parseWholeObject(text, {
    maxBytes: Math.min(limits.maxFinalTextBytes, limits.maxFinalResultBytes),
    schema: summaryResultSchema,
    tooLarge: "finalizer_output_too_large",
    invalidJson: "finalizer_json_invalid",
    invalidContract: "finalizer_result_invalid",
    mapSchemaError: error => mapDisplayIssue(error, "finalizer_result_invalid")
  });
}

export function parseResearchFinding(
  text: string,
  limits: PreflightLimits
): PreflightProtocolResult<AnalysisFinding> {
  return parseWholeObject(text, {
    maxBytes: limits.maxFinalTextBytes,
    schema: analysisFindingSchema,
    tooLarge: "finding_too_large",
    invalidJson: "malformed_json",
    invalidContract: "finding_invalid",
    mapSchemaError: () => "finding_invalid"
  });
}

export function validateFindingBytes(text: string, limits: PreflightLimits): PreflightProtocolResult<string> {
  return utf8Bytes(text) > limits.maxFindingBytes
    ? { ok: false, code: "finding_too_large" }
    : { ok: true, value: text };
}

export function validateFindingIdentity(
  finding: AnalysisFinding,
  request: AnalysisRequest
): PreflightProtocolResult<AnalysisFinding> {
  return finding.requestId === request.id && finding.role === request.role
    ? { ok: true, value: finding }
    : { ok: false, code: "finding_mismatch" };
}

export function admitResearchRequests(
  requests: readonly AnalysisRequest[],
  limits: PreflightLimits
): PreflightProtocolResult<readonly AnalysisRequest[]> {
  if (requests.length > limits.maxTotalChildren) return { ok: false, code: "research_limit_exceeded" };
  const ids = new Set<string>();
  for (const request of requests) {
    if (ids.has(request.id)) return { ok: false, code: "research_duplicate_id" };
    ids.add(request.id);
    if (utf8Bytes(request.question) > limits.maxQuestionBytes) {
      return { ok: false, code: "research_question_too_large" };
    }
  }
  const canonical = JSON.stringify(requests.map(request => ({
    id: request.id,
    role: request.role,
    question: request.question
  })));
  return utf8Bytes(canonical) > limits.maxResearchBytes
    ? { ok: false, code: "research_payload_too_large" }
    : { ok: true, value: requests };
}

export function buildChildRequestPayload(
  request: AnalysisRequest,
  sourceIndex: number,
  limits: PreflightLimits
): PreflightProtocolResult<string> {
  if (!Number.isInteger(sourceIndex) || sourceIndex < 0) return { ok: false, code: "internal_error" };
  if (utf8Bytes(request.question) > limits.maxQuestionBytes) {
    return { ok: false, code: "research_question_too_large" };
  }
  const payload = JSON.stringify({
    sourceIndex,
    request: { id: request.id, role: request.role, question: request.question }
  });
  return utf8Bytes(payload) > limits.maxResearchBytes
    ? { ok: false, code: "research_payload_too_large" }
    : { ok: true, value: payload };
}

export function buildFinalizerEvidencePayload(
  evidence: readonly PreflightResearchEvidence[],
  limits: PreflightLimits
): PreflightProtocolResult<string> {
  if (evidence.some((entry, index) => entry.index !== index)) return { ok: false, code: "internal_error" };
  const payload = JSON.stringify({
    untrustedResearch: evidence.map(entry => ({
      index: entry.index,
      request: {
        id: entry.request.id,
        role: entry.request.role,
        question: entry.request.question
      },
      outcome: canonicalResearchOutcome(entry)
    }))
  });
  return utf8Bytes(payload) > limits.maxFinalizerEvidenceBytes
    ? { ok: false, code: "finalizer_evidence_too_large" }
    : { ok: true, value: payload };
}

function canonicalResearchOutcome(entry: PreflightResearchEvidence): object {
  switch (entry.outcome.kind) {
    case "gap":
      return { kind: "gap", code: entry.outcome.code };
    case "finding":
      return {
        kind: "finding",
        finding: {
          requestId: entry.outcome.finding.requestId,
          role: entry.outcome.finding.role,
          summary: entry.outcome.finding.summary,
          sources: entry.outcome.finding.sources.map(source => ({
            label: source.label,
            reference: source.reference,
            ...(source.excerpt === undefined ? {} : { excerpt: source.excerpt })
          }))
        }
      };
  }
}
