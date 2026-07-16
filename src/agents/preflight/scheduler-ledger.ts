import type { ModelResponse, DirectModelAttempt } from "../../models/provider";
import {
  attemptCreatedEvent,
  attemptLifecycleEvent,
  attemptUsageEvent,
  type LedgerCommitEvent
} from "../../sessions/session-ledger-events";
import type { SessionStore } from "../../sessions/session-store";
import type { PreflightFailureCode } from "./scheduler-types";
import type { PreflightStage } from "./scheduler-types";
import type { AttemptRole } from "./metadata";
import type { PreflightTraceWriter } from "./scheduler-trace";
import { estimateConfiguredCost } from "./scheduler-cost";

type AttemptRecorderDependencies = Readonly<{
  sessions: Pick<SessionStore, "commitLedgerEvent">;
  sessionId: string;
  logicalOperationId: string;
  role: AttemptRole;
  stage: PreflightStage | "primary";
  parentAttemptId?: string;
  ids: Readonly<{ next: () => string }>;
  resolveModelSnapshot: (input: Readonly<{
    role: AttemptRole;
    directAttempt?: DirectModelAttempt;
  }>) => Readonly<{
    modelRef: string;
    providerRef: string;
    displayName: string;
    contextWindowTokens?: number;
    pricing?: Readonly<{
      version: string;
      currency: string;
      inputPerMillion?: number;
      outputPerMillion?: number;
    }>;
  }>;
  trace?: PreflightTraceWriter;
}>;

export type RecordedCompletion = Readonly<{
  firstAttemptId: string;
  producingAttemptId: string;
}>;

export type AttemptRecordResult =
  | Readonly<{ ok: true; value: RecordedCompletion }>
  | Readonly<{ ok: false; code: PreflightFailureCode }>;

type PhysicalAttempt = Readonly<{
  attemptId: string;
  directAttempt?: DirectModelAttempt;
  usage?: ModelResponse["usage"];
  providerUsage?: ModelResponse["providerUsage"];
  providerCost?: ModelResponse["providerCost"];
  providerRequestId?: string;
  providerResponseId?: string;
}>;

type AttemptEvents = Readonly<{
  attemptId: string;
  events: readonly LedgerCommitEvent[];
}>;

function physicalAttempts(response: ModelResponse, ids: Readonly<{ next: () => string }>): readonly PhysicalAttempt[] {
  if (response.directAttempts !== undefined) {
    return response.directAttempts.map(directAttempt => ({
      attemptId: directAttempt.attemptId,
      directAttempt,
      usage: directAttempt.usage,
      providerUsage: directAttempt.providerUsage,
      providerCost: directAttempt.providerCost,
      providerRequestId: directAttempt.providerRequestId,
      providerResponseId: directAttempt.providerResponseId
    }));
  }
  return [{
    attemptId: ids.next(),
    usage: response.usage,
    providerUsage: response.providerUsage,
    providerCost: response.providerCost,
    providerRequestId: response.providerRequestId,
    providerResponseId: response.providerResponseId
  }];
}

function hasTelemetry(attempt: PhysicalAttempt): boolean {
  return attempt.usage !== undefined || attempt.providerUsage !== undefined
    || attempt.providerCost !== undefined || attempt.providerRequestId !== undefined
    || attempt.providerResponseId !== undefined;
}

export class PreflightAttemptRecorder {
  constructor(private readonly dependencies: AttemptRecorderDependencies) {}

  async recordResponse(response: ModelResponse, parentAttemptId?: string): Promise<AttemptRecordResult> {
    const initialParentAttemptId = parentAttemptId ?? this.dependencies.parentAttemptId;
    let attempts: readonly PhysicalAttempt[];
    let records: readonly AttemptEvents[];
    try {
      attempts = physicalAttempts(response, this.dependencies.ids);
      if (attempts.length === 0) throw new Error("Direct attempts must not be empty");
      records = attempts.map((attempt, index) => this.buildSucceededEvents(
        attempt,
        index === 0 ? initialParentAttemptId : attempts[index - 1]?.attemptId
      ));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      await this.recordFailure(initialParentAttemptId, "invalid_direct_attempt", true);
      return {
        ok: false,
        code: this.dependencies.stage === "finalizer" ? "finalizer_provider_failed" : "root_provider_failed"
      };
    }

    for (const record of records) {
      const committed = await this.commitEvents(record.events);
      if (!committed.ok) {
        if (committed.code === "provider_identity_collision") {
          await this.commitEvents([attemptLifecycleEvent({
            attemptId: record.attemptId,
            transition: { kind: "validation_failed", code: committed.code }
          })]);
        }
        return committed;
      }
    }
    const first = records[0];
    const last = records.at(-1);
    if (first === undefined || last === undefined) return { ok: false, code: "internal_error" };
    return { ok: true, value: { firstAttemptId: first.attemptId, producingAttemptId: last.attemptId } };
  }

  async recordFailure(
    parentAttemptId: string | undefined,
    code: string,
    validationFailure = false
  ): Promise<AttemptRecordResult> {
    return this.recordTerminal(parentAttemptId, code, validationFailure
      ? { kind: "validation_failed", code }
      : { kind: "ended", outcome: "failed", code });
  }

  async recordCancellation(parentAttemptId: string | undefined, code: string): Promise<AttemptRecordResult> {
    return this.recordTerminal(parentAttemptId, code, { kind: "cancelled", code });
  }

  private async recordTerminal(
    parentAttemptId: string | undefined,
    code: string,
    terminal: Readonly<{ kind: "validation_failed" | "cancelled"; code: string }>
      | Readonly<{ kind: "ended"; outcome: "failed"; code: string }>
  ): Promise<AttemptRecordResult> {
    const linkedParentAttemptId = parentAttemptId ?? this.dependencies.parentAttemptId;
    const attemptId = this.dependencies.ids.next();
    const snapshot = this.dependencies.resolveModelSnapshot({ role: this.dependencies.role });
    const committed = await this.commitEvents([
      attemptCreatedEvent({
        attemptId,
        logicalOperationId: this.dependencies.logicalOperationId,
        role: this.dependencies.role,
        model: snapshot,
        ...(linkedParentAttemptId === undefined ? {} : { parentAttemptId: linkedParentAttemptId })
      }),
      attemptLifecycleEvent({ attemptId, transition: { kind: "started" } }),
      attemptLifecycleEvent({ attemptId, transition: terminal })
    ]);
    return committed.ok
      ? { ok: true, value: { firstAttemptId: attemptId, producingAttemptId: attemptId } }
      : committed;
  }

  private buildSucceededEvents(attempt: PhysicalAttempt, parentAttemptId?: string): AttemptEvents {
    const snapshot = this.dependencies.resolveModelSnapshot({
      role: this.dependencies.role,
      ...(attempt.directAttempt === undefined ? {} : { directAttempt: attempt.directAttempt })
    });
    const context = snapshot.contextWindowTokens !== undefined && attempt.usage?.inputTokens !== undefined
      ? {
          context: {
            windowTokens: snapshot.contextWindowTokens,
            usedTokens: attempt.usage.inputTokens,
            provenance: "provider-reported" as const
          }
        }
      : {};
    const estimatedCost = attempt.providerCost === undefined
      ? estimateConfiguredCost(attempt.usage, snapshot.pricing)
      : undefined;
    const events: LedgerCommitEvent[] = [
      attemptCreatedEvent({
        attemptId: attempt.attemptId,
        logicalOperationId: this.dependencies.logicalOperationId,
        role: this.dependencies.role,
        model: snapshot,
        ...context,
        ...(parentAttemptId === undefined ? {} : { parentAttemptId })
      }),
      attemptLifecycleEvent({ attemptId: attempt.attemptId, transition: { kind: "started" } })
    ];
    if (hasTelemetry(attempt)) {
      events.push(attemptUsageEvent({
        attemptId: attempt.attemptId,
        providerRef: snapshot.providerRef,
        modelRef: snapshot.modelRef,
        scope: "exclusive",
        ...(attempt.usage === undefined ? {} : { usage: attempt.usage, usageProvenance: "provider-reported" }),
        ...(attempt.providerUsage === undefined ? {} : { providerUsage: attempt.providerUsage }),
        ...(attempt.providerRequestId === undefined ? {} : { providerRequestId: attempt.providerRequestId }),
        ...(attempt.providerResponseId === undefined ? {} : { providerResponseId: attempt.providerResponseId }),
        ...(attempt.providerCost === undefined ? {} : {
          cost: { kind: "provider-reported", ...attempt.providerCost }
        }),
        ...(estimatedCost === undefined ? {} : { cost: estimatedCost })
      }));
    }
    events.push(attemptLifecycleEvent({
      attemptId: attempt.attemptId,
      transition: { kind: "ended", outcome: "succeeded" }
    }));
    return { attemptId: attempt.attemptId, events };
  }

  private async commitEvents(events: readonly LedgerCommitEvent[]): Promise<AttemptRecordResult> {
    for (const event of events) {
      const committed = await this.dependencies.sessions.commitLedgerEvent(this.dependencies.sessionId, event);
      if (!committed.ok) return { ok: false, code: "internal_error" };
      if (committed.value.kind === "rejected") {
        const code = event.type === "attempt_usage" && committed.value.reason === "semantic-conflict"
          ? "provider_identity_collision"
          : "internal_error";
        this.dependencies.trace?.emit({
          kind: "validation",
          stage: this.dependencies.stage === "primary" ? "root" : this.dependencies.role === "summary" ? "root" : "child",
          code,
          ...(event.type === "attempt_usage" ? { attemptId: event.attemptId } : {})
        });
        return { ok: false, code };
      }
    }
    return { ok: true, value: { firstAttemptId: "", producingAttemptId: "" } };
  }
}
