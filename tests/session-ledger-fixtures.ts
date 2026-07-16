import type {
  AttemptCreatedEvent,
  AttemptLifecycleEvent,
  AttemptUsageEvent,
  SessionLedgerEvent,
  SummaryReservedEvent
} from "../src/sessions/session-ledger-events";
import { parseSessionLedgerEvent } from "../src/sessions/session-ledger-events";

const TIMESTAMP = "2026-07-15T00:00:00.000Z";

export function ledgerEvent(
  type: SessionLedgerEvent["type"],
  eventId: string,
  fields: Readonly<Record<string, unknown>>
): SessionLedgerEvent {
  return parseSessionLedgerEvent({ type, version: 1, eventId, timestamp: TIMESTAMP, ...fields });
}

export function reservation(eventId = "reservation-event"): SummaryReservedEvent {
  const event = ledgerEvent("summary_reserved", eventId, {
    reservationId: "reservation-1",
    logicalOperationId: "operation-1",
    sourceMessageId: "message-1",
    originalPrompt: "  exact prompt bytes  "
  });
  if (event.type !== "summary_reserved") throw new Error("reservation fixture type mismatch");
  return event;
}

export function creation(
  attemptId: string,
  fields: Readonly<Record<string, unknown>> = {}
): AttemptCreatedEvent {
  const event = ledgerEvent("attempt_created", `create-${attemptId}`, {
    attemptId,
    logicalOperationId: "operation-1",
    role: "summary",
    model: {
      modelRef: attemptId.includes("gemma") ? "gemma" : "flash",
      providerRef: "google",
      contextWindowTokens: 10_000,
      pricing: {
        version: "rates-2026-07",
        currency: "USD",
        inputPerMillion: 1,
        outputPerMillion: 2
      }
    },
    context: { windowTokens: 10_000, provenance: "configured" },
    ...fields
  });
  if (event.type !== "attempt_created") throw new Error("creation fixture type mismatch");
  return event;
}

export function lifecycle(
  attemptId: string,
  eventId: string,
  transition: Readonly<Record<string, unknown>>
): AttemptLifecycleEvent {
  const event = ledgerEvent("attempt_lifecycle", eventId, { attemptId, transition });
  if (event.type !== "attempt_lifecycle") throw new Error("lifecycle fixture type mismatch");
  return event;
}

export function usage(
  attemptId: string,
  amount: number,
  fields: Readonly<Record<string, unknown>> = {},
  eventId = `usage-${attemptId}`
): AttemptUsageEvent {
  const event = ledgerEvent("attempt_usage", eventId, {
    attemptId,
    providerRef: "google",
    modelRef: attemptId.includes("gemma") ? "gemma" : "flash",
    scope: "exclusive",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    usageProvenance: "provider-reported",
    providerRequestId: `request-${attemptId}`,
    providerResponseId: `response-${attemptId}`,
    cost: {
      kind: "estimated",
      amount,
      currency: "USD",
      pricingVersion: "rates-2026-07"
    },
    ...fields
  });
  if (event.type !== "attempt_usage") throw new Error("usage fixture type mismatch");
  return event;
}

export function succeeded(attemptId: string): readonly AttemptLifecycleEvent[] {
  return [
    lifecycle(attemptId, `start-${attemptId}`, { kind: "started" }),
    lifecycle(attemptId, `end-${attemptId}`, { kind: "ended", outcome: "succeeded" })
  ];
}
