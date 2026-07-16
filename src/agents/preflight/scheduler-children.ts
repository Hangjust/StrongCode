import type { AnalysisRequest } from "./contracts";
import { PreflightModelToolExecutor } from "./scheduler-executor";
import type { PreflightResearchEvidence } from "./scheduler-execution-types";
import { PreflightAttemptRecorder } from "./scheduler-ledger";
import {
  buildChildRequestPayload,
  parseResearchFinding,
  validateFindingBytes,
  validateFindingIdentity,
  type PreflightProtocolCode
} from "./scheduler-protocol";
import type { PreflightRunContext } from "./scheduler-run-context";
import type {
  PreflightFailureCode,
  PreflightGapCode,
  PreflightSchedulerDependencies
} from "./scheduler-types";
import { childExecutionGap, unexpectedProtocolCode } from "./scheduler-code-maps";

export type PreflightChildrenResult =
  | Readonly<{ ok: true; evidence: readonly PreflightResearchEvidence[] }>
  | Readonly<{ ok: false; code: PreflightFailureCode }>;

type ChildPayload = Readonly<{
  index: number;
  request: AnalysisRequest;
  content: string;
}>;

function gapEvidence(payload: ChildPayload, code: PreflightGapCode): PreflightResearchEvidence {
  return { index: payload.index, request: payload.request, outcome: { kind: "gap", code } };
}

export class PreflightChildrenScheduler {
  constructor(private readonly dependencies: PreflightSchedulerDependencies) {}

  async run(
    context: PreflightRunContext,
    requests: readonly AnalysisRequest[],
    rootAttemptId: string,
    rootWorkspaceEvidenceObserved: boolean
  ): Promise<PreflightChildrenResult> {
    if (requests.length > 0 && context.limits.maxDepth < 1) {
      return { ok: false, code: "nested_research_denied" };
    }
    const payloads: ChildPayload[] = [];
    for (let index = 0; index < requests.length; index += 1) {
      const request = requests[index];
      if (request === undefined) return { ok: false, code: "internal_error" };
      const built = buildChildRequestPayload(request, index, context.limits);
      if (!built.ok) return { ok: false, code: this.failureCode(built.code) };
      payloads.push({ index, request, content: built.value });
    }
    if (payloads.length === 0) return { ok: true, evidence: Object.freeze([]) };
    for (const payload of payloads) {
      context.trace.emit({ kind: "child-transition", stage: "child", code: "queued", sourceIndex: payload.index });
    }

    const capacity = Math.min(context.limits.maxConcurrentChildren, context.limits.maxTotalChildren);
    if (capacity === 0) {
      return {
        ok: true,
        evidence: Object.freeze(payloads.map(payload => gapEvidence(payload, "route_unavailable")))
      };
    }
    const group = new AbortController();
    const cancelGroup = (): void => group.abort(context.signal.reason);
    if (context.signal.aborted) cancelGroup();
    else context.signal.addEventListener("abort", cancelGroup, { once: true });
    const evidence: Array<PreflightResearchEvidence | undefined> = new Array(payloads.length);
    let nextIndex = 0;
    let fatalCode: PreflightFailureCode | undefined;

    const worker = async (): Promise<void> => {
      while (!group.signal.aborted && fatalCode === undefined) {
        const payload = payloads[nextIndex];
        nextIndex += 1;
        if (payload === undefined) return;
        const result = await this.runChild(context, payload, rootAttemptId, group.signal, rootWorkspaceEvidenceObserved);
        if (result.ok) evidence[payload.index] = result.evidence;
        else if (fatalCode === undefined) {
          fatalCode = result.code;
          group.abort(result.code);
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(capacity, payloads.length) }, () => worker()));
    } finally {
      context.signal.removeEventListener("abort", cancelGroup);
    }
    if (fatalCode !== undefined) return { ok: false, code: fatalCode };
    if (context.signal.aborted) return { ok: false, code: "internal_error" };
    const ordered: PreflightResearchEvidence[] = [];
    for (const item of evidence) {
      if (item === undefined) return { ok: false, code: "internal_error" };
      ordered.push(item);
    }
    return { ok: true, evidence: Object.freeze(ordered) };
  }

  private async runChild(
    context: PreflightRunContext,
    payload: ChildPayload,
    rootAttemptId: string,
    groupSignal: AbortSignal,
    rootWorkspaceEvidenceObserved: boolean
  ): Promise<Readonly<{ ok: true; evidence: PreflightResearchEvidence }> | Readonly<{ ok: false; code: PreflightFailureCode }>> {
    const finalizerBoundary = context.overallDeadlineAt - context.limits.reservedFinalizerMs;
    const remaining = finalizerBoundary - this.dependencies.clock.now();
    if (remaining <= 0) return { ok: true, evidence: gapEvidence(payload, "insufficient_child_time") };
    const controller = new AbortController();
    let timedOut = false;
    const cancelChild = (): void => controller.abort(groupSignal.reason);
    if (groupSignal.aborted) cancelChild();
    else groupSignal.addEventListener("abort", cancelChild, { once: true });
    const timer = this.dependencies.clock.setTimer(() => {
      timedOut = true;
      controller.abort();
    }, Math.min(context.limits.childDeadlineMs, remaining));
    context.trace.emit({ kind: "child-transition", stage: "child", code: "running", sourceIndex: payload.index });
    try {
      let agent;
      try {
        agent = this.dependencies.createAgent(context.input.context.config, payload.request.role);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        context.trace.emit({ kind: "validation", stage: "child", code: "route_unavailable", sourceIndex: payload.index });
        return { ok: true, evidence: gapEvidence(payload, "route_unavailable") };
      }
      const recorder = new PreflightAttemptRecorder({
        sessions: this.dependencies.sessions,
        sessionId: context.input.sessionId,
        logicalOperationId: context.logicalOperationId,
        role: payload.request.role,
        stage: "child",
        parentAttemptId: rootAttemptId,
        ids: this.dependencies.ids,
        resolveModelSnapshot: this.dependencies.resolveModelSnapshot,
        trace: context.trace
      });
      const executor = new PreflightModelToolExecutor({ recorder, trace: context.trace });
      const executed = await executor.execute({
        agent,
        role: payload.request.role,
        stage: "child",
        sessionId: context.input.sessionId,
        prompt: context.input.originalPrompt,
        userContent: [payload.content],
        context: context.input.context,
        toolRegistry: context.input.toolRegistry,
        signal: controller.signal,
        limits: context.limits,
        outboundWebAllowed: !rootWorkspaceEvidenceObserved,
        ...(context.input.effectivePermissions === undefined ? {} : {
          effectivePermissions: context.input.effectivePermissions
        })
      });
      if (timedOut) {
        context.trace.emit({ kind: "child-transition", stage: "child", code: "timed-out", sourceIndex: payload.index });
        return { ok: true, evidence: gapEvidence(payload, "child_timeout") };
      }
      if (groupSignal.aborted) return { ok: false, code: "internal_error" };
      if (!executed.ok) {
        const gap = childExecutionGap(executed.code);
        return gap === undefined
          ? { ok: false, code: executed.code }
          : { ok: true, evidence: gapEvidence(payload, gap) };
      }
      const parsed = parseResearchFinding(executed.value.finalText, context.limits);
      if (!parsed.ok) {
        context.trace.emit({ kind: "validation", stage: "child", code: parsed.code, sourceIndex: payload.index });
        return { ok: true, evidence: gapEvidence(payload, this.gapCode(parsed.code)) };
      }
      const identified = validateFindingIdentity(parsed.value, payload.request);
      if (!identified.ok) {
        context.trace.emit({ kind: "validation", stage: "child", code: identified.code, sourceIndex: payload.index });
        return { ok: true, evidence: gapEvidence(payload, this.gapCode(identified.code)) };
      }
      const bounded = validateFindingBytes(executed.value.finalText, context.limits);
      if (!bounded.ok) {
        context.trace.emit({ kind: "validation", stage: "child", code: bounded.code, sourceIndex: payload.index });
        return { ok: true, evidence: gapEvidence(payload, this.gapCode(bounded.code)) };
      }
      context.trace.emit({ kind: "child-transition", stage: "child", code: "succeeded", sourceIndex: payload.index });
      return {
        ok: true,
        evidence: { index: payload.index, request: payload.request, outcome: { kind: "finding", finding: identified.value } }
      };
    } finally {
      this.dependencies.clock.clearTimer(timer);
      groupSignal.removeEventListener("abort", cancelChild);
    }
  }

  private failureCode(code: PreflightProtocolCode): PreflightFailureCode {
    switch (code) {
      case "research_question_too_large":
      case "research_payload_too_large":
        return code;
      default:
        return unexpectedProtocolCode(code);
    }
  }

  private gapCode(code: PreflightProtocolCode): PreflightGapCode {
    switch (code) {
      case "malformed_json":
      case "finding_invalid":
      case "finding_mismatch":
      case "finding_too_large":
        return code;
      default:
        unexpectedProtocolCode(code);
        return "provider_failed";
    }
  }
}
