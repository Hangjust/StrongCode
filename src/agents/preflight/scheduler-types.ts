import type { Agent } from "../agent";
import type { Result } from "../../core/result";
import type { DirectModelAttempt } from "../../models/provider";
import type { EffectiveToolPermission, RuntimeContext } from "../../runtime/context";
import type { SessionStore } from "../../sessions/session-store";
import type { ToolRegistry } from "../../tools/registry";
import type { PreflightRunRegistry } from "./scheduler-registry";
import type { SummaryResult } from "./contracts";
import type { PreflightRole } from "./metadata";
import type { AttemptRole } from "./metadata";

export type PreflightFailureCode =
  | "orphaned_reservation"
  | "route_exhausted"
  | "root_provider_failed"
  | "root_output_too_large"
  | "root_json_invalid"
  | "root_decision_invalid"
  | "title_word_limit"
  | "unsafe_display_text"
  | "research_limit_exceeded"
  | "research_duplicate_id"
  | "research_question_too_large"
  | "research_payload_too_large"
  | "nested_research_denied"
  | "tool_permission_denied"
  | "tool_data_boundary_denied"
  | "tool_step_limit"
  | "tool_total_limit"
  | "tool_loop_detected"
  | "tool_input_too_large"
  | "tool_output_budget_exhausted"
  | "model_step_limit"
  | "insufficient_finalization_time"
  | "finalizer_route_exhausted"
  | "finalizer_provider_failed"
  | "finalizer_tool_requested"
  | "finalizer_output_too_large"
  | "finalizer_evidence_too_large"
  | "finalizer_json_invalid"
  | "finalizer_result_invalid"
  | "provider_identity_collision"
  | "overall_timeout"
  | "invalid_limit_narrowing"
  | "internal_error";

export type PreflightGapCode =
  | "route_unavailable"
  | "provider_failed"
  | "model_step_limit"
  | "tool_limit"
  | "child_timeout"
  | "insufficient_child_time"
  | "malformed_json"
  | "finding_invalid"
  | "finding_mismatch"
  | "finding_too_large";

export type PreflightSchedulerState =
  | "unclaimed"
  | "reserving"
  | "reserved"
  | "root-running"
  | "research-admitted"
  | "children-running"
  | "finalizing"
  | "committing"
  | "committed"
  | "failed-open"
  | "cancelled"
  | "closed";

export type PreflightChildState = "queued" | "running" | "succeeded" | "failed" | "timed-out" | "cancelled";
export type PreflightStage = "root" | "child" | "finalizer" | "terminal" | "registry";
export type PreflightTraceCode =
  | PreflightFailureCode
  | PreflightGapCode
  | "outbound"
  | "settled"
  | "late-dropped"
  | "advertise"
  | "invoke"
  | "accepted"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timed-out"
  | "cancelled"
  | "closed";

export type PreflightLimitNarrowing = Readonly<Partial<{
  maxTotalChildren: number;
  maxConcurrentChildren: number;
  maxDepth: number;
  overallDeadlineMs: number;
  childDeadlineMs: number;
  reservedFinalizerMs: number;
  maxModelSteps: number;
  maxFinalizerModelSteps: number;
  maxFinalizerTools: number;
  maxToolCallsPerStep: number;
  maxTotalToolCalls: number;
  maxToolInputBytes: number;
  maxToolResultBytes: number;
  maxAggregateToolResultBytes: number;
  maxFinalTextBytes: number;
  maxQuestionBytes: number;
  maxResearchBytes: number;
  maxFindingBytes: number;
  maxFinalizerEvidenceBytes: number;
  maxFinalResultBytes: number;
}>>;

export type PreflightLimits = Readonly<Required<PreflightLimitNarrowing>>;

export type PreflightCommittedOutcome = Readonly<{
  kind: "committed";
  reservationId: string;
  logicalOperationId: string;
  attemptId: string;
  result: SummaryResult;
}>;

export type PreflightFailedOpenOutcome = Readonly<{
  kind: "failed-open";
  reservationId: string;
  logicalOperationId: string;
  reasonCode: PreflightFailureCode;
}>;

export type PreflightCancelledOutcome = Readonly<{
  kind: "cancelled";
  reservationId: string;
  logicalOperationId: string;
  reasonCode: "user_cancelled" | "scheduler_closed";
  reasonAvailable: boolean;
  reason?: unknown;
}>;

export type PreflightTerminalOutcome =
  | PreflightCommittedOutcome
  | PreflightFailedOpenOutcome
  | PreflightCancelledOutcome;

export type PreflightOutcome =
  | Readonly<{ kind: "ignored-empty" }>
  | PreflightTerminalOutcome
  | Readonly<{
      kind: "in-progress";
      reservationId: string;
      logicalOperationId: string;
      done: Promise<Result<PreflightTerminalOutcome>>;
    }>
  | Readonly<{
      kind: "existing";
      reason: "terminal-replay" | "owned-by-another-source" | "history-already-started";
      terminal?: PreflightTerminalOutcome;
    }>;

export type PreflightScheduleInput = Readonly<{
  sessionId: string;
  sourceMessageId: string;
  originalPrompt: string;
  context: RuntimeContext;
  toolRegistry: ToolRegistry;
  signal?: AbortSignal;
  effectivePermissions?: Readonly<Record<string, EffectiveToolPermission>>;
  limits?: PreflightLimitNarrowing;
  parentDepth?: number;
}>;

export type PreflightClock = Readonly<{
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => unknown;
  clearTimer: (handle: unknown) => void;
}>;

export type PreflightTraceEvent = Readonly<{
  kind: "provider-attempt" | "tool-decision" | "validation" | "scheduler-transition" | "child-transition";
  runId: string;
  generation: number;
  sequence: number;
  timestamp: number;
  stage: PreflightStage;
  code: PreflightTraceCode;
  attemptId?: string;
  sourceIndex?: number;
  decision?: "allow" | "deny";
}>;

export type PreflightSchedulerDependencies = Readonly<{
  sessions: Pick<SessionStore, "operationKey" | "reserveFirstSummary" | "read" | "commitLedgerEvent">;
  createAgent: (config: RuntimeContext["config"], role: PreflightRole) => Agent;
  registry: PreflightRunRegistry;
  clock: PreflightClock;
  ids: Readonly<{ next: () => string }>;
  resolveModelSnapshot: (input: Readonly<{
    role: AttemptRole;
    directAttempt?: DirectModelAttempt;
  }>) => Readonly<{ modelRef: string; providerRef: string; displayName: string }>;
  emitTrace?: (event: PreflightTraceEvent) => void;
}>;
