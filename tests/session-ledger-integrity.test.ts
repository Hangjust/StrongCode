import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  SessionStore,
  parseSessionLedgerEvent,
  projectSessionLedger,
  type AttemptCreatedEvent,
  type AttemptLifecycleEvent,
  type AttemptUsageEvent,
  type LedgerCommitEvent,
  type SessionLedgerEvent,
  type SummaryCommittedEvent,
  type SummaryReservedEvent
} from "../src/index";
import { tempWorkspace } from "./helpers";

const TIMESTAMP = "2026-07-15T00:00:00.000Z";

type UsageOverrides = Readonly<{
  usage: NonNullable<AttemptUsageEvent["usage"]>;
  usageProvenance: NonNullable<AttemptUsageEvent["usageProvenance"]>;
  cost: NonNullable<AttemptUsageEvent["cost"]>;
}>;

function event(type: SessionLedgerEvent["type"], eventId: string, fields: Readonly<Record<string, unknown>>): SessionLedgerEvent {
  return parseSessionLedgerEvent({ type, version: 1, eventId, timestamp: TIMESTAMP, ...fields });
}

function reserved(operationId = "operation-a"): SummaryReservedEvent {
  const value = event("summary_reserved", `reserve-${operationId}`, {
    reservationId: "reservation", logicalOperationId: operationId,
    sourceMessageId: "source", originalPrompt: "prompt"
  });
  if (value.type !== "summary_reserved") throw new Error("reservation fixture mismatch");
  return value;
}

function created(
  attemptId: string,
  operationId: string,
  fields: Readonly<Record<string, unknown>> = {}
): AttemptCreatedEvent {
  const value = event("attempt_created", `create-${attemptId}`, {
    attemptId, logicalOperationId: operationId, role: "summary",
    model: { modelRef: attemptId, providerRef: "provider-a" }, ...fields
  });
  if (value.type !== "attempt_created") throw new Error("creation fixture mismatch");
  return value;
}

function lifecycle(attemptId: string, eventId: string, transition: Readonly<Record<string, unknown>>): AttemptLifecycleEvent {
  const value = event("attempt_lifecycle", eventId, { attemptId, transition });
  if (value.type !== "attempt_lifecycle") throw new Error("lifecycle fixture mismatch");
  return value;
}

function succeeded(attemptId: string): readonly AttemptLifecycleEvent[] {
  return [
    lifecycle(attemptId, `start-${attemptId}`, { kind: "started" }),
    lifecycle(attemptId, `end-${attemptId}`, { kind: "ended", outcome: "succeeded" })
  ];
}

function summaryCommit(attemptId: string): SummaryCommittedEvent {
  const value = event("summary_committed", `commit-${attemptId}`, {
    reservationId: "reservation", attemptId,
    result: { title: "Title", generalSummary: "Summary", requestedItems: [] }
  });
  if (value.type !== "summary_committed") throw new Error("summary fixture mismatch");
  return value;
}

function usage(
  attempt: AttemptCreatedEvent,
  eventId: string,
  identities: Readonly<{ request?: string; response?: string }>,
  overrides?: UsageOverrides
): AttemptUsageEvent {
  const value = event("attempt_usage", eventId, {
    attemptId: attempt.attemptId,
    providerRef: attempt.model.providerRef,
    modelRef: attempt.model.modelRef,
    scope: "exclusive",
    ...(identities.request === undefined ? {} : { providerRequestId: identities.request }),
    ...(identities.response === undefined ? {} : { providerResponseId: identities.response }),
    cost: { kind: "provider-reported", amount: 0.01, currency: "USD" },
    ...(overrides === undefined ? {} : overrides)
  });
  if (value.type !== "attempt_usage") throw new Error("usage fixture mismatch");
  return value;
}

async function commit(store: SessionStore, sessionId: string, ledgerEvent: LedgerCommitEvent): Promise<string> {
  const result = await store.commitLedgerEvent(sessionId, ledgerEvent);
  if (!result.ok) throw result.error;
  return result.value.kind === "rejected" ? result.value.reason : result.value.kind;
}

describe("session ledger integrity boundaries", () => {
  it.each(["summary", "analysis", "explorer"] as const)(
    "rejects a succeeded %s attempt outside reservation ownership",
    role => {
      const attempt = created("foreign", role === "summary" ? "operation-b" : "operation-a", { role });
      expect(() => projectSessionLedger([reserved(), attempt, ...succeeded(attempt.attemptId), summaryCommit(attempt.attemptId)]))
        .toThrow();
    }
  );

  it("rejects a foreign summary commit through CAS without changing bytes", async () => {
    const workspace = await tempWorkspace();
    const store = new SessionStore(workspace.context.dataDir);
    const reservation = await store.reserveFirstSummary("summary-owner", { sourceMessageId: "source", originalPrompt: "prompt" });
    if (!reservation.ok || reservation.value.kind !== "reserved") throw new Error("reservation failed");
    const attempt = created("foreign", "operation-b");
    for (const ledgerEvent of [attempt, ...succeeded(attempt.attemptId)]) await commit(store, "summary-owner", ledgerEvent);
    const filePath = path.join(workspace.context.dataDir, "sessions", "summary-owner.jsonl");
    const before = await readFile(filePath);
    const candidate = event("summary_committed", "foreign-commit", {
      reservationId: reservation.value.reservationId,
      attemptId: attempt.attemptId,
      result: { title: "Title", generalSummary: "Summary", requestedItems: [] }
    });
    if (candidate.type !== "summary_committed") throw new Error("summary fixture mismatch");
    expect(await commit(store, "summary-owner", candidate)).toBe("stale");
    expect(await readFile(filePath)).toEqual(before);
  });

  it.each(["parentAttemptId", "forkedFromAttemptId"] as const)(
    "rejects a cross-operation %s during replay and CAS",
    async linkField => {
      const root = created("root", "operation-a");
      const child = created("child", "operation-b", { [linkField]: root.attemptId });
      expect(() => projectSessionLedger([root, child])).toThrow();
      const workspace = await tempWorkspace();
      const store = new SessionStore(workspace.context.dataDir);
      await commit(store, "lineage", root);
      const filePath = path.join(workspace.context.dataDir, "sessions", "lineage.jsonl");
      const before = await readFile(filePath);
      expect(await commit(store, "lineage", child)).toBe("invalid-lineage");
      expect(await readFile(filePath)).toEqual(before);
    }
  );

  it.each([
    ["request only", { request: "request-1" }, { request: "request-1" }],
    ["response only", { response: "response-1" }, { response: "response-1" }],
    ["both IDs", { request: "request-1", response: "response-1" }, { request: "request-1", response: "response-1" }]
  ] as const)("rejects same-provider physical identity collision: %s", async (_label, firstIds, secondIds) => {
    const first = created("first-model", "operation-a");
    const second = created("second-model", "operation-a");
    const divergentUsage = {
      inputTokens: 900,
      outputTokens: 90,
      totalTokens: 990
    } satisfies NonNullable<AttemptUsageEvent["usage"]>;
    const divergentCost = {
      kind: "provider-reported",
      amount: 99,
      currency: "USD"
    } satisfies NonNullable<AttemptUsageEvent["cost"]>;
    const firstUsage: AttemptUsageEvent = usage(first, "usage-first", firstIds);
    const candidate: AttemptUsageEvent = usage(second, "usage-second", secondIds, {
      usage: divergentUsage,
      usageProvenance: "provider-reported",
      cost: divergentCost
    });
    const normalizedSecondIds: Readonly<{ request?: string; response?: string }> = secondIds;
    const collisionFreeIds = {
      ...(normalizedSecondIds.request === undefined ? {} : { request: `${normalizedSecondIds.request}-unique` }),
      ...(normalizedSecondIds.response === undefined ? {} : { response: `${normalizedSecondIds.response}-unique` })
    };
    const collisionFreeTwin: AttemptUsageEvent = usage(second, "usage-collision-free", collisionFreeIds, {
      usage: divergentUsage,
      usageProvenance: "provider-reported",
      cost: divergentCost
    });

    expect(candidate.usage).toEqual(divergentUsage);
    expect(candidate.usageProvenance).toBe("provider-reported");
    expect(candidate.cost).toEqual(divergentCost);
    expect(candidate.usage).not.toEqual(firstUsage.usage);
    expect(candidate.cost).not.toEqual(firstUsage.cost);
    expect({ request: candidate.providerRequestId, response: candidate.providerResponseId }).toEqual({
      request: firstUsage.providerRequestId,
      response: firstUsage.providerResponseId
    });
    expect(() => projectSessionLedger([second, candidate])).not.toThrow();
    expect(() => projectSessionLedger([first, second, firstUsage, collisionFreeTwin])).not.toThrow();
    expect(() => projectSessionLedger([first, second, firstUsage, candidate]))
      .toThrow("Provider identity is already owned by another attempt");

    const workspace = await tempWorkspace();
    const store = new SessionStore(workspace.context.dataDir);
    for (const ledgerEvent of [first, second, firstUsage]) await commit(store, "provider", ledgerEvent);
    const filePath = path.join(workspace.context.dataDir, "sessions", "provider.jsonl");
    const before = await readFile(filePath);
    expect(await commit(store, "provider", candidate)).toBe("semantic-conflict");
    expect(await readFile(filePath)).toEqual(before);
  });

  it("keeps request/response namespaces separate and permits reuse across providers", () => {
    const first = created("first", "operation-a");
    const sameProvider = created("second", "operation-a");
    const otherProvider = created("third", "operation-a", {
      model: { modelRef: "third", providerRef: "provider-b" }
    });
    expect(() => projectSessionLedger([
      first,
      sameProvider,
      otherProvider,
      usage(first, "usage-first", { request: "shared" }),
      usage(sameProvider, "usage-second", { response: "shared" }),
      usage(otherProvider, "usage-third", { request: "shared", response: "shared" })
    ])).not.toThrow();
  });
});
