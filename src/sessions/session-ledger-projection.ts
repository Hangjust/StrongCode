import type { SummaryResult } from "../agents/preflight/contracts";
import type { AttemptCreatedEvent, AttemptUsageEvent, SessionLedgerEvent, SummaryReservedEvent } from "./session-ledger-events";
import type { SessionEvent } from "./session";
import { isMeaningfulUserEvent } from "./session-history";
import { ledgerBreadthFirst, validateAttemptLineage } from "./session-ledger-lineage";
import { applyLifecycle, applyUsage, type MutableAttempt } from "./session-ledger-attempt-reducer";
import { LedgerProjectionError, type LedgerRejectionReason } from "./session-ledger-errors";
import { immutableClone, immutableLookup, type ImmutableLookup } from "./session-ledger-immutability";

export { LedgerProjectionError, type LedgerRejectionReason } from "./session-ledger-errors";

export type AttemptStatus =
  | { readonly kind: "created" }
  | { readonly kind: "started" }
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly code: string }
  | { readonly kind: "validation-failed"; readonly code: string }
  | { readonly kind: "cancelled"; readonly code: string };

export type AttemptProjection = Readonly<{
  attemptId: string;
  created: AttemptCreatedEvent;
  status: AttemptStatus;
  started: boolean;
  usage?: AttemptUsageEvent;
}>;

export type SummaryProjection =
  | { readonly kind: "unreserved" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "reserved"; readonly reservation: SummaryReservedEvent }
  | { readonly kind: "committed"; readonly reservationId: string; readonly attemptId: string; readonly result: SummaryResult }
  | { readonly kind: "failed-open"; readonly reservationId: string; readonly reasonCode: string }
  | { readonly kind: "cancelled"; readonly reservationId: string; readonly reasonCode: string };

export type SessionLedgerProjection = Readonly<{
  summary: SummaryProjection;
  attempts: ImmutableLookup<string, AttemptProjection>;
}>;

export type LedgerEventAdmission =
  | { readonly kind: "committed" }
  | { readonly kind: "duplicate" }
  | { readonly kind: "rejected"; readonly reason: LedgerRejectionReason };

function payloadSignature(event: SessionLedgerEvent): string {
  const { eventId: _eventId, timestamp: _timestamp, ...payload } = event;
  return JSON.stringify(payload);
}

function domain(event: SessionLedgerEvent): Readonly<{ key: string; reason: LedgerRejectionReason }> {
  switch (event.type) {
    case "summary_reserved": return { key: "summary:reservation", reason: "semantic-conflict" };
    case "summary_committed":
    case "summary_failed_open":
    case "summary_cancelled": return { key: "summary:terminal", reason: "stale" };
    case "attempt_created": return { key: `created:${event.attemptId}`, reason: "semantic-conflict" };
    case "attempt_usage": return { key: `usage:${event.attemptId}`, reason: "semantic-conflict" };
    case "attempt_lifecycle": return event.transition.kind === "started"
      ? { key: `lifecycle:${event.attemptId}:started`, reason: "invalid-transition" }
      : { key: `lifecycle:${event.attemptId}:terminal`, reason: "invalid-transition" };
    default: return assertNever(event);
  }
}

function uniqueLedgerEvents(events: readonly SessionEvent[]): readonly SessionLedgerEvent[] {
  const eventIds = new Map<string, string>();
  const domains = new Map<string, string>();
  const unique: SessionLedgerEvent[] = [];
  for (const event of events) {
    if (event.type === "message" || event.type === "tool" || event.type === "conversation_item"
      || event.type === "compaction_checkpoint") continue;
    const full = JSON.stringify(event);
    const knownEvent = eventIds.get(event.eventId);
    if (knownEvent !== undefined) {
      if (knownEvent !== full) throw new LedgerProjectionError("semantic-conflict", `Event ID '${event.eventId}' diverged`);
      continue;
    }
    eventIds.set(event.eventId, full);
    const descriptor = domain(event);
    const payload = payloadSignature(event);
    const knownDomain = domains.get(descriptor.key);
    if (knownDomain !== undefined) {
      if (knownDomain !== payload) throw new LedgerProjectionError(descriptor.reason, `Ledger domain '${descriptor.key}' diverged`);
      continue;
    }
    domains.set(descriptor.key, payload);
    unique.push(event);
  }
  return unique;
}

function assertNever(value: never): never {
  throw new LedgerProjectionError("semantic-conflict", `Unexpected ledger variant: ${JSON.stringify(value)}`);
}

export function projectSessionLedger(events: readonly SessionEvent[]): SessionLedgerProjection {
  const unique = uniqueLedgerEvents(events);
  const attempts = new Map<string, MutableAttempt>();
  for (const event of unique) {
    if (event.type !== "attempt_created") continue;
    if (event.context !== undefined && event.model.contextWindowTokens !== undefined
      && event.context.windowTokens !== event.model.contextWindowTokens) {
      throw new LedgerProjectionError("semantic-conflict", "Attempt context windows differ");
    }
    attempts.set(event.attemptId, { created: event, status: { kind: "created" }, started: false });
  }

  let summary: SummaryProjection = events.some(isMeaningfulUserEvent)
    ? { kind: "unavailable" }
    : { kind: "unreserved" };
  let meaningfulHistory = false;
  const createdSeen = new Set<string>();
  const providerIdentities = { requests: new Map<string, string>(), responses: new Map<string, string>() };
  for (const event of events) {
    if (event.type === "message") {
      if (isMeaningfulUserEvent(event)) meaningfulHistory = true;
      continue;
    }
    if (event.type === "conversation_item") {
      if (isMeaningfulUserEvent(event)) meaningfulHistory = true;
      continue;
    }
    if (event.type === "tool" || event.type === "compaction_checkpoint") continue;
    if (!unique.includes(event)) continue;
    switch (event.type) {
      case "summary_reserved":
        if (meaningfulHistory) throw new LedgerProjectionError("stale", "Summary reservation follows meaningful user history");
        summary = { kind: "reserved", reservation: event };
        break;
      case "summary_committed": {
        if (summary.kind !== "reserved" || summary.reservation.reservationId !== event.reservationId) {
          throw new LedgerProjectionError("stale", "Summary commit does not own the active reservation");
        }
        const attempt = attempts.get(event.attemptId);
        if (attempt?.status.kind !== "succeeded" || attempt.created.role !== "summary"
          || attempt.created.logicalOperationId !== summary.reservation.logicalOperationId) {
          throw new LedgerProjectionError("stale", "Summary commit requires a succeeded summary attempt");
        }
        summary = { kind: "committed", reservationId: event.reservationId, attemptId: event.attemptId, result: event.result };
        break;
      }
      case "summary_failed_open":
      case "summary_cancelled":
        if (summary.kind !== "reserved" || summary.reservation.reservationId !== event.reservationId) {
          throw new LedgerProjectionError("stale", "Summary terminal event does not own the active reservation");
        }
        summary = event.type === "summary_failed_open"
          ? { kind: "failed-open", reservationId: event.reservationId, reasonCode: event.reasonCode }
          : { kind: "cancelled", reservationId: event.reservationId, reasonCode: event.reasonCode };
        break;
      case "attempt_created":
        createdSeen.add(event.attemptId);
        break;
      case "attempt_lifecycle": {
        const attempt = attempts.get(event.attemptId);
        if (attempt === undefined || !createdSeen.has(event.attemptId)) {
          throw new LedgerProjectionError("invalid-transition", "Attempt lifecycle precedes creation");
        }
        applyLifecycle(attempt, event);
        break;
      }
      case "attempt_usage": {
        const attempt = attempts.get(event.attemptId);
        if (attempt === undefined || !createdSeen.has(event.attemptId)) {
          throw new LedgerProjectionError("invalid-transition", "Attempt usage precedes creation");
        }
        applyUsage(attempt, event, providerIdentities);
        break;
      }
      default: assertNever(event);
    }
  }
  const projected = new Map<string, AttemptProjection>();
  for (const [attemptId, attempt] of attempts) projected.set(attemptId, immutableClone({ attemptId, ...attempt }));
  try {
    validateAttemptLineage(projected);
  } catch (error) {
    if (error instanceof Error) throw new LedgerProjectionError("invalid-lineage", error.message);
    throw error;
  }
  return Object.freeze({ summary: immutableClone(summary), attempts: immutableLookup(projected) });
}

export function admitLedgerEvent(
  events: readonly SessionEvent[],
  candidate: SessionLedgerEvent
): LedgerEventAdmission {
  projectSessionLedger(events);
  try {
    const combined = [...events, candidate];
    const unique = uniqueLedgerEvents(combined);
    projectSessionLedger(combined);
    return unique.includes(candidate) ? { kind: "committed" } : { kind: "duplicate" };
  } catch (error) {
    if (error instanceof LedgerProjectionError) return { kind: "rejected", reason: error.reason };
    throw error;
  }
}

export { ledgerBreadthFirst };
export { projectInclusiveAccounting, type InclusiveAccounting } from "./session-ledger-accounting";
