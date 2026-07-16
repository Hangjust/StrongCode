import type { PreflightLimitNarrowing, PreflightLimits } from "./scheduler-types";

export const PREFLIGHT_HOST_LIMITS: PreflightLimits = Object.freeze({
  maxTotalChildren: 25,
  maxConcurrentChildren: 25,
  maxDepth: 1,
  overallDeadlineMs: 90_000,
  childDeadlineMs: 30_000,
  reservedFinalizerMs: 5_000,
  maxModelSteps: 8,
  maxFinalizerModelSteps: 1,
  maxFinalizerTools: 0,
  maxToolCallsPerStep: 4,
  maxTotalToolCalls: 4,
  maxToolInputBytes: 64 * 1024,
  maxToolResultBytes: 32 * 1024,
  maxAggregateToolResultBytes: 128 * 1024,
  maxFinalTextBytes: 256 * 1024,
  maxQuestionBytes: 4_096,
  maxResearchBytes: 64 * 1024,
  maxFindingBytes: 8_192,
  maxFinalizerEvidenceBytes: 384 * 1024,
  maxFinalResultBytes: 64 * 1024
});

export type PreflightLimitError = Readonly<{
  ok: false;
  code: "invalid_limit_narrowing";
  field: keyof PreflightLimits;
}>;

export type PreflightLimitResult =
  | Readonly<{ ok: true; value: PreflightLimits }>
  | PreflightLimitError;

const LIMIT_FIELDS = [
  "maxTotalChildren", "maxConcurrentChildren", "maxDepth", "overallDeadlineMs",
  "childDeadlineMs", "reservedFinalizerMs", "maxModelSteps", "maxFinalizerModelSteps",
  "maxFinalizerTools", "maxToolCallsPerStep", "maxTotalToolCalls", "maxToolInputBytes",
  "maxToolResultBytes", "maxAggregateToolResultBytes", "maxFinalTextBytes", "maxQuestionBytes",
  "maxResearchBytes", "maxFindingBytes", "maxFinalizerEvidenceBytes", "maxFinalResultBytes"
] as const satisfies readonly (keyof PreflightLimits)[];

export function resolvePreflightLimits(narrowing: PreflightLimitNarrowing = {}): PreflightLimitResult {
  const values: Record<keyof PreflightLimits, number> = { ...PREFLIGHT_HOST_LIMITS };
  for (const candidate of LIMIT_FIELDS) {
    const narrowed = narrowing[candidate];
    if (narrowed === undefined) continue;
    const ceiling = PREFLIGHT_HOST_LIMITS[candidate];
    if (!Number.isInteger(narrowed) || narrowed < 0 || narrowed > ceiling) {
      return { ok: false, code: "invalid_limit_narrowing", field: candidate };
    }
    values[candidate] = narrowed;
  }
  return { ok: true, value: Object.freeze(values) };
}
