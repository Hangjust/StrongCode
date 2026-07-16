import {
  ledgerBreadthFirst,
  projectInclusiveAccounting,
  projectSessionLedger
} from "../src/sessions/session-ledger-projection";
import { creation, ledgerEvent, lifecycle, reservation, succeeded, usage } from "./session-ledger-fixtures";

describe("session ledger projection", () => {
  it("projects immutable summary ownership and requires a succeeded summary attempt", () => {
    // Given
    const attempt = "attempt-flash";
    const events = [reservation(), creation(attempt), ...succeeded(attempt), ledgerEvent("summary_committed", "commit", {
      reservationId: "reservation-1",
      attemptId: attempt,
      result: { title: "Stable title", generalSummary: "Stable summary", requestedItems: ["One", "Two"] }
    })];

    // When
    const projection = projectSessionLedger(events);

    // Then
    expect(projection.summary).toMatchObject({ kind: "committed", reservationId: "reservation-1" });
    expect(projectSessionLedger(events)).toEqual(projection);
  });

  it("treats an exact terminal replay under a new envelope as a no-op", () => {
    const terminal = ledgerEvent("summary_failed_open", "failed", {
      reservationId: "reservation-1", reasonCode: "route_exhausted"
    });
    const replay = ledgerEvent("summary_failed_open", "failed-retry", {
      reservationId: "reservation-1", reasonCode: "route_exhausted"
    });
    expect(projectSessionLedger([reservation(), terminal, replay]).summary).toEqual({
      kind: "failed-open", reservationId: "reservation-1", reasonCode: "route_exhausted"
    });
  });

  it.each([
    ["commit before success", [reservation(), creation("attempt-flash"), ledgerEvent("summary_committed", "commit", {
      reservationId: "reservation-1", attemptId: "attempt-flash",
      result: { title: "Title", generalSummary: "Summary", requestedItems: [] }
    })]],
    ["wrong reservation", [reservation(), creation("attempt-flash"), ...succeeded("attempt-flash"), ledgerEvent("summary_committed", "commit", {
      reservationId: "other", attemptId: "attempt-flash",
      result: { title: "Title", generalSummary: "Summary", requestedItems: [] }
    })]],
    ["second terminal", [reservation(), ledgerEvent("summary_failed_open", "failed", {
      reservationId: "reservation-1", reasonCode: "route_exhausted"
    }), ledgerEvent("summary_cancelled", "cancelled", {
      reservationId: "reservation-1", reasonCode: "user_cancelled"
    })]]
  ])("rejects stale summary state: %s", (_label, events) => {
    expect(() => projectSessionLedger(events)).toThrow();
  });

  it.each([
    ["success", [{ kind: "started" }, { kind: "ended", outcome: "succeeded" }]],
    ["failure", [{ kind: "started" }, { kind: "ended", outcome: "failed", code: "provider_error" }]],
    ["validation failure", [{ kind: "started" }, { kind: "validation_failed", code: "bad_output" }]],
    ["cancel before start", [{ kind: "cancelled", code: "user_cancelled" }]],
    ["cancel after start", [{ kind: "started" }, { kind: "cancelled", code: "user_cancelled" }]]
  ])("accepts the %s lifecycle", (_label, transitions) => {
    const events = [creation("attempt-flash"), ...transitions.map((transition, index) => (
      lifecycle("attempt-flash", `life-${index}`, transition)
    ))];
    expect(() => projectSessionLedger(events)).not.toThrow();
  });

  it.each([
    ["end before start", [{ kind: "ended", outcome: "succeeded" }]],
    ["validation before start", [{ kind: "validation_failed", code: "bad_output" }]],
    ["revival", [{ kind: "cancelled", code: "cancelled" }, { kind: "started" }]],
    ["terminal conflict", [{ kind: "started" }, { kind: "ended", outcome: "failed", code: "failed" }, { kind: "cancelled", code: "cancelled" }]]
  ])("rejects invalid lifecycle: %s", (_label, transitions) => {
    const events = [creation("attempt-flash"), ...transitions.map((transition, index) => (
      lifecycle("attempt-flash", `invalid-${index}`, transition)
    ))];
    expect(() => projectSessionLedger(events)).toThrow();
  });

  it("records usage before or after terminal without reviving lifecycle", () => {
    const before = projectSessionLedger([
      creation("attempt-flash"), usage("attempt-flash", 0.01), ...succeeded("attempt-flash")
    ]);
    const after = projectSessionLedger([
      creation("attempt-flash"), ...succeeded("attempt-flash"), usage("attempt-flash", 0.01)
    ]);
    expect(before.attempts.get("attempt-flash")?.status).toEqual({ kind: "succeeded" });
    expect(after.attempts.get("attempt-flash")?.status).toEqual({ kind: "succeeded" });
  });

  it("rejects dangling links, self-links, cycles, and divergent ownership", () => {
    expect(() => projectSessionLedger([creation("child", { parentAttemptId: "missing" })])).toThrow();
    expect(() => projectSessionLedger([creation("self", { parentAttemptId: "self" })])).toThrow();
    expect(() => projectSessionLedger([
      creation("a", { parentAttemptId: "b" }), creation("b", { parentAttemptId: "a" })
    ])).toThrow();
    expect(() => projectSessionLedger([
      creation("root"), creation("child", { parentAttemptId: "root" }),
      ledgerEvent("attempt_created", "create-child-other", {
        attemptId: "child", logicalOperationId: "operation-1", role: "summary",
        model: { modelRef: "flash", providerRef: "google" }
      })
    ])).toThrow();
  });

  it("uses parent-only deterministic BFS and excludes fork-only/disconnected attempts", () => {
    const projection = projectSessionLedger([
      creation("root"),
      creation("z-child", { parentAttemptId: "root" }),
      creation("a-child", { parentAttemptId: "root" }),
      creation("grandchild", { parentAttemptId: "a-child" }),
      creation("fork-only", { forkedFromAttemptId: "root" }),
      creation("disconnected")
    ]);
    expect(ledgerBreadthFirst(projection, "root").map(attempt => attempt.attemptId)).toEqual([
      "root", "a-child", "z-child", "grandchild"
    ]);
  });

  it("sums failed parent and successful child direct cost to USD 0.015", () => {
    const projection = projectSessionLedger([
      creation("attempt-flash"),
      lifecycle("attempt-flash", "flash-start", { kind: "started" }),
      lifecycle("attempt-flash", "flash-failed", { kind: "ended", outcome: "failed", code: "route_failed" }),
      usage("attempt-flash", 0.01),
      creation("attempt-gemma", { parentAttemptId: "attempt-flash" }),
      ...succeeded("attempt-gemma"),
      usage("attempt-gemma", 0.005)
    ]);
    const accounting = projectInclusiveAccounting(projection, "attempt-flash");
    expect(accounting.knownCurrencySubtotals).toEqual({ USD: 0.015 });
    expect(accounting.inclusiveCost).toEqual({ amount: 0.015, currency: "USD" });
    expect(accounting.tokens.inputTokens).toEqual({ known: 20, complete: true });
  });

  it("preserves multiple and unknown currencies and reports incomplete token buckets", () => {
    const projection = projectSessionLedger([
      creation("root"), ...succeeded("root"), usage("root", 0.01),
      creation("eur", { parentAttemptId: "root" }), ...succeeded("eur"), usage("eur", 0.02, {
        cost: { kind: "provider-reported", amount: 0.02, currency: "EUR" },
        usage: { inputTokens: 2 }
      }),
      creation("unknown", { parentAttemptId: "root" }), ...succeeded("unknown"), usage("unknown", 0.03, {
        cost: { kind: "provider-reported", amount: 0.03 }, usage: { outputTokens: 3 }
      })
    ]);
    const accounting = projectInclusiveAccounting(projection, "root");
    expect(accounting.knownCurrencySubtotals).toEqual({ EUR: 0.02, USD: 0.01 });
    expect(accounting.unknownCurrencyAmounts).toEqual([0.03]);
    expect(accounting.inclusiveCost).toBeUndefined();
    expect(accounting.tokens.totalTokens).toEqual({ known: 15, complete: false });
  });

  it("accepts exact domain duplicates but rejects divergent usage and pricing drift", () => {
    const direct = usage("attempt-flash", 0.01);
    const duplicate = usage("attempt-flash", 0.01, {}, "usage-retry");
    const projection = projectSessionLedger([creation("attempt-flash"), direct, duplicate]);
    expect(projection.attempts.get("attempt-flash")?.usage).toEqual(direct);
    expect(() => projectSessionLedger([
      creation("attempt-flash"), direct, usage("attempt-flash", 99, {}, "usage-retry")
    ])).toThrow();
    expect(() => projectSessionLedger([
      creation("attempt-flash"), usage("attempt-flash", 0.01, {
        cost: { kind: "estimated", amount: 0.01, currency: "USD", pricingVersion: "current-rates" }
      })
    ])).toThrow();
  });
});
