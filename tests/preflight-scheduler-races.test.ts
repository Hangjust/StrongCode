import { describe, expect, it } from "vitest";
import type { ModelResponse } from "../src/models/provider";
import {
  completeDecision,
  deferred,
  finalResult,
  modelResponse,
  researchDecision,
  scheduleInput,
  schedulerHarness,
  terminal
} from "./fixtures/preflight-scheduler-harness";

describe("PreflightScheduler races", () => {
  it("cancels a pre-aborted request without a provider call", async () => {
    const harness = await schedulerHarness();
    const controller = new AbortController();
    const reason = { sentinel: "exact cancellation identity" };
    controller.abort(reason);
    const settled = await terminal(await harness.scheduler.run(scheduleInput(harness, {
      signal: controller.signal
    })));
    expect(settled).toMatchObject({
      ok: true,
      value: { kind: "cancelled", reasonCode: "user_cancelled", reasonAvailable: true }
    });
    if (!settled.ok) throw settled.error;
    expect(settled.value.reason).toBe(reason);
    expect(harness.models.requests.summary).toHaveLength(0);
  });

  it("cleans a pre-aborted registry entry before scheduler close", async () => {
    // Given
    const harness = await schedulerHarness();
    const controller = new AbortController();
    controller.abort("cancel before admission");

    // When
    await terminal(await harness.scheduler.run(scheduleInput(harness, { signal: controller.signal })));
    // Then
    expect(harness.registry.size).toBe(0);
    await harness.scheduler.close();
  });

  it("fails open on the overall deadline and aborts the root request", async () => {
    const harness = await schedulerHarness();
    expect(harness.schedulerAvailable, "Todo 7 private scheduler is missing").toBe(true);
    const pending = deferred<ModelResponse>();
    harness.models.enqueue("summary", () => pending.promise);
    const observed = harness.models.waitForRequests("summary", 1);
    const scheduled = await harness.scheduler.run(scheduleInput(harness));
    await observed;
    const signal = harness.models.requests.summary[0]?.signal;
    harness.clock.advanceBy(90_000);
    const settled = await terminal(scheduled);
    expect(settled).toMatchObject({
      ok: true,
      value: { kind: "failed-open", reasonCode: "overall_timeout" }
    });
    expect(signal?.aborted).toBe(true);
  });

  it("turns a child-local timeout into an ordered finalizer gap", async () => {
    const harness = await schedulerHarness();
    expect(harness.schedulerAvailable, "Todo 7 private scheduler is missing").toBe(true);
    const pending = deferred<ModelResponse>();
    harness.models.enqueue("summary", researchDecision(1), finalResult());
    harness.models.enqueue("analysis", () => pending.promise);
    const childObserved = harness.models.waitForRequests("analysis", 1);
    const scheduled = await harness.scheduler.run(scheduleInput(harness));
    await childObserved;
    harness.clock.advanceBy(30_000);
    const settled = await terminal(scheduled);
    expect(settled).toMatchObject({ ok: true, value: { kind: "committed" } });
    const evidence = harness.models.requests.summary[1]?.items?.at(-1);
    expect(evidence).toMatchObject({ type: "text", role: "user" });
    if (evidence?.type !== "text") throw new Error("Missing finalizer evidence");
    expect(JSON.parse(evidence.content).untrustedResearch[0].outcome).toEqual({
      kind: "gap", code: "child_timeout"
    });
  });

  it("lets cancellation win before a pending root completion", async () => {
    const harness = await schedulerHarness();
    expect(harness.schedulerAvailable, "Todo 7 private scheduler is missing").toBe(true);
    const pending = deferred<ModelResponse>();
    const controller = new AbortController();
    harness.models.enqueue("summary", () => pending.promise);
    const observed = harness.models.waitForRequests("summary", 1);
    const scheduled = await harness.scheduler.run(scheduleInput(harness, { signal: controller.signal }));
    await observed;
    controller.abort("cancel-first");
    pending.resolve(completeDecision());
    const settled = await terminal(scheduled);
    expect(settled).toMatchObject({ ok: true, value: { kind: "cancelled" } });
  });

  it("keeps a committed result when cancellation arrives afterward", async () => {
    const harness = await schedulerHarness();
    const controller = new AbortController();
    harness.models.enqueue("summary", completeDecision());
    const settled = await terminal(await harness.scheduler.run(scheduleInput(harness, {
      signal: controller.signal
    })));
    controller.abort("too-late");
    expect(settled).toMatchObject({ ok: true, value: { kind: "committed" } });
  });

  it("lets timeout win before late completion without invoking late tools", async () => {
    const harness = await schedulerHarness();
    expect(harness.schedulerAvailable, "Todo 7 private scheduler is missing").toBe(true);
    const pending = deferred<ModelResponse>();
    harness.models.enqueue("summary", () => pending.promise);
    const observed = harness.models.waitForRequests("summary", 1);
    const scheduled = await harness.scheduler.run(scheduleInput(harness));
    await observed;
    harness.clock.advanceBy(90_000);
    const settled = await terminal(scheduled);
    pending.resolve(modelResponse("", [{ callId: "late", name: "read_file", input: {} }]));
    await Promise.resolve();
    expect(settled).toMatchObject({ ok: true, value: { kind: "failed-open" } });
    expect(harness.invocations).toEqual([]);
  });

  it("lets a completed root beat a later deadline", async () => {
    const harness = await schedulerHarness();
    harness.models.enqueue("summary", completeDecision());
    const settled = await terminal(await harness.scheduler.run(scheduleInput(harness)));
    harness.clock.advanceBy(90_000);
    expect(settled).toMatchObject({ ok: true, value: { kind: "committed" } });
    expect(harness.clock.pendingTimers()).toBe(0);
  });

  it("cancels a pending finalizer and discards staged research", async () => {
    const harness = await schedulerHarness();
    expect(harness.schedulerAvailable, "Todo 7 private scheduler is missing").toBe(true);
    const pending = deferred<ModelResponse>();
    const controller = new AbortController();
    harness.models.enqueue("summary", researchDecision(0), () => pending.promise);
    const finalizerObserved = harness.models.waitForRequests("summary", 2);
    const scheduled = await harness.scheduler.run(scheduleInput(harness, { signal: controller.signal }));
    await finalizerObserved;
    controller.abort("cancel-finalizer");
    pending.resolve(finalResult());
    const settled = await terminal(scheduled);
    expect(settled).toMatchObject({ ok: true, value: { kind: "cancelled" } });
  });

  it("keeps a committed finalizer result when cancellation arrives afterward", async () => {
    const harness = await schedulerHarness();
    const controller = new AbortController();
    harness.models.enqueue("summary", researchDecision(0), finalResult());
    const settled = await terminal(await harness.scheduler.run(scheduleInput(harness, {
      signal: controller.signal
    })));
    controller.abort("after-finalizer");
    expect(settled).toMatchObject({ ok: true, value: { kind: "committed" } });
  });

  it("joins same-source callers onto one physical provider run", async () => {
    const harness = await schedulerHarness();
    expect(harness.schedulerAvailable, "Todo 7 private scheduler is missing").toBe(true);
    const pending = deferred<ModelResponse>();
    harness.models.enqueue("summary", () => pending.promise);
    const first = await harness.scheduler.run(scheduleInput(harness));
    const second = await harness.scheduler.run(scheduleInput(harness));
    expect(first).toMatchObject({ ok: true, value: { kind: "in-progress" } });
    expect(second).toMatchObject({ ok: true, value: { kind: "in-progress" } });
    expect(harness.models.requests.summary).toHaveLength(1);
    pending.resolve(completeDecision());
    expect(await terminal(first)).toMatchObject({ ok: true, value: { kind: "committed" } });
    expect(await terminal(second)).toMatchObject({ ok: true, value: { kind: "committed" } });
  });

  it("rejects conflicting live input without another provider call", async () => {
    const harness = await schedulerHarness();
    expect(harness.schedulerAvailable, "Todo 7 private scheduler is missing").toBe(true);
    const pending = deferred<ModelResponse>();
    harness.models.enqueue("summary", () => pending.promise);
    const first = await harness.scheduler.run(scheduleInput(harness));
    const conflict = await harness.scheduler.run(scheduleInput(harness, {
      sourceMessageId: "other-source", originalPrompt: "Different prompt"
    }));
    expect(conflict).toMatchObject({ ok: true, value: { kind: "existing", reason: "owned-by-another-source" } });
    expect(harness.models.requests.summary).toHaveLength(1);
    pending.resolve(completeDecision());
    await terminal(first);
  });

  it("replays a terminal reservation without another provider call", async () => {
    const harness = await schedulerHarness();
    harness.models.enqueue("summary", completeDecision());
    await terminal(await harness.scheduler.run(scheduleInput(harness)));
    const replay = await harness.scheduler.run(scheduleInput(harness));
    expect(replay).toMatchObject({ ok: true, value: { kind: "existing", reason: "terminal-replay" } });
    expect(harness.models.requests.summary).toHaveLength(1);
  });

  it("fails open an orphaned durable reservation without a provider call", async () => {
    const harness = await schedulerHarness();
    const reserved = await harness.sessions.reserveFirstSummary("preflight-session", {
      sourceMessageId: "source-message", originalPrompt: "Exact original prompt"
    });
    expect(reserved).toMatchObject({ ok: true, value: { kind: "reserved" } });
    const replay = await terminal(await harness.scheduler.run(scheduleInput(harness)));
    expect(replay).toMatchObject({
      ok: true,
      value: { kind: "failed-open", reasonCode: "orphaned_reservation" }
    });
    expect(harness.models.requests.summary).toHaveLength(0);
  });

  it("cleans timers and registry entries after terminal settlement", async () => {
    const harness = await schedulerHarness();
    harness.models.enqueue("summary", completeDecision());
    await terminal(await harness.scheduler.run(scheduleInput(harness)));
    expect(harness.clock.pendingTimers()).toBe(0);
    expect(harness.registry.size).toBe(0);
  });

  it("records late provider usage at most once without reviving terminal state", async () => {
    const harness = await schedulerHarness();
    expect(harness.schedulerAvailable, "Todo 7 private scheduler is missing").toBe(true);
    const pending = deferred<ModelResponse>();
    harness.models.enqueue("summary", () => pending.promise);
    const observed = harness.models.waitForRequests("summary", 1);
    const scheduled = await harness.scheduler.run(scheduleInput(harness));
    await observed;
    harness.clock.advanceBy(90_000);
    const settled = await terminal(scheduled);
    pending.resolve({
      ...completeDecision("late"),
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      providerRequestId: "late-request"
    });
    await Promise.resolve();
    const session = await harness.sessions.read("preflight-session");
    if (!session.ok) throw session.error;
    expect(session.value.events.filter(event => event.type === "attempt_usage").length).toBeLessThanOrEqual(1);
    expect(settled).toMatchObject({ ok: true, value: { kind: "failed-open", reasonCode: "overall_timeout" } });
  });
});
