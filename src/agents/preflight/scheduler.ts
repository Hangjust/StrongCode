import { StrongCodeError } from "../../core/errors";
import { err, ok, type Result } from "../../core/result";
import { PreflightDirectRun } from "./scheduler-direct";
import { resolvePreflightLimits } from "./scheduler-limits";
import { PreflightTerminalWriter } from "./scheduler-terminal";
import { PreflightTerminalAuthority } from "./scheduler-terminal-authority";
import type {
  PreflightOutcome,
  PreflightScheduleInput,
  PreflightSchedulerDependencies,
  PreflightTerminalOutcome
} from "./scheduler-types";
import { PreflightTraceWriter } from "./scheduler-trace";

function placeholderTerminal(reservationId: string, logicalOperationId: string): PreflightTerminalOutcome {
  return { kind: "failed-open", reservationId, logicalOperationId, reasonCode: "internal_error" };
}

export class PreflightScheduler {
  private closed = false;
  private readonly activeTerminalRequests = new Set<(reason: unknown) => void>();
  private readonly activeRuns = new Set<Promise<Result<PreflightTerminalOutcome>>>();
  private readonly activeAdmissions = new Set<Promise<unknown>>();

  constructor(private readonly dependencies: PreflightSchedulerDependencies) {}

  async run(input: PreflightScheduleInput): Promise<Result<PreflightOutcome>> {
    if (this.closed) {
      throw new StrongCodeError("CANCELLED", "Preflight scheduler is closed");
    }
    if (input.originalPrompt.trim().length === 0) return ok({ kind: "ignored-empty" });
    if ((input.parentDepth ?? 0) > 0) {
      return ok({
        kind: "failed-open",
        reservationId: this.dependencies.ids.next(),
        logicalOperationId: this.dependencies.ids.next(),
        reasonCode: "nested_research_denied"
      });
    }
    const operationKey = this.dependencies.sessions.operationKey(input.sessionId);
    if (!operationKey.ok) return operationKey;
    const limits = resolvePreflightLimits(input.limits);
    if (!limits.ok) {
      throw new StrongCodeError(
        "VALIDATION_ERROR",
        `Invalid preflight limit narrowing: ${limits.field}`
      );
    }
    const runId = this.dependencies.ids.next();
    const trace = new PreflightTraceWriter({
      runId,
      generation: 0,
      clock: this.dependencies.clock,
      callback: this.dependencies.emitTrace
    });
    const direct = new PreflightDirectRun(this.dependencies);
    let immediate: Result<PreflightOutcome> | undefined;
    try {
      const admissionPromise = this.dependencies.registry.admit(
        operationKey.value,
        { sourceMessageId: input.sourceMessageId, originalPrompt: input.originalPrompt },
        async () => {
          const reserved = await this.dependencies.sessions.reserveFirstSummary(input.sessionId, {
            sourceMessageId: input.sourceMessageId,
            originalPrompt: input.originalPrompt
          });
          if (!reserved.ok) throw reserved.error;
          if (reserved.value.kind === "ignored-empty") {
            immediate = ok({ kind: "ignored-empty" });
            const reservationId = this.dependencies.ids.next();
            const logicalOperationId = this.dependencies.ids.next();
            return {
              runId,
              reservationId,
              logicalOperationId,
              identity: { sourceMessageId: input.sourceMessageId, originalPrompt: input.originalPrompt },
              done: Promise.resolve(ok<PreflightTerminalOutcome>(placeholderTerminal(reservationId, logicalOperationId)))
            };
          }
          if (reserved.value.kind === "rejected") {
            immediate = ok({ kind: "existing", reason: reserved.value.reason });
            const reservationId = this.dependencies.ids.next();
            const logicalOperationId = this.dependencies.ids.next();
            return {
              runId,
              reservationId,
              logicalOperationId,
              identity: { sourceMessageId: input.sourceMessageId, originalPrompt: input.originalPrompt },
              done: Promise.resolve(ok<PreflightTerminalOutcome>(placeholderTerminal(reservationId, logicalOperationId)))
            };
          }
          if (reserved.value.kind === "existing") {
            const existing = await direct.resolveExisting(
              input.sessionId,
              reserved.value.reservationId,
              reserved.value.logicalOperationId
            );
            immediate = ok(existing);
            return {
              runId,
              reservationId: reserved.value.reservationId,
              logicalOperationId: reserved.value.logicalOperationId,
              identity: { sourceMessageId: input.sourceMessageId, originalPrompt: input.originalPrompt },
              done: Promise.resolve(ok<PreflightTerminalOutcome>(existing.kind === "existing"
                ? placeholderTerminal(reserved.value.reservationId, reserved.value.logicalOperationId)
                : existing))
            };
          }
          const controller = new AbortController();
          let timedOut = false;
          let externalTerminal: Result<PreflightTerminalOutcome> | undefined;
          const terminalAuthority = new PreflightTerminalAuthority();
          const runContext = {
            input,
            reservationId: reserved.value.reservationId,
            logicalOperationId: reserved.value.logicalOperationId,
            limits: limits.value,
            signal: controller.signal,
            externalTerminal: () => externalTerminal,
            terminalAuthority,
            overallDeadlineAt: this.dependencies.clock.now() + limits.value.overallDeadlineMs,
            timedOut: () => timedOut,
            closed: () => this.closed,
            trace
          } as const;
          const terminal = new PreflightTerminalWriter(this.dependencies);
          if (this.closed || input.signal?.aborted) {
            const marker = new AbortController();
            marker.abort(this.closed ? new StrongCodeError("CANCELLED", "Preflight scheduler is closed") : input.signal?.reason);
            const done = terminal.cancelled(
              { ...runContext, signal: marker.signal },
              this.closed ? "scheduler_closed" : "user_cancelled"
            );
            this.activeRuns.add(done);
            void done.finally(() => this.activeRuns.delete(done));
            return {
              runId,
              reservationId: reserved.value.reservationId,
              logicalOperationId: reserved.value.logicalOperationId,
              identity: { sourceMessageId: input.sourceMessageId, originalPrompt: input.originalPrompt },
              done
            };
          }
          let terminalRequest: Promise<Result<PreflightTerminalOutcome>> | undefined;
          const execution = direct.execute(runContext).catch(() => terminal.failedOpen(runContext, "internal_error"));
          const requestCancellation = (reason: unknown): void => {
            if (!terminalAuthority.request("cancelled") || terminalRequest !== undefined) return;
            const marker = new AbortController();
            marker.abort(reason);
            terminalRequest = terminal.cancelled(
              { ...runContext, signal: marker.signal },
              this.closed ? "scheduler_closed" : "user_cancelled"
            );
            void terminalRequest.then(result => {
              if (result.ok) {
                externalTerminal = result;
                controller.abort(reason);
              }
            });
          };
          const requestTimeout = (): void => {
            if (!terminalAuthority.request("timeout") || terminalRequest !== undefined) return;
            timedOut = true;
            terminalRequest = terminal.failedOpen(runContext, "overall_timeout");
            void terminalRequest.then(result => {
              if (result.ok) {
                externalTerminal = result;
                controller.abort();
              }
            });
          };
          const forwardAbort = (): void => requestCancellation(input.signal?.reason);
          input.signal?.addEventListener("abort", forwardAbort, { once: true });
          if (input.signal?.aborted) forwardAbort();
          const timer = this.dependencies.clock.setTimer(requestTimeout, limits.value.overallDeadlineMs);
          this.activeTerminalRequests.add(requestCancellation);
          const done = execution.then(async result => {
            const requested = terminalRequest;
            if (requested === undefined) return result;
            const terminalResult = await requested;
            return terminalResult.ok ? terminalResult : result;
          }).finally(() => {
            this.dependencies.clock.clearTimer(timer);
            input.signal?.removeEventListener("abort", forwardAbort);
            this.activeTerminalRequests.delete(requestCancellation);
            this.activeRuns.delete(done);
          });
          this.activeRuns.add(done);
          return {
            runId,
            reservationId: reserved.value.reservationId,
            logicalOperationId: reserved.value.logicalOperationId,
            identity: { sourceMessageId: input.sourceMessageId, originalPrompt: input.originalPrompt },
            done
          };
        }
      );
      this.activeAdmissions.add(admissionPromise);
      let admission;
      try {
        admission = await admissionPromise;
      } finally {
        this.activeAdmissions.delete(admissionPromise);
      }
      if (admission.kind === "conflict") {
        return ok({ kind: "existing", reason: "owned-by-another-source" });
      }
      if (admission.kind === "joined") {
        return ok({
          kind: "in-progress",
          reservationId: admission.entry.reservationId,
          logicalOperationId: admission.entry.logicalOperationId,
          done: admission.entry.done
        });
      }
      if (immediate !== undefined) {
        this.dependencies.registry.remove(operationKey.value, runId);
        return immediate;
      }
      return ok({
        kind: "in-progress",
        reservationId: admission.entry.reservationId,
        logicalOperationId: admission.entry.logicalOperationId,
        done: admission.entry.done
      });
    } catch (error) {
      if (error instanceof StrongCodeError) return err(error);
      throw error;
    }
  }

  async close(reason?: unknown): Promise<void> {
    this.closed = true;
    const cancellation = reason ?? new StrongCodeError("CANCELLED", "Preflight scheduler is closed");
    for (const request of this.activeTerminalRequests) request(cancellation);
    await Promise.allSettled([...this.activeAdmissions]);
    for (const request of this.activeTerminalRequests) request(cancellation);
    await Promise.allSettled([...this.activeRuns]);
  }
}
