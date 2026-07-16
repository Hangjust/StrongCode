import type { ModelResponse } from "../src/models/provider";
import type { RuntimeEventType } from "../src/runtime/events";
import { AgentRunner } from "../src/agents/runner";
import { messageEvent, type ConversationSessionEvent, type SessionEvent } from "../src/sessions/session";
import type { SessionCommitGuard } from "../src/sessions/session-store";
import {
  continuationAgent,
  createContinuationHarness,
  scriptedProvider
} from "./runner-continuation-fixtures";

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>(resolve => {
    resolvePromise = resolve;
  });
  if (resolvePromise === undefined) throw new Error("Deferred resolver was not initialized");
  return { promise, resolve: resolvePromise };
}

function hasAssistant(events: readonly SessionEvent[], content: string): boolean {
  return events.some(event => event.type === "message" && event.role === "assistant" && event.content === content);
}

describe("AgentRunner finalization commit race", () => {
  it("cancels when abort wins inside the queued guard immediately before write", async () => {
    // Given
    const harness = await createContinuationHarness([]);
    const controller = new AbortController();
    const events: RuntimeEventType[] = [];
    const commit = harness.sessions.commitGuarded.bind(harness.sessions);
    vi.spyOn(harness.sessions, "commitGuarded").mockImplementation(
      (sessionId: string, event: ConversationSessionEvent | undefined, guard: SessionCommitGuard) => commit(
        sessionId,
        event,
        () => {
          controller.abort();
          return guard();
        }
      )
    );
    const runner = new AgentRunner(
      { ...harness.context, signal: controller.signal },
      harness.sessions,
      harness.registry,
      { emit: event => events.push(event.type) }
    );

    // When
    const result = await runner.run(
      continuationAgent(harness.config, scriptedProvider([{ message: "Guarded final", toolCalls: [] }], [])),
      "Start",
      "guard-before-write"
    );

    // Then
    expect(result).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    const stored = await harness.sessions.read("guard-before-write");
    if (!stored.ok) throw stored.error;
    expect(hasAssistant(stored.value.events, "Guarded final")).toBe(false);
    expect(events).toEqual(["run_started", "run_cancelled"]);
  });

  it("cancels finalization while it waits behind another session operation", async () => {
    // Given
    const harness = await createContinuationHarness([]);
    const controller = new AbortController();
    const providerStarted = deferred<void>();
    const releaseModel = deferred<ModelResponse>();
    const blockerStarted = deferred<void>();
    const releaseBlocker = deferred<void>();
    const finalQueued = deferred<void>();
    const model = {
      name: "queued-final",
      async complete() {
        providerStarted.resolve(undefined);
        return releaseModel.promise;
      }
    };
    const runner = new AgentRunner(
      { ...harness.context, signal: controller.signal },
      harness.sessions,
      harness.registry
    );
    const pending = runner.run(continuationAgent(harness.config, model), "Start", "queued-final");
    await providerStarted.promise;
    const blocker = harness.sessions.commitGuarded(
      "queued-final",
      messageEvent("assistant", "queue blocker"),
      async () => {
        blockerStarted.resolve(undefined);
        await releaseBlocker.promise;
        return true;
      }
    );
    await blockerStarted.promise;
    const commit = harness.sessions.commitGuarded.bind(harness.sessions);
    vi.spyOn(harness.sessions, "commitGuarded").mockImplementation(
      (sessionId: string, event: ConversationSessionEvent | undefined, guard: SessionCommitGuard) => {
        if (event?.type === "message" && event.content === "Queued final") finalQueued.resolve(undefined);
        return commit(sessionId, event, guard);
      }
    );
    releaseModel.resolve({ message: "Queued final", toolCalls: [] });
    await finalQueued.promise;

    // When
    controller.abort();
    releaseBlocker.resolve(undefined);
    const [result, blockerResult] = await Promise.all([pending, blocker]);

    // Then
    expect(blockerResult).toMatchObject({ ok: true, value: { kind: "committed" } });
    expect(result).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    const stored = await harness.sessions.read("queued-final");
    if (!stored.ok) throw stored.error;
    expect(hasAssistant(stored.value.events, "Queued final")).toBe(false);
  });

  it("keeps success when abort happens after the durable commit", async () => {
    // Given
    const harness = await createContinuationHarness([]);
    const controller = new AbortController();
    const events: RuntimeEventType[] = [];
    const commit = harness.sessions.commitGuarded.bind(harness.sessions);
    vi.spyOn(harness.sessions, "commitGuarded").mockImplementation(
      async (sessionId: string, event: ConversationSessionEvent | undefined, guard: SessionCommitGuard) => {
        const result = await commit(sessionId, event, guard);
        controller.abort();
        return result;
      }
    );
    const runner = new AgentRunner(
      { ...harness.context, signal: controller.signal },
      harness.sessions,
      harness.registry,
      { emit: event => events.push(event.type) }
    );

    // When
    const result = await runner.run(
      continuationAgent(harness.config, scriptedProvider([{ message: "Durable final", toolCalls: [] }], [])),
      "Start",
      "abort-after-commit"
    );

    // Then
    expect(result).toMatchObject({ ok: true, value: { response: "Durable final" } });
    const stored = await harness.sessions.read("abort-after-commit");
    if (!stored.ok) throw stored.error;
    expect(hasAssistant(stored.value.events, "Durable final")).toBe(true);
    expect(events).toEqual(["run_started", "run_finished"]);
  });

  it("uses a guarded queue barrier for an empty final response", async () => {
    // Given
    const harness = await createContinuationHarness([]);
    const controller = new AbortController();
    const events: RuntimeEventType[] = [];
    const commit = harness.sessions.commitGuarded.bind(harness.sessions);
    vi.spyOn(harness.sessions, "commitGuarded").mockImplementation(
      (sessionId: string, event: ConversationSessionEvent | undefined, guard: SessionCommitGuard) => {
        expect(event).toBeUndefined();
        return commit(sessionId, event, () => {
          controller.abort();
          return guard();
        });
      }
    );
    const runner = new AgentRunner(
      { ...harness.context, signal: controller.signal },
      harness.sessions,
      harness.registry,
      { emit: event => events.push(event.type) }
    );

    // When
    const result = await runner.run(
      continuationAgent(harness.config, scriptedProvider([{ message: "", toolCalls: [] }], [])),
      "Start",
      "empty-final"
    );

    // Then
    expect(result).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    expect(events).toEqual(["run_started", "run_cancelled"]);
  });
});
