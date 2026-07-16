import { StrongCodeError } from "../../core/errors";
import { err, ok, type Result } from "../../core/result";
import { projectSessionLedger } from "../../sessions/session-ledger-projection";
import {
  summaryCancelledEvent,
  summaryCommittedEvent,
  summaryFailedOpenEvent
} from "../../sessions/session-ledger-events";
import type { SummaryResult } from "./contracts";
import type { PreflightRunContext } from "./scheduler-run-context";
import type {
  PreflightFailureCode,
  PreflightSchedulerDependencies,
  PreflightTerminalOutcome
} from "./scheduler-types";

export type ExistingResolution =
  | PreflightTerminalOutcome
  | Readonly<{ kind: "existing"; reason: "terminal-replay" }>;

export class PreflightTerminalWriter {
  constructor(private readonly dependencies: PreflightSchedulerDependencies) {}

  async committed(
    context: PreflightRunContext,
    attemptId: string,
    result: SummaryResult
  ): Promise<Result<PreflightTerminalOutcome>> {
    const committed = await this.dependencies.sessions.commitLedgerEvent(
      context.input.sessionId,
      summaryCommittedEvent({ reservationId: context.reservationId, attemptId, result }),
      () => context.terminalAuthority.tryClaimSuccess()
    );
    if (!committed.ok) return err(committed.error);
    if (committed.value.kind === "rejected") return this.rejected("Summary", committed.value.reason);
    context.terminalAuthority.markDurable("success");
    return ok({
      kind: "committed",
      reservationId: context.reservationId,
      logicalOperationId: context.logicalOperationId,
      attemptId,
      result
    });
  }

  async failedOpen(
    context: Pick<PreflightRunContext, "input" | "reservationId" | "logicalOperationId" | "terminalAuthority">,
    reasonCode: PreflightFailureCode
  ): Promise<Result<PreflightTerminalOutcome>> {
    const terminalKind = reasonCode === "overall_timeout" ? "timeout" : "failure";
    if (!context.terminalAuthority.request(terminalKind)) return this.rejected("Failed-open", "authority-claimed");
    const committed = await this.dependencies.sessions.commitLedgerEvent(
      context.input.sessionId,
      summaryFailedOpenEvent({ reservationId: context.reservationId, reasonCode })
    );
    if (!committed.ok) return err(committed.error);
    if (committed.value.kind === "rejected") return this.rejected("Failed-open", committed.value.reason);
    context.terminalAuthority.markDurable(terminalKind);
    return ok({
      kind: "failed-open",
      reservationId: context.reservationId,
      logicalOperationId: context.logicalOperationId,
      reasonCode
    });
  }

  async cancelled(
    context: Pick<PreflightRunContext,
      "input" | "reservationId" | "logicalOperationId" | "signal" | "terminalAuthority">,
    reasonCode: "user_cancelled" | "scheduler_closed"
  ): Promise<Result<PreflightTerminalOutcome>> {
    if (!context.terminalAuthority.request("cancelled")) return this.rejected("Cancellation", "authority-claimed");
    const committed = await this.dependencies.sessions.commitLedgerEvent(
      context.input.sessionId,
      summaryCancelledEvent({ reservationId: context.reservationId, reasonCode })
    );
    if (!committed.ok) return err(committed.error);
    if (committed.value.kind === "rejected") return this.rejected("Cancellation", committed.value.reason);
    context.terminalAuthority.markDurable("cancelled");
    return ok({
      kind: "cancelled",
      reservationId: context.reservationId,
      logicalOperationId: context.logicalOperationId,
      reasonCode,
      reasonAvailable: context.signal.reason !== undefined,
      ...(context.signal.reason === undefined ? {} : { reason: context.signal.reason })
    });
  }

  async resolveExisting(
    sessionId: string,
    reservationId: string,
    logicalOperationId: string
  ): Promise<ExistingResolution> {
    const session = await this.dependencies.sessions.read(sessionId);
    if (!session.ok) throw session.error;
    const summary = projectSessionLedger(session.value.events).summary;
    if (summary.kind === "committed" || summary.kind === "failed-open" || summary.kind === "cancelled") {
      return { kind: "existing", reason: "terminal-replay" };
    }
    const committed = await this.dependencies.sessions.commitLedgerEvent(
      sessionId,
      summaryFailedOpenEvent({ reservationId, reasonCode: "orphaned_reservation" })
    );
    if (!committed.ok) throw committed.error;
    if (committed.value.kind === "rejected") {
      throw new StrongCodeError("SESSION_ERROR", `Orphan terminal commit was rejected: ${committed.value.reason}`);
    }
    return { kind: "failed-open", reservationId, logicalOperationId, reasonCode: "orphaned_reservation" };
  }

  private rejected(label: string, reason: string): Result<never> {
    return err(new StrongCodeError("SESSION_ERROR", `${label} commit was rejected: ${reason}`));
  }
}
