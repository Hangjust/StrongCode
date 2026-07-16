import type { SummaryResult } from "./contracts";
import { PreflightModelToolExecutor } from "./scheduler-executor";
import type { PreflightResearchEvidence } from "./scheduler-execution-types";
import { PreflightAttemptRecorder } from "./scheduler-ledger";
import {
  buildFinalizerEvidencePayload,
  parseFinalResult,
  type PreflightProtocolCode
} from "./scheduler-protocol";
import type { PreflightRunContext } from "./scheduler-run-context";
import type { PreflightFailureCode, PreflightSchedulerDependencies } from "./scheduler-types";
import { unexpectedProtocolCode } from "./scheduler-code-maps";

export type PreflightFinalizerResult =
  | Readonly<{ ok: true; result: SummaryResult; attemptId: string }>
  | Readonly<{ ok: false; code: PreflightFailureCode }>;

function finalizerFailure(code: PreflightProtocolCode): PreflightFailureCode {
  switch (code) {
    case "finalizer_output_too_large":
    case "finalizer_evidence_too_large":
    case "finalizer_json_invalid":
    case "finalizer_result_invalid":
    case "unsafe_display_text":
    case "title_word_limit":
      return code;
    default:
      return unexpectedProtocolCode(code);
  }
}

export class PreflightFinalizer {
  constructor(private readonly dependencies: PreflightSchedulerDependencies) {}

  async run(
    context: PreflightRunContext,
    evidence: readonly PreflightResearchEvidence[],
    rootAttemptId: string
  ): Promise<PreflightFinalizerResult> {
    if (context.overallDeadlineAt - this.dependencies.clock.now() < context.limits.reservedFinalizerMs) {
      context.trace.emit({ kind: "validation", stage: "finalizer", code: "insufficient_finalization_time" });
      return { ok: false, code: "insufficient_finalization_time" };
    }
    const payload = buildFinalizerEvidencePayload(evidence, context.limits);
    if (!payload.ok) {
      context.trace.emit({ kind: "validation", stage: "finalizer", code: payload.code });
      return { ok: false, code: finalizerFailure(payload.code) };
    }
    let agent;
    try {
      agent = this.dependencies.createAgent(context.input.context.config, "summary");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      context.trace.emit({ kind: "validation", stage: "finalizer", code: "finalizer_route_exhausted" });
      return { ok: false, code: "finalizer_route_exhausted" };
    }
    const recorder = new PreflightAttemptRecorder({
      sessions: this.dependencies.sessions,
      sessionId: context.input.sessionId,
      logicalOperationId: context.logicalOperationId,
      role: "summary",
      stage: "finalizer",
      parentAttemptId: rootAttemptId,
      ids: this.dependencies.ids,
      resolveModelSnapshot: this.dependencies.resolveModelSnapshot,
      trace: context.trace
    });
    const executor = new PreflightModelToolExecutor({ recorder, trace: context.trace });
    const executed = await executor.execute({
      agent,
      role: "summary",
      stage: "finalizer",
      mode: "finalizer",
      sessionId: context.input.sessionId,
      prompt: context.input.originalPrompt,
      userContent: [payload.value],
      context: context.input.context,
      toolRegistry: context.input.toolRegistry,
      signal: context.signal,
      limits: context.limits,
      outboundWebAllowed: false,
      ...(context.input.effectivePermissions === undefined ? {} : {
        effectivePermissions: context.input.effectivePermissions
      })
    });
    if (!executed.ok) return executed;
    const parsed = parseFinalResult(executed.value.finalText, context.limits);
    if (!parsed.ok) context.trace.emit({ kind: "validation", stage: "finalizer", code: parsed.code });
    return parsed.ok
      ? { ok: true, result: parsed.value, attemptId: executed.value.producingAttemptId }
      : { ok: false, code: finalizerFailure(parsed.code) };
  }
}
