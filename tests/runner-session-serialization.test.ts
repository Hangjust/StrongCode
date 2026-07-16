import path from "node:path";
import type { Agent } from "../src/agents/agent";
import { AgentRunner } from "../src/agents/runner";
import type { Result } from "../src/core/result";
import type { ModelRequest, ModelResponse } from "../src/models/provider";
import { SessionStore } from "../src/sessions/session-store";
import { eventsToConversationItems, messageEvent } from "../src/sessions/session";
import { createDefaultToolRegistry } from "../src/tools/registry";
import { tempWorkspace } from "./helpers";

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

function agent(
  name: string,
  config: Agent["config"],
  complete: Agent["model"]["complete"]
): Agent {
  return {
    name,
    config: { ...config, tools: [] },
    model: { name: `${name}-serialization-model`, complete },
    systemPrompt: "Serialization test system prompt."
  };
}

function valueOf<T>(result: Result<T>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

async function flushAdmissions(): Promise<void> {
  await Promise.resolve();
}

describe("runner session serialization", () => {
  it("derives a canonical operation key from the validated session path", async () => {
    const workspace = await tempWorkspace();
    const sessions = new SessionStore(workspace.context.dataDir);

    const key = sessions.operationKey("Canonical.Session");

    expect(key.ok).toBe(true);
    if (!key.ok) throw key.error;
    const resolved = path.resolve(workspace.context.dataDir, "sessions", "Canonical.Session.jsonl");
    expect(key.value).toBe(process.platform === "win32" ? resolved.toLowerCase() : resolved);
    expect(sessions.operationKey("../escape").ok).toBe(false);
  });

  it("serializes separate runners sharing one session and exposes the completed prior turn", async () => {
    const workspace = await tempWorkspace();
    const firstSessions = new SessionStore(workspace.context.dataDir);
    const secondSessions = new SessionStore(workspace.context.dataDir);
    const firstRunner = new AgentRunner(workspace.context, firstSessions, createDefaultToolRegistry());
    const secondRunner = new AgentRunner(workspace.context, secondSessions, createDefaultToolRegistry());
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<ModelResponse>();
    const secondRequests: ModelRequest[] = [];
    const secondRead = vi.spyOn(secondSessions, "readOrEmpty");

    const first = firstRunner.run(agent("first", workspace.config.agents.default, async () => {
      firstStarted.resolve(undefined);
      return releaseFirst.promise;
    }), "first prompt", "shared-session");
    await firstStarted.promise;
    const second = secondRunner.run(agent("second", workspace.config.agents.default, async request => {
      secondRequests.push(request);
      return { message: "second answer", toolCalls: [] };
    }), "second prompt", "shared-session");
    await flushAdmissions();

    expect(secondRead).not.toHaveBeenCalled();
    releaseFirst.resolve({ message: "first answer", toolCalls: [] });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
    expect(secondRequests).toHaveLength(1);
    expect(secondRequests[0]?.messages).toEqual([
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second prompt" }
    ]);
  });

  it("keeps identical session ids in different data directories concurrent", async () => {
    const firstWorkspace = await tempWorkspace();
    const secondWorkspace = await tempWorkspace();
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const release = deferred<ModelResponse>();
    const firstRunner = new AgentRunner(
      firstWorkspace.context,
      new SessionStore(firstWorkspace.context.dataDir),
      createDefaultToolRegistry()
    );
    const secondRunner = new AgentRunner(
      secondWorkspace.context,
      new SessionStore(secondWorkspace.context.dataDir),
      createDefaultToolRegistry()
    );

    const first = firstRunner.run(agent("first", firstWorkspace.config.agents.default, async () => {
      firstStarted.resolve(undefined);
      return release.promise;
    }), "first", "same-id");
    const second = secondRunner.run(agent("second", secondWorkspace.config.agents.default, async () => {
      secondStarted.resolve(undefined);
      return release.promise;
    }), "second", "same-id");

    await Promise.all([firstStarted.promise, secondStarted.promise]);
    release.resolve({ message: "complete", toolCalls: [] });
    const results = await Promise.all([first, second]);
    expect(results.every(result => result.ok)).toBe(true);
  });

  it("keeps different sessions in one data directory concurrent", async () => {
    const workspace = await tempWorkspace();
    const runner = new AgentRunner(
      workspace.context,
      new SessionStore(workspace.context.dataDir),
      createDefaultToolRegistry()
    );
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const release = deferred<ModelResponse>();
    const first = runner.run(agent("first", workspace.config.agents.default, async () => {
      firstStarted.resolve(undefined);
      return release.promise;
    }), "first", "session-a");
    const second = runner.run(agent("second", workspace.config.agents.default, async () => {
      secondStarted.resolve(undefined);
      return release.promise;
    }), "second", "session-b");

    await Promise.all([firstStarted.promise, secondStarted.promise]);
    release.resolve({ message: "complete", toolCalls: [] });
    expect((await Promise.all([first, second])).every(result => result.ok)).toBe(true);
  });

  it("prevents a stale compaction checkpoint from projecting away a later turn", async () => {
    const workspace = await tempWorkspace();
    const compactSessions = new SessionStore(workspace.context.dataDir);
    const runSessions = new SessionStore(workspace.context.dataDir);
    valueOf(await compactSessions.append("stale-race", messageEvent("user", "original request", "newton")));
    const compactRunner = new AgentRunner(workspace.context, compactSessions, createDefaultToolRegistry());
    const runRunner = new AgentRunner(workspace.context, runSessions, createDefaultToolRegistry());
    const compactStarted = deferred<void>();
    const releaseCompact = deferred<ModelResponse>();
    const runRead = vi.spyOn(runSessions, "readOrEmpty");
    const compacting = compactRunner.compact(agent("newton", workspace.config.agents.default, async () => {
      compactStarted.resolve(undefined);
      return releaseCompact.promise;
    }), "stale-race");
    await compactStarted.promise;

    const laterRun = runRunner.run(agent("newton", workspace.config.agents.default, async () => ({
      message: "later answer",
      toolCalls: []
    })), "later prompt", "stale-race");
    await flushAdmissions();
    if (runRead.mock.calls.length > 0) await laterRun;
    releaseCompact.resolve({ message: "checkpoint summary", toolCalls: [] });
    const [compactResult, runResult] = await Promise.all([compacting, laterRun]);

    expect(compactResult.ok).toBe(true);
    expect(runResult.ok).toBe(true);
    const stored = valueOf(await compactSessions.read("stale-race"));
    expect(eventsToConversationItems(stored.events).slice(-2)).toEqual([
      { type: "text", role: "user", content: "later prompt" },
      { type: "text", role: "assistant", content: "later answer" }
    ]);
  });

  it("executes run then compact then run in invocation order", async () => {
    const workspace = await tempWorkspace();
    const sessions = new SessionStore(workspace.context.dataDir);
    const runner = new AgentRunner(workspace.context, sessions, createDefaultToolRegistry());
    const releaseFirst = deferred<ModelResponse>();
    const releaseCompact = deferred<ModelResponse>();
    const firstStarted = deferred<void>();
    const compactStarted = deferred<void>();
    const lastStarted = deferred<void>();
    const order: string[] = [];

    const first = runner.run(agent("newton", workspace.config.agents.default, async () => {
      order.push("run:first");
      firstStarted.resolve(undefined);
      return releaseFirst.promise;
    }), "first", "invocation-order");
    const compacting = runner.compact(agent("newton", workspace.config.agents.default, async () => {
      order.push("compact");
      compactStarted.resolve(undefined);
      return releaseCompact.promise;
    }), "invocation-order");
    const last = runner.run(agent("newton", workspace.config.agents.default, async () => {
      order.push("run:last");
      lastStarted.resolve(undefined);
      return { message: "last answer", toolCalls: [] };
    }), "last", "invocation-order");
    await firstStarted.promise;
    await flushAdmissions();
    expect(order).toEqual(["run:first"]);

    releaseFirst.resolve({ message: "first answer", toolCalls: [] });
    await compactStarted.promise;
    await flushAdmissions();
    expect(order).toEqual(["run:first", "compact"]);

    releaseCompact.resolve({ message: "summary", toolCalls: [] });
    await lastStarted.promise;
    const results = await Promise.all([first, compacting, last]);
    expect(results.every(result => result.ok)).toBe(true);
    expect(order).toEqual(["run:first", "compact", "run:last"]);
  });

  it("close drains admitted work, blocks queued side effects, and delays tool-close failure", async () => {
    const workspace = await tempWorkspace();
    const sessions = new SessionStore(workspace.context.dataDir);
    const tools = createDefaultToolRegistry();
    const runner = new AgentRunner(workspace.context, sessions, tools);
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<ModelResponse>();
    const queuedComplete = vi.fn(async (): Promise<ModelResponse> => ({ message: "must not run", toolCalls: [] }));
    const read = vi.spyOn(sessions, "readOrEmpty");

    const first = runner.run(agent("first", workspace.config.agents.default, async () => {
      firstStarted.resolve(undefined);
      return releaseFirst.promise;
    }), "first", "close-drain");
    await firstStarted.promise;
    const queued = runner.run(agent("queued", workspace.config.agents.default, queuedComplete), "queued", "close-drain");
    const toolFailure = new Error("tool close failed");
    vi.spyOn(tools, "close").mockRejectedValue(toolFailure);
    const closePromise = runner.close();
    expect(runner.close()).toBe(closePromise);
    let closeSettled = false;
    const closeOutcome = closePromise.then(
      () => {
        closeSettled = true;
        return { status: "fulfilled" as const };
      },
      (reason: unknown) => {
        closeSettled = true;
        return { status: "rejected" as const, reason };
      }
    );
    await flushAdmissions();
    expect(closeSettled).toBe(false);

    releaseFirst.resolve({ message: "ignored after close", toolCalls: [] });
    const [firstResult, queuedResult, outcome] = await Promise.all([first, queued, closeOutcome]);

    expect(firstResult.ok).toBe(false);
    expect(queuedResult.ok).toBe(false);
    expect(outcome).toEqual({ status: "rejected", reason: toolFailure });
    expect(queuedComplete).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
    const events = valueOf(await sessions.read("close-drain")).events;
    expect(events.filter(event => event.type === "message" || event.type === "conversation_item")).toEqual([
      expect.objectContaining({ type: "message", role: "user", content: "first" })
    ]);
    expect(events.filter(event => event.type === "attempt_created" && event.role === "primary")).toHaveLength(1);
  });
});
