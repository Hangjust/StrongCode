import { type Result } from "../../core/result";
import { PreflightChildrenScheduler } from "./scheduler-children";
import { PreflightModelToolExecutor } from "./scheduler-executor";
import { PreflightFinalizer } from "./scheduler-finalizer";
import { PreflightAttemptRecorder } from "./scheduler-ledger";
import {
  admitResearchRequests,
  parseRootDecision,
  type PreflightProtocolCode
} from "./scheduler-protocol";
import type {
  PreflightFailureCode,
  PreflightSchedulerDependencies,
  PreflightTerminalOutcome
} from "./scheduler-types";
import type { PreflightRunContext } from "./scheduler-run-context";
import { PreflightTerminalWriter, type ExistingResolution } from "./scheduler-terminal";
import { unexpectedProtocolCode } from "./scheduler-code-maps";

function rootFailureCode(code: PreflightProtocolCode): PreflightFailureCode {
  switch (code) {
    case "root_output_too_large":
    case "root_json_invalid":
    case "root_decision_invalid":
    case "title_word_limit":
    case "unsafe_display_text":
    case "research_limit_exceeded":
      return code;
    default:
      return unexpectedProtocolCode(code);
  }
}

function researchFailureCode(code: PreflightProtocolCode): PreflightFailureCode {
  switch (code) {
    case "research_limit_exceeded":
    case "research_duplicate_id":
    case "research_question_too_large":
    case "research_payload_too_large":
      return code;
    default:
      return unexpectedProtocolCode(code);
  }
}

export class PreflightDirectRun {
  constructor(private readonly dependencies: PreflightSchedulerDependencies) {}

  async execute(options: PreflightRunContext): Promise<Result<PreflightTerminalOutcome>> {
    const terminal = new PreflightTerminalWriter(this.dependencies);
    if (options.signal.aborted) return terminal.cancelled(
      options,
      options.closed() ? "scheduler_closed" : "user_cancelled"
    );
    const recorder = new PreflightAttemptRecorder({
      sessions: this.dependencies.sessions,
      sessionId: options.input.sessionId,
      logicalOperationId: options.logicalOperationId,
      role: "summary",
      stage: "root",
      ids: this.dependencies.ids,
      resolveModelSnapshot: this.dependencies.resolveModelSnapshot,
      trace: options.trace
    });
    const executor = new PreflightModelToolExecutor({ recorder, trace: options.trace });
    let agent;
    try {
      agent = this.dependencies.createAgent(options.input.context.config, "summary");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      options.trace.emit({ kind: "validation", stage: "root", code: "route_exhausted" });
      return terminal.failedOpen(options, "route_exhausted");
    }
    const executed = await executor.execute({
      agent,
      role: "summary",
      stage: "root",
      sessionId: options.input.sessionId,
      prompt: options.input.originalPrompt,
      context: options.input.context,
      toolRegistry: options.input.toolRegistry,
      signal: options.signal,
      limits: options.limits,
      outboundWebAllowed: true,
      ...(options.input.effectivePermissions === undefined ? {} : {
        effectivePermissions: options.input.effectivePermissions
      })
    });
    if (options.signal.aborted) {
      const external = options.externalTerminal();
      if (external !== undefined) return external;
      return options.timedOut()
        ? terminal.failedOpen(options, "overall_timeout")
        : terminal.cancelled(options, options.closed() ? "scheduler_closed" : "user_cancelled");
    }
    if (!executed.ok) return terminal.failedOpen(options, executed.code);
    const decision = parseRootDecision(executed.value.finalText, options.limits);
    if (!decision.ok) {
      const code = rootFailureCode(decision.code);
      options.trace.emit({ kind: "validation", stage: "root", code });
      return terminal.failedOpen(options, code);
    }
    if (decision.value.kind === "research") {
      const admitted = admitResearchRequests(decision.value.requests, options.limits);
      if (!admitted.ok) {
        const code = researchFailureCode(admitted.code);
        options.trace.emit({ kind: "validation", stage: "root", code });
        return terminal.failedOpen(options, code);
      }
      const children = await new PreflightChildrenScheduler(this.dependencies).run(
        options,
        admitted.value,
        executed.value.firstAttemptId,
        executed.value.workspaceEvidenceObserved
      );
      if (options.signal.aborted) {
        const external = options.externalTerminal();
        if (external !== undefined) return external;
        return options.timedOut()
          ? terminal.failedOpen(options, "overall_timeout")
          : terminal.cancelled(options, options.closed() ? "scheduler_closed" : "user_cancelled");
      }
      if (!children.ok) return terminal.failedOpen(options, children.code);
      const finalizer = await new PreflightFinalizer(this.dependencies).run(
        options,
        children.evidence,
        executed.value.firstAttemptId
      );
      if (options.signal.aborted) {
        const external = options.externalTerminal();
        if (external !== undefined) return external;
        return options.timedOut()
          ? terminal.failedOpen(options, "overall_timeout")
          : terminal.cancelled(options, options.closed() ? "scheduler_closed" : "user_cancelled");
      }
      if (!finalizer.ok) return terminal.failedOpen(options, finalizer.code);
      return terminal.committed(options, finalizer.attemptId, finalizer.result);
    }
    return terminal.committed(options, executed.value.producingAttemptId, decision.value.result);
  }

  async resolveExisting(
    sessionId: string,
    reservationId: string,
    logicalOperationId: string
  ): Promise<ExistingResolution> {
    return new PreflightTerminalWriter(this.dependencies).resolveExisting(
      sessionId,
      reservationId,
      logicalOperationId
    );
  }
}
