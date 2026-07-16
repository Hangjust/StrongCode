import type { Session } from "./session";
import { isMeaningfulUserEvent } from "./session-history";
import {
  createSummaryReservation,
  type LedgerCommitEvent,
  type SessionLedgerEvent
} from "./session-ledger-events";
import { admitLedgerEvent, type LedgerEventAdmission } from "./session-ledger-projection";

export type SummaryReservationInput = {
  readonly sourceMessageId: string;
  readonly originalPrompt: string;
};
export type SummaryReservationOutcome =
  | { readonly kind: "ignored-empty" }
  | { readonly kind: "reserved"; readonly reservationId: string; readonly logicalOperationId: string }
  | { readonly kind: "existing"; readonly reservationId: string; readonly logicalOperationId: string }
  | { readonly kind: "rejected"; readonly reason: "owned-by-another-source" | "history-already-started" };
export type SessionLedgerCommitOutcome = LedgerEventAdmission;
export type SnapshotDecision<T> = Readonly<{ outcome: T; event?: SessionLedgerEvent }>;

export function decideSummaryReservation(
  session: Session,
  input: SummaryReservationInput
): SnapshotDecision<SummaryReservationOutcome> {
  const existing = session.events.find(event => event.type === "summary_reserved");
  if (existing !== undefined) {
    return existing.sourceMessageId === input.sourceMessageId && existing.originalPrompt === input.originalPrompt
      ? {
          outcome: {
            kind: "existing",
            reservationId: existing.reservationId,
            logicalOperationId: existing.logicalOperationId
          }
        }
      : { outcome: { kind: "rejected", reason: "owned-by-another-source" } };
  }
  const hasHistory = session.events.some(isMeaningfulUserEvent);
  if (hasHistory) return { outcome: { kind: "rejected", reason: "history-already-started" } };
  const event = createSummaryReservation(input);
  return {
    outcome: {
      kind: "reserved",
      reservationId: event.reservationId,
      logicalOperationId: event.logicalOperationId
    },
    event
  };
}

export function decideLedgerCommit(
  session: Session,
  event: LedgerCommitEvent
): SnapshotDecision<SessionLedgerCommitOutcome> {
  const admission = admitLedgerEvent(session.events, event);
  return admission.kind === "committed"
    ? { outcome: admission, event }
    : { outcome: admission };
}
