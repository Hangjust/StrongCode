import { parseSessionLedgerEvent } from "../src/sessions/session-ledger-events";
import { parseSessionJsonl } from "../src/sessions/session-jsonl";
import { eventsToConversationItems } from "../src/sessions/session";
import { ledgerEvent, reservation } from "./session-ledger-fixtures";

describe("session ledger event parsing", () => {
  it("loads strict legacy records and ignores ledger records in conversation projection", () => {
    // Given
    const legacy = JSON.stringify({
      type: "message",
      timestamp: "legacy timestamp",
      role: "user",
      content: "legacy prompt"
    });
    const source = `${JSON.stringify(reservation())}\n${legacy}`;

    // When
    const session = parseSessionJsonl("legacy", source);

    // Then
    expect(eventsToConversationItems(session.events)).toEqual([
      { type: "text", role: "user", content: "legacy prompt" }
    ]);
  });

  it.each([
    ["legacy version", { type: "message", version: 1, timestamp: "x", role: "user", content: "x" }],
    ["missing ledger version", { ...reservation(), version: undefined }],
    ["wrong ledger version", { ...reservation(), version: 2 }],
    ["unknown ledger type", { ...reservation(), type: "summary_reopened" }],
    ["unknown ledger field", { ...reservation(), surprise: true }],
    ["noncanonical timestamp", { ...reservation(), timestamp: "2026-07-15T00:00:00Z" }],
    ["whitespace reservation", { ...reservation(), originalPrompt: " \t" }]
  ])("rejects %s", (_label, record) => {
    expect(() => parseSessionJsonl("invalid", JSON.stringify(record))).toThrow();
  });

  it.each([
    "{bad-json}\n",
    `${JSON.stringify(reservation())}\n{bad-json}\n${JSON.stringify(reservation("later"))}\n`,
    `${JSON.stringify(reservation())}\n{\"type\":`
  ])("rejects every malformed nonblank line", source => {
    expect(() => parseSessionJsonl("malformed", source)).toThrow();
  });

  it("accepts blank lines and a valid unterminated final record", () => {
    const session = parseSessionJsonl("valid", ` \n\n${JSON.stringify(reservation())}`);
    expect(session.events).toEqual([reservation()]);
  });

  it("rejects malformed committed advice and invalid nested telemetry", () => {
    const committed = ledgerEvent("summary_committed", "commit", {
      reservationId: "reservation-1",
      attemptId: "attempt-1",
      result: { title: "Valid title", generalSummary: "summary", requestedItems: [] }
    });
    if (committed.type !== "summary_committed") throw new Error("fixture type mismatch");
    expect(() => parseSessionLedgerEvent({
      ...committed,
      result: { ...committed.result, title: "bad\u001btitle", extra: true }
    })).toThrow();
    expect(() => parseSessionLedgerEvent({ ...committed, timestamp: "invalid" })).toThrow();
    expect(() => parseSessionLedgerEvent({
      type: "attempt_usage",
      version: 1,
      eventId: "empty-provider-usage",
      timestamp: "2026-07-15T00:00:00.000Z",
      attemptId: "attempt",
      providerRef: "provider",
      modelRef: "model",
      scope: "exclusive",
      providerUsage: []
    })).toThrow();
  });

  it.each([Number.MAX_SAFE_INTEGER + 1, 1e308])("rejects unsafe persisted provider token values: %s", tokens => {
    // Given / When / Then
    expect(() => parseSessionLedgerEvent({
      type: "attempt_usage",
      version: 1,
      eventId: `unsafe-token-${tokens}`,
      timestamp: "2026-07-15T00:00:00.000Z",
      attemptId: "attempt",
      providerRef: "provider",
      modelRef: "model",
      scope: "exclusive",
      providerUsage: [{
        source: "provider-reported",
        provider: "provider",
        field: "total_tokens",
        category: "total",
        tokens,
        semantics: "reported-total"
      }]
    })).toThrow();
  });
});
