import {
  ledgerBreadthFirst,
  parseSessionLedgerEvent,
  projectInclusiveAccounting,
  projectSessionLedger,
  type SessionLedgerEvent
} from "../src/index";

const TIMESTAMP = "2026-07-15T00:00:00.000Z";

function event(type: SessionLedgerEvent["type"], eventId: string, fields: Readonly<Record<string, unknown>>): SessionLedgerEvent {
  return parseSessionLedgerEvent({ type, version: 1, eventId, timestamp: TIMESTAMP, ...fields });
}

function blocked(mutation: () => unknown): void {
  let outcome: unknown;
  try {
    outcome = mutation();
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return;
  }
  expect(outcome).toBe(false);
}

describe("session ledger runtime immutability", () => {
  it("deep-freezes every public projection, BFS, and accounting level", () => {
    const rawModel = {
      modelRef: "flash",
      providerRef: "google",
      contextWindowTokens: 10_000,
      pricing: { version: "rates-v1", currency: "USD", inputPerMillion: 1, outputPerMillion: 2 }
    };
    const rawRequestedItems = ["One", "Two"];
    const reservation = event("summary_reserved", "reserve", {
      reservationId: "reservation", logicalOperationId: "operation",
      sourceMessageId: "source", originalPrompt: "prompt"
    });
    const creation = event("attempt_created", "create", {
      attemptId: "attempt", logicalOperationId: "operation", role: "summary", model: rawModel,
      context: { windowTokens: 10_000, usedTokens: 100, provenance: "configured" }
    });
    const started = event("attempt_lifecycle", "start", { attemptId: "attempt", transition: { kind: "started" } });
    const ended = event("attempt_lifecycle", "end", {
      attemptId: "attempt", transition: { kind: "ended", outcome: "succeeded" }
    });
    const usage = event("attempt_usage", "usage", {
      attemptId: "attempt", providerRef: "google", modelRef: "flash", scope: "exclusive",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      usageProvenance: "provider-reported",
      providerUsage: [{
        source: "provider-reported", provider: "google", field: "input_tokens",
        category: "input", tokens: 10, semantics: "exclusive"
      }],
      providerRequestId: "request", providerResponseId: "response",
      cost: { kind: "estimated", amount: 0.01, currency: "USD", pricingVersion: "rates-v1" }
    });
    const committed = event("summary_committed", "commit", {
      reservationId: "reservation", attemptId: "attempt",
      result: { title: "Title", generalSummary: "Summary", requestedItems: rawRequestedItems }
    });
    const projection = projectSessionLedger([reservation, creation, started, ended, usage, committed]);
    const attempt = projection.attempts.get("attempt");
    if (attempt === undefined) throw new Error("attempt fixture missing");
    const attemptUsage = attempt.usage;
    if (attemptUsage === undefined) throw new Error("usage fixture missing");
    const cost = attemptUsage.cost;
    if (cost === undefined) throw new Error("cost fixture missing");
    const normalizedUsage = attemptUsage.usage;
    if (normalizedUsage === undefined) throw new Error("normalized usage fixture missing");
    const providerUsage = attemptUsage.providerUsage;
    if (providerUsage === undefined) throw new Error("provider usage fixture missing");
    const firstMetric = providerUsage[0];
    if (firstMetric === undefined) throw new Error("provider metric fixture missing");
    const pricing = attempt.created.model.pricing;
    if (pricing === undefined) throw new Error("pricing fixture missing");
    const context = attempt.created.context;
    if (context === undefined) throw new Error("context fixture missing");
    if (projection.summary.kind !== "committed") throw new Error("committed summary fixture missing");
    const requestedItems = projection.summary.result.requestedItems;
    const bfs = ledgerBreadthFirst(projection, "attempt");
    const accounting = projectInclusiveAccounting(projection, "attempt");
    const inclusiveCost = accounting.inclusiveCost;
    if (inclusiveCost === undefined) throw new Error("inclusive cost fixture missing");

    expect(Reflect.get(projection.attempts, "set")).toBeUndefined();
    expect(Reflect.ownKeys(projection.attempts)).toEqual([]);
    blocked(() => Reflect.set(attempt.status, "kind", "failed"));
    blocked(() => Reflect.set(cost, "amount", 99));
    blocked(() => Reflect.set(normalizedUsage, "inputTokens", 99));
    blocked(() => Reflect.apply(Array.prototype.push, providerUsage, [{ ...firstMetric }]));
    blocked(() => Reflect.set(firstMetric, "tokens", 99));
    blocked(() => Reflect.set(pricing, "inputPerMillion", 99));
    blocked(() => Reflect.set(context, "windowTokens", 99));
    blocked(() => Reflect.apply(Array.prototype.push, requestedItems, ["Three"]));
    blocked(() => Reflect.apply(Array.prototype.push, bfs, [attempt]));
    blocked(() => Reflect.set(accounting.knownCurrencySubtotals, "USD", 99));
    blocked(() => Reflect.set(accounting.tokens.inputTokens, "known", 99));
    blocked(() => Reflect.apply(Array.prototype.push, accounting.unknownCurrencyAmounts, [99]));
    blocked(() => Reflect.set(inclusiveCost, "amount", 99));

    expect(attempt.status.kind).toBe("succeeded");
    expect(cost.amount).toBe(0.01);
    expect(normalizedUsage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(providerUsage).toHaveLength(1);
    expect(firstMetric.tokens).toBe(10);
    expect(pricing.inputPerMillion).toBe(1);
    expect(context.windowTokens).toBe(10_000);
    expect(requestedItems).toEqual(["One", "Two"]);
    expect(bfs.map(item => item.attemptId)).toEqual(["attempt"]);
    expect(accounting.knownCurrencySubtotals).toEqual({ USD: 0.01 });
    expect(accounting.unknownCurrencyAmounts).toEqual([]);
    expect(accounting.tokens.inputTokens).toEqual({ known: 10, complete: true });
    expect(inclusiveCost).toEqual({ amount: 0.01, currency: "USD" });

    const repeatedAccounting = projectInclusiveAccounting(projection, "attempt");
    expect(repeatedAccounting.inclusiveCost).toEqual({ amount: 0.01, currency: "USD" });
    expect(repeatedAccounting.tokens.inputTokens).toEqual({ known: 10, complete: true });
    const repeatedProjection = projectSessionLedger([reservation, creation, started, ended, usage, committed]);
    const repeatedAttempt = repeatedProjection.attempts.get("attempt");
    if (repeatedAttempt === undefined) throw new Error("repeated attempt fixture missing");
    expect(repeatedAttempt.status.kind).toBe("succeeded");
    expect(repeatedProjection.summary).toMatchObject({ kind: "committed", result: { requestedItems: ["One", "Two"] } });
  });

  it("clones caller inputs and projected source events before exposing them", () => {
    const raw = {
      type: "attempt_created",
      version: 1,
      eventId: "create",
      timestamp: TIMESTAMP,
      attemptId: "attempt",
      logicalOperationId: "operation",
      role: "summary",
      model: { modelRef: "flash", providerRef: "google", pricing: { version: "v1", currency: "USD", inputPerMillion: 1 } }
    };
    const parsed = parseSessionLedgerEvent(raw);
    if (parsed.type !== "attempt_created") throw new Error("creation fixture type mismatch");
    const parsedPricing = parsed.model.pricing;
    if (parsedPricing === undefined) throw new Error("parsed pricing fixture missing");
    raw.model.pricing.inputPerMillion = 99;
    const projection = projectSessionLedger([parsed]);
    const projectedAttempt = projection.attempts.get("attempt");
    if (projectedAttempt === undefined) throw new Error("projected attempt fixture missing");
    const projectedPricing = projectedAttempt.created.model.pricing;
    if (projectedPricing === undefined) throw new Error("projected pricing fixture missing");
    Reflect.set(parsed, "attemptId", "mutated");
    Reflect.set(parsedPricing, "inputPerMillion", 77);
    expect(projection.attempts.has("attempt")).toBe(true);
    expect(projectedPricing.inputPerMillion).toBe(1);
  });
});
