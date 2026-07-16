import path from "node:path";
import type { Agent } from "../src/agents/agent";
import { AgentRunner } from "../src/agents/runner";
import { StrongCodeError } from "../src/core/errors";
import type { Result } from "../src/core/result";
import type { ConversationItem } from "../src/core/types";
import type { ModelProvider, ModelResponse } from "../src/models/provider";
import type { CheckpointCommitFaultInjector } from "../src/sessions/compaction-checkpoint-store";
import { COMPACTION_SUMMARY_PREFIX } from "../src/sessions/compaction";
import { SessionStore } from "../src/sessions/session-store";
import {
  compactionCheckpointEvent,
  conversationItemEvent,
  eventsToConversationItems,
  messageEvent,
  type ConversationSessionEvent
} from "../src/sessions/session";
import { createDefaultToolRegistry } from "../src/tools/registry";
import { tempWorkspace } from "./helpers";

type Deferred<T> = { readonly promise: Promise<T>; readonly resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolver: ((value: T) => void) | undefined;
  const promise = new Promise<T>(resolve => {
    resolver = resolve;
  });
  if (resolver === undefined) throw new Error("Deferred resolver was not initialized");
  return { promise, resolve: resolver };
}

function valueOf<T>(result: Result<T>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

async function harness(fault?: CheckpointCommitFaultInjector) {
  const workspace = await tempWorkspace();
  const sessions = new SessionStore(workspace.context.dataDir, {
    ...(fault === undefined ? {} : { checkpointCommitFault: fault })
  });
  const runner = new AgentRunner(workspace.context, sessions, createDefaultToolRegistry());
  return { config: workspace.config.agents.default, runner, sessions };
}

function agent(config: Agent["config"], model: ModelProvider, name = "newton"): Agent {
  return { name, config, model, systemPrompt: "Exact active system prompt." };
}

async function appendAll(store: SessionStore, sessionId: string, events: readonly ConversationSessionEvent[]): Promise<void> {
  for (const event of events) valueOf(await store.append(sessionId, event));
}

describe("compactor safety boundaries", () => {
  it("reads a revision snapshot and commits through the checkpoint seam", async () => {
    // Given
    const test = await harness();
    await appendAll(test.sessions, "snapshot-seam", [messageEvent("user", "keep this")]);
    const readForCompaction = vi.spyOn(test.sessions, "readForCompaction");
    const commit = vi.spyOn(test.sessions, "commitCompactionCheckpoint");
    const append = vi.spyOn(test.sessions, "append");
    const complete = vi.fn(async (): Promise<ModelResponse> => ({ message: "safe summary", toolCalls: [] }));

    // When
    const result = await test.runner.compact(agent(test.config, { name: "model", complete }), "snapshot-seam");

    // Then
    expect(result.ok).toBe(true);
    expect(readForCompaction).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
    expect(append).not.toHaveBeenCalled();
  });

  it("returns a projection SESSION_ERROR without calling the provider", async () => {
    // Given
    const test = await harness();
    const priorSummary = `${COMPACTION_SUMMARY_PREFIX}\nPrior state.`;
    await appendAll(test.sessions, "invalid-projection", [
      compactionCheckpointEvent("newton", priorSummary, [
        { type: "text", role: "user", content: priorSummary }
      ]),
      conversationItemEvent({
        type: "tool_call",
        role: "assistant",
        callId: "dangling",
        name: "read_file",
        input: { path: "README.md" }
      })
    ]);
    const complete = vi.fn(async (): Promise<ModelResponse> => ({ message: "must not run", toolCalls: [] }));

    // When
    const result = await test.runner.compact(agent(test.config, { name: "unused", complete }), "invalid-projection");

    // Then
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SESSION_ERROR");
    expect(complete).not.toHaveBeenCalled();
  });

  it("resolves structuredClone failures as a sanitized MODEL_ERROR", async () => {
    // Given
    const test = await harness();
    await appendAll(test.sessions, "clone-failure", [messageEvent("user", "unchanged")]);
    const complete = vi.fn(async (): Promise<ModelResponse> => ({ message: "must not run", toolCalls: [] }));
    const originalStructuredClone = globalThis.structuredClone;
    const clone = vi.spyOn(globalThis, "structuredClone").mockImplementation(value => {
      if (
        Array.isArray(value) &&
        value.length > 0 &&
        typeof value[0] === "object" &&
        value[0] !== null &&
        Reflect.get(value[0], "type") === "text"
      ) {
        throw new Error("secret clone detail");
      }
      return originalStructuredClone(value);
    });

    // When
    const result = await test.runner.compact(agent(test.config, { name: "unused", complete }), "clone-failure");
    clone.mockRestore();

    // Then
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MODEL_ERROR");
      expect(result.error.message).not.toContain("secret clone detail");
    }
    expect(complete).not.toHaveBeenCalled();
  });

  it("keeps checkpoint construction isolated from malicious provider mutations", async () => {
    // Given
    const test = await harness();
    const sessionId = "provider-mutation";
    const nestedInput = { path: "README.md", ranges: [{ start: 1, end: 2 }] };
    await appendAll(test.sessions, sessionId, [
      messageEvent("user", "original request"),
      conversationItemEvent({ type: "tool_call", role: "assistant", callId: "call-1", name: "read_file", input: nestedInput }),
      conversationItemEvent({ type: "tool_result", role: "tool", callId: "call-1", content: "original result", isError: false })
    ]);
    const model: ModelProvider = {
      name: "malicious",
      async complete(request) {
        request.items?.forEach(item => {
          if (item.type === "text") Object.defineProperty(item, "content", { value: "mutated request" });
          if (item.type === "tool_call" && typeof item.input === "object" && item.input !== null) {
            Object.assign(item.input, { path: "mutated.md", ranges: [{ start: 99, end: 100 }] });
          }
        });
        request.messages.forEach(message => {
          message.content = "mutated message";
        });
        if (request.items !== undefined) Reflect.set(request.items, "length", 0);
        request.messages.length = 0;
        return { message: "pristine summary", toolCalls: [] };
      }
    };

    // When
    const result = await test.runner.compact(agent(test.config, model), sessionId);

    // Then
    expect(result.ok).toBe(true);
    const events = valueOf(await test.sessions.read(sessionId)).events;
    expect(eventsToConversationItems(events)).toEqual([
      { type: "text", role: "user", content: "original request" },
      { type: "text", role: "user", content: expect.stringContaining("pristine summary") }
    ]);
    expect(nestedInput).toEqual({ path: "README.md", ranges: [{ start: 1, end: 2 }] });
  });

  it.each([
    {
      label: "tool-call normalization",
      name: "newton",
      model: {
        name: "malformed-tool-calls",
        async complete(): Promise<ModelResponse> {
          return {
            message: "summary",
            get toolCalls(): ModelResponse["toolCalls"] {
              throw new Error("secret tool-call detail");
            }
          };
        }
      } satisfies ModelProvider
    },
    {
      label: "response normalization",
      name: "newton",
      model: {
        name: "malformed-response",
        async complete(): Promise<ModelResponse> {
          return {
            message: "summary",
            toolCalls: [],
            get items(): readonly ConversationItem[] {
              throw new Error("secret normalization detail");
            }
          };
        }
      } satisfies ModelProvider
    },
    {
      label: "checkpoint factory",
      name: "   ",
      model: {
        name: "valid-response",
        async complete(): Promise<ModelResponse> {
          return { message: "summary", toolCalls: [] };
        }
      } satisfies ModelProvider
    }
  ])("resolves $label failures as sanitized MODEL_ERROR", async ({ name, model }) => {
    // Given
    const test = await harness();
    await appendAll(test.sessions, "preparation-failure", [messageEvent("user", "unchanged")]);

    // When
    const result = await test.runner.compact(agent(test.config, model, name), "preparation-failure");

    // Then
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MODEL_ERROR");
      expect(result.error.message).not.toContain("secret");
    }
  });

  it("rejects one stale external append without retrying or losing events", async () => {
    // Given
    const test = await harness();
    const writer = new SessionStore(path.dirname(path.dirname(valueOf(test.sessions.pathFor("stale")))));
    await appendAll(test.sessions, "stale", [messageEvent("user", "original")]);
    const response = deferred<ModelResponse>();
    const started = deferred<void>();
    const complete = vi.fn(async () => {
      started.resolve(undefined);
      return response.promise;
    });
    const compacting = test.runner.compact(agent(test.config, { name: "blocking", complete }), "stale");
    await started.promise;
    valueOf(await writer.append("stale", messageEvent("assistant", "external append")));

    // When
    response.resolve({ message: "stale summary", toolCalls: [] });
    const result = await compacting;

    // Then
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SESSION_ERROR");
    expect(complete).toHaveBeenCalledOnce();
    expect(valueOf(await test.sessions.read("stale")).events.map(event => event.type)).toEqual(["message", "message"]);
  });

  it("leaves the active projection unchanged when atomic commit fails", async () => {
    // Given
    const fault: CheckpointCommitFaultInjector = stage => {
      if (stage === "before_temp_create") throw new StrongCodeError("SESSION_ERROR", "commit failed");
    };
    const test = await harness(fault);
    await appendAll(test.sessions, "commit-failure", [messageEvent("user", "unchanged")]);
    const before = eventsToConversationItems(valueOf(await test.sessions.read("commit-failure")).events);

    // When
    const result = await test.runner.compact(
      agent(test.config, { name: "model", async complete() { return { message: "summary", toolCalls: [] }; } }),
      "commit-failure"
    );

    // Then
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SESSION_ERROR");
    expect(eventsToConversationItems(valueOf(await test.sessions.read("commit-failure")).events)).toEqual(before);
  });
});
