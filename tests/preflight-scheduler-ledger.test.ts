import { describe, expect, it } from "vitest";
import type { SessionLedgerEvent } from "../src/sessions/session-ledger-events";
import {
  completeDecision,
  finalResult,
  finding,
  modelResponse,
  researchDecision,
  responseWithIdentity,
  scheduleInput,
  schedulerHarness,
  terminal
} from "./fixtures/preflight-scheduler-harness";

async function ledger(harness: Awaited<ReturnType<typeof schedulerHarness>>): Promise<readonly SessionLedgerEvent[]> {
  const session = await harness.sessions.read("preflight-session");
  if (!session.ok) throw session.error;
  return session.value.events.filter((event): event is SessionLedgerEvent => event.type !== "message");
}

describe("PreflightScheduler ledger", () => {
  it("records one ordered lifecycle for a direct summary attempt", async () => {
    const harness = await schedulerHarness();
    harness.models.enqueue("summary", completeDecision());
    await terminal(await harness.scheduler.run(scheduleInput(harness)));
    const events = await ledger(harness);
    expect(events.map(event => event.type)).toEqual([
      "summary_reserved",
      "attempt_created",
      "attempt_lifecycle",
      "attempt_lifecycle",
      "summary_committed"
    ]);
    const lifecycles = events.filter(event => event.type === "attempt_lifecycle");
    expect(lifecycles.map(event => event.transition)).toEqual([
      { kind: "started" },
      { kind: "ended", outcome: "succeeded" }
    ]);
  });

  it("chains a tool continuation from its producing attempt", async () => {
    const harness = await schedulerHarness();
    harness.models.enqueue(
      "summary",
      modelResponse("", [{ callId: "read", name: "read_file", input: {} }]),
      completeDecision()
    );
    await terminal(await harness.scheduler.run(scheduleInput(harness)));
    const creations = (await ledger(harness)).filter(event => event.type === "attempt_created");
    expect(creations).toHaveLength(2);
    expect(creations[1]?.parentAttemptId).toBe(creations[0]?.attemptId);
    expect(creations.map(event => event.role)).toEqual(["summary", "summary"]);
  });

  it("records child and finalizer lineage beneath the root attempt", async () => {
    const harness = await schedulerHarness();
    harness.models.enqueue("summary", researchDecision(2), finalResult());
    harness.models.enqueue("analysis", finding(0));
    harness.models.enqueue("explorer", finding(1));
    await terminal(await harness.scheduler.run(scheduleInput(harness)));
    const creations = (await ledger(harness)).filter(event => event.type === "attempt_created");
    expect(creations.map(event => event.role)).toEqual(["summary", "analysis", "explorer", "summary"]);
    const rootId = creations[0]?.attemptId;
    expect(creations.slice(1).map(event => event.parentAttemptId)).toEqual([rootId, rootId, rootId]);
    expect(new Set(creations.map(event => event.logicalOperationId)).size).toBe(1);
  });

  it("persists provider usage and physical identities as exclusive attempt data", async () => {
    const harness = await schedulerHarness();
    harness.models.enqueue("summary", {
      ...completeDecision(),
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      providerRequestId: "provider-request",
      providerResponseId: "provider-response",
      providerCost: { amount: 0.01, currency: "USD" }
    });
    await terminal(await harness.scheduler.run(scheduleInput(harness)));
    const usage = (await ledger(harness)).filter(event => event.type === "attempt_usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      scope: "exclusive",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      providerRequestId: "provider-request",
      providerResponseId: "provider-response",
      cost: { kind: "provider-reported", amount: 0.01, currency: "USD" }
    });
  });

  it("persists identity-only usage without fabricating token or cost values", async () => {
    const harness = await schedulerHarness();
    harness.models.enqueue("summary", responseWithIdentity({ requestId: "identity-only" }));
    await terminal(await harness.scheduler.run(scheduleInput(harness)));
    const usage = (await ledger(harness)).filter(event => event.type === "attempt_usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ providerRequestId: "identity-only", scope: "exclusive" });
    expect(usage[0]).not.toHaveProperty("usage");
    expect(usage[0]).not.toHaveProperty("cost");
  });

  it("records direct attempts without an extra wrapper or duplicate outer telemetry", async () => {
    const harness = await schedulerHarness();
    harness.models.enqueue("summary", {
      ...responseWithIdentity({
        requestId: "ignored-outer",
        directAttempts: [
          {
            attemptId: "direct-a", provider: "provider-a", model: "model-a", scope: "exclusive",
            usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
            providerRequestId: "request-a"
          },
          {
            attemptId: "direct-b", provider: "provider-b", model: "model-b", scope: "exclusive",
            usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
            providerResponseId: "response-b"
          }
        ]
      }),
      usage: { inputTokens: 99, outputTokens: 99, totalTokens: 198 }
    });
    await terminal(await harness.scheduler.run(scheduleInput(harness)));
    const events = await ledger(harness);
    const creations = events.filter(event => event.type === "attempt_created");
    const usage = events.filter(event => event.type === "attempt_usage");
    expect(creations).toHaveLength(2);
    expect(usage).toHaveLength(2);
    expect(usage.map(event => event.usage?.totalTokens)).toEqual([4, 7]);
    expect(usage.map(event => event.providerRequestId)).not.toContain("ignored-outer");
  });

  it("fails open on same-provider physical identity collision without renaming", async () => {
    const harness = await schedulerHarness();
    harness.models.enqueue(
      "summary",
      {
        ...modelResponse("", [{ callId: "continue", name: "read_file", input: {} }]),
        providerRequestId: "collision"
      },
      { ...completeDecision(), providerRequestId: "collision" }
    );
    const settled = await terminal(await harness.scheduler.run(scheduleInput(harness)));
    expect(settled).toMatchObject({
      ok: true,
      value: { kind: "failed-open", reasonCode: "provider_identity_collision" }
    });
    const identities = (await ledger(harness))
      .filter(event => event.type === "attempt_usage")
      .map(event => event.providerRequestId);
    expect(identities).toEqual(["collision"]);
  });

  it("writes ledger records only and creates no child sessions", async () => {
    const harness = await schedulerHarness();
    harness.models.enqueue("summary", researchDecision(1), finalResult());
    harness.models.enqueue("analysis", finding(0));
    await terminal(await harness.scheduler.run(scheduleInput(harness)));
    const sessions = await harness.sessions.list();
    expect(sessions).toEqual({ ok: true, value: ["preflight-session"] });
    expect((await ledger(harness)).every(event => [
      "summary_reserved", "summary_committed", "summary_failed_open", "summary_cancelled",
      "attempt_created", "attempt_lifecycle", "attempt_usage"
    ].includes(event.type))).toBe(true);
  });
});
