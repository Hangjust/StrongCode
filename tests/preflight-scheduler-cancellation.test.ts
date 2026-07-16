import { describe, expect, it } from "vitest";
import type { LedgerCommitEvent } from "../src/sessions/session-ledger-events";
import { SessionStore, type SessionLedgerCommitOutcome } from "../src/sessions/session-store";
import type { Result } from "../src/core/result";
import type { ModelResponse } from "../src/models/provider";
import {
  completeDecision,
  deferred,
  scheduleInput,
  schedulerHarness,
  terminal
} from "./fixtures/preflight-scheduler-harness";
import type { SessionWriteGuard } from "../src/sessions/session-store-io";

class TerminalOrderStore extends SessionStore {
  readonly abortedAtTerminal: boolean[] = [];
  providerSignal = (): AbortSignal | undefined => undefined;

  override async commitLedgerEvent(
    sessionId: string,
    event: LedgerCommitEvent,
    isCurrent: () => boolean = () => true
  ): Promise<Result<SessionLedgerCommitOutcome>> {
    if (event.type === "summary_cancelled" || event.type === "summary_failed_open") {
      this.abortedAtTerminal.push(this.providerSignal()?.aborted ?? false);
    }
    return super.commitLedgerEvent(sessionId, event, isCurrent);
  }
}

class PausedSuccessStore extends SessionStore {
  readonly guardReached = deferred<void>();
  readonly releaseGuard = deferred<void>();
  providerSignal = (): AbortSignal | undefined => undefined;
  abortedAtCancelledWrite: boolean | undefined;

  override async commitLedgerEvent(
    sessionId: string,
    event: LedgerCommitEvent,
    isCurrent: SessionWriteGuard = () => true
  ): Promise<Result<SessionLedgerCommitOutcome>> {
    if (event.type === "summary_committed") {
      return super.commitLedgerEvent(sessionId, event, async () => {
        this.guardReached.resolve();
        await this.releaseGuard.promise;
        return isCurrent();
      });
    }
    if (event.type === "summary_cancelled") {
      this.abortedAtCancelledWrite = this.providerSignal()?.aborted;
    }
    return super.commitLedgerEvent(sessionId, event, isCurrent);
  }
}

describe("PreflightScheduler cancellation accounting", () => {
  it("records one durable cancelled lifecycle for a pending outbound provider request", async () => {
    const harness = await schedulerHarness();
    const pending = deferred<ModelResponse>();
    const controller = new AbortController();
    harness.models.enqueue("summary", () => pending.promise);
    const observed = harness.models.waitForRequests("summary", 1);
    const scheduled = await harness.scheduler.run(scheduleInput(harness, { signal: controller.signal }));
    await observed;

    controller.abort("cancel-pending");
    expect(await terminal(scheduled)).toMatchObject({ ok: true, value: { kind: "cancelled" } });

    const session = await harness.sessions.read("preflight-session");
    if (!session.ok) throw session.error;
    const created = session.value.events.filter(event => event.type === "attempt_created");
    const lifecycle = session.value.events.filter(event => event.type === "attempt_lifecycle");
    expect(created).toHaveLength(1);
    expect(lifecycle.map(event => event.transition.kind)).toEqual(["started", "cancelled"]);
  });

  it.each([
    ["string", "NON_ERROR_PROVIDER_REJECTION"],
    ["object", { sentinel: "NON_ERROR_PROVIDER_REJECTION" }]
  ] as const)("normalizes a %s provider rejection into non-rejecting failed-open done", async (_label, rejection) => {
    const harness = await schedulerHarness();
    harness.models.enqueue("summary", async () => Promise.reject(rejection));

    const scheduled = await harness.scheduler.run(scheduleInput(harness));
    expect(await terminal(scheduled)).toMatchObject({
      ok: true,
      value: { kind: "failed-open", reasonCode: "root_provider_failed" }
    });
  });

  it("persists user cancellation before abort reaches the pending provider", async () => {
    let sessions: TerminalOrderStore | undefined;
    const harness = await schedulerHarness({
      createSessions: dataDir => {
        sessions = new TerminalOrderStore(dataDir);
        return sessions;
      }
    });
    if (sessions === undefined) throw new Error("Missing terminal-order store");
    const pending = deferred<ModelResponse>();
    const controller = new AbortController();
    harness.models.enqueue("summary", () => pending.promise);
    const observed = harness.models.waitForRequests("summary", 1);
    const scheduled = await harness.scheduler.run(scheduleInput(harness, { signal: controller.signal }));
    await observed;
    sessions.providerSignal = () => harness.models.requests.summary[0]?.signal;

    controller.abort("terminal-first");
    expect(await terminal(scheduled)).toMatchObject({ ok: true, value: { kind: "cancelled" } });
    expect(sessions.abortedAtTerminal[0]).toBe(false);
    const stored = await sessions.read("preflight-session");
    if (!stored.ok) throw stored.error;
    expect(stored.value.events.filter(event => event.type === "summary_cancelled")).toHaveLength(1);
  });

  it("persists overall timeout before abort reaches the pending provider", async () => {
    let sessions: TerminalOrderStore | undefined;
    const harness = await schedulerHarness({
      createSessions: dataDir => {
        sessions = new TerminalOrderStore(dataDir);
        return sessions;
      }
    });
    if (sessions === undefined) throw new Error("Missing terminal-order store");
    const pending = deferred<ModelResponse>();
    harness.models.enqueue("summary", () => pending.promise);
    const observed = harness.models.waitForRequests("summary", 1);
    const scheduled = await harness.scheduler.run(scheduleInput(harness));
    await observed;
    sessions.providerSignal = () => harness.models.requests.summary[0]?.signal;

    harness.clock.advanceBy(90_000);
    expect(await terminal(scheduled)).toMatchObject({
      ok: true,
      value: { kind: "failed-open", reasonCode: "overall_timeout" }
    });
    expect(sessions.abortedAtTerminal[0]).toBe(false);
    const stored = await sessions.read("preflight-session");
    if (!stored.ok) throw stored.error;
    expect(stored.value.events.filter(event => event.type === "summary_failed_open")).toHaveLength(1);
  });

  it("cancellation revokes a success paused at the final write guard", async () => {
    let sessions: PausedSuccessStore | undefined;
    const harness = await schedulerHarness({
      createSessions: dataDir => {
        sessions = new PausedSuccessStore(dataDir);
        return sessions;
      }
    });
    if (sessions === undefined) throw new Error("Missing paused-success store");
    const controller = new AbortController();
    harness.models.enqueue("summary", completeDecision());
    const scheduled = await harness.scheduler.run(scheduleInput(harness, { signal: controller.signal }));
    sessions.providerSignal = () => harness.models.requests.summary[0]?.signal;
    await sessions.guardReached.promise;

    let settled;
    try {
      controller.abort("cancel-during-success-write");
      sessions.releaseGuard.resolve();
      settled = await terminal(scheduled);
    } finally {
      sessions.releaseGuard.resolve();
    }

    expect(settled).toMatchObject({ ok: true, value: { kind: "cancelled" } });
    expect(sessions.abortedAtCancelledWrite).toBe(false);
    const stored = await sessions.read("preflight-session");
    if (!stored.ok) throw stored.error;
    expect(stored.value.events.filter(event => event.type === "summary_committed")).toEqual([]);
    expect(stored.value.events.filter(event => event.type === "summary_cancelled")).toHaveLength(1);
  });
});
