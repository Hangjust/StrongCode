import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent } from "../src/agents/agent";
import { AgentRunner } from "../src/agents/runner";
import { StrongCodeError } from "../src/core/errors";
import { err } from "../src/core/result";
import type { Message } from "../src/core/types";
import type { ModelResponse } from "../src/models/provider";
import { SessionStore } from "../src/sessions/session-store";
import { createDefaultToolRegistry } from "../src/tools/registry";
import { tempWorkspace } from "./helpers";

const HANDOFF_PROMPT = "StrongCode /start-work handoff: Execute the latest approved JBP plan in this session now. Begin with its first unblocked task and continue through its verification gates.";

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>(resolve => {
    resolvePromise = resolve;
  });
  if (!resolvePromise) throw new Error("Deferred resolver was not initialized");
  return { promise, resolve: resolvePromise };
}

function agent(name: string, config: Agent["config"], complete: Agent["model"]["complete"]): Agent {
  return { name, config: { ...config, tools: [] }, model: { name: `${name}-model`, complete } };
}

async function successfulPlan(runner: AgentRunner, config: Agent["config"], sessionId: string, content = "Original approved plan") {
  const result = await runner.run(agent("jbp", config, async () => ({ message: content, toolCalls: [] })), "Create a plan", sessionId);
  if (!result.ok) throw result.error;
  if (!result.value.planReceipt) throw new Error("Expected JBP plan receipt");
  return result.value.planReceipt;
}

describe("runner plan handoff receipts", () => {
  it("issues a receipt only after a terminal non-empty canonical JBP response is persisted", async () => {
    // Given
    const workspace = await tempWorkspace();
    const sessions = new SessionStore(workspace.context.dataDir);
    const runner = new AgentRunner(workspace.context, sessions, createDefaultToolRegistry());

    // When
    const result = await runner.run(agent("jbp", workspace.config.agents.default, async () => ({ message: "  Approved plan  ", toolCalls: [] })), "Plan", "terminal-plan");
    const stored = await sessions.read("terminal-plan");

    // Then
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.planReceipt).toBeDefined();
    expect(stored.ok).toBe(true);
    if (stored.ok) expect(stored.value.events.filter(event => event.type === "message" || event.type === "conversation_item").at(-1)).toMatchObject({ role: "assistant", content: "Approved plan", agentId: "jbp" });
  });

  it.each([
    { label: "blank terminal response", response: async (): Promise<ModelResponse> => ({ message: "   ", toolCalls: [] }) },
    { label: "model failure", response: async (): Promise<ModelResponse> => { throw new StrongCodeError("MODEL_ERROR", "planner failed"); } }
  ])("does not issue a receipt after $label", async ({ response }) => {
    // Given
    const workspace = await tempWorkspace();
    const runner = new AgentRunner(workspace.context, new SessionStore(workspace.context.dataDir), createDefaultToolRegistry());

    // When
    const result = await runner.run(agent("jbp", workspace.config.agents.default, response), "Plan", `no-receipt-${response.name || "case"}`);

    // Then
    expect(result.ok ? result.value.planReceipt : undefined).toBeUndefined();
  });

  it("does not issue a receipt when the terminal assistant append fails", async () => {
    // Given
    const workspace = await tempWorkspace();
    const sessions = new SessionStore(workspace.context.dataDir);
    const commit = sessions.commitGuarded.bind(sessions);
    vi.spyOn(sessions, "commitGuarded").mockImplementation(async (sessionId, event, guard) => {
      if (event?.type === "message" && event.role === "assistant") {
        return err(new StrongCodeError("SESSION_ERROR", "assistant append failed"));
      }
      return commit(sessionId, event, guard);
    });
    const runner = new AgentRunner(workspace.context, sessions, createDefaultToolRegistry());

    // When
    const result = await runner.run(agent("jbp", workspace.config.agents.default, async () => ({ message: "Unpersisted plan", toolCalls: [] })), "Plan", "append-failure");

    // Then
    expect(result.ok).toBe(false);
  });

  it("revokes a prior receipt before a later failed JBP revision reaches session or model work", async () => {
    // Given
    const workspace = await tempWorkspace();
    const sessions = new SessionStore(workspace.context.dataDir);
    const runner = new AgentRunner(workspace.context, sessions, createDefaultToolRegistry());
    const receipt = await successfulPlan(runner, workspace.config.agents.default, "revision");
    const read = vi.spyOn(sessions, "readOrEmpty").mockImplementation(async () => err(new StrongCodeError("SESSION_ERROR", "revision read failed")));

    // When
    const revision = await runner.run(agent("jbp", workspace.config.agents.default, async () => ({ message: "Never reached", toolCalls: [] })), "Revise", "revision");
    const consumed = runner.consumePlanReceipt("revision", receipt);

    // Then
    expect(revision.ok).toBe(false);
    expect(read).toHaveBeenCalledOnce();
    expect(consumed.ok).toBe(false);
  });

  it("invalidates the first JBP generation when a second invocation is admitted", async () => {
    // Given
    const workspace = await tempWorkspace();
    const runner = new AgentRunner(workspace.context, new SessionStore(workspace.context.dataDir), createDefaultToolRegistry());
    const firstResponse = deferred<ModelResponse>();
    const secondResponse = deferred<ModelResponse>();
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const first = runner.run(agent("jbp", workspace.config.agents.default, async () => {
      firstStarted.resolve();
      return firstResponse.promise;
    }), "First plan", "concurrent");
    await firstStarted.promise;
    const second = runner.run(agent("jbp", workspace.config.agents.default, async () => {
      secondStarted.resolve();
      return secondResponse.promise;
    }), "Second plan", "concurrent");

    // When
    firstResponse.resolve({ message: "Stale plan", toolCalls: [] });
    const firstResult = await first;
    await secondStarted.promise;
    secondResponse.resolve({ message: "Current plan", toolCalls: [] });
    const secondResult = await second;

    // Then
    expect(firstResult.ok && firstResult.value.planReceipt).toBeUndefined();
    expect(secondResult.ok && secondResult.value.planReceipt).toBeDefined();
    if (!secondResult.ok || !secondResult.value.planReceipt) throw new Error("Expected current receipt");
    expect(runner.consumePlanReceipt("concurrent", secondResult.value.planReceipt).ok).toBe(true);
  });

  it("rejects wrong-session and process-local forged receipts without destroying the valid receipt", async () => {
    // Given
    const workspace = await tempWorkspace();
    const runner = new AgentRunner(workspace.context, new SessionStore(workspace.context.dataDir), createDefaultToolRegistry());
    const otherRunner = new AgentRunner(workspace.context, new SessionStore(workspace.context.dataDir), createDefaultToolRegistry());
    const valid = await successfulPlan(runner, workspace.config.agents.default, "exact-session");
    const foreign = await successfulPlan(otherRunner, workspace.config.agents.default, "foreign-session");

    // When / Then
    expect(runner.consumePlanReceipt("wrong-session", valid).ok).toBe(false);
    expect(runner.consumePlanReceipt("exact-session", foreign).ok).toBe(false);
    expect(runner.consumePlanReceipt("exact-session", valid).ok).toBe(true);
  });

  it("consumes a valid receipt and its approved snapshot exactly once", async () => {
    // Given
    const workspace = await tempWorkspace();
    const runner = new AgentRunner(workspace.context, new SessionStore(workspace.context.dataDir), createDefaultToolRegistry());
    const receipt = await successfulPlan(runner, workspace.config.agents.default, "one-use");

    // When
    const first = runner.consumePlanReceipt("one-use", receipt);
    const second = runner.consumePlanReceipt("one-use", receipt);

    // Then
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
  });

  it("runs approved Bob from the immutable snapshot and persists the ordinary handoff turn", async () => {
    // Given
    const workspace = await tempWorkspace();
    const sessions = new SessionStore(workspace.context.dataDir);
    const runner = new AgentRunner(workspace.context, sessions, createDefaultToolRegistry());
    const receipt = await successfulPlan(runner, workspace.config.agents.default, "immutable");
    const consumed = runner.consumePlanReceipt("immutable", receipt);
    if (!consumed.ok) throw consumed.error;
    const sessionPath = sessions.pathFor("immutable");
    if (!sessionPath.ok) throw sessionPath.error;
    await writeFile(sessionPath.value, `${JSON.stringify({
      type: "message",
      timestamp: "2026-07-14T00:00:00.000Z",
      role: "assistant",
      content: "Forged replacement plan",
      agentId: "jbp"
    })}\n`, { flag: "a" });
    const seen: Array<readonly Message[]> = [];
    const bob = agent("bob-the-builder", workspace.config.agents.default, async request => {
      seen.push(request.messages);
      return { message: "Implemented original plan", toolCalls: [] };
    });

    // When
    const result = await runner.runApprovedPlan(bob, HANDOFF_PROMPT, "immutable", consumed.value);
    const stored = await sessions.read("immutable");

    // Then
    expect(result.ok).toBe(true);
    expect(seen).toEqual([[
      { role: "user", content: "Create a plan" },
      { role: "assistant", content: "Original approved plan" },
      { role: "user", content: HANDOFF_PROMPT }
    ]]);
    expect(stored.ok).toBe(true);
    if (stored.ok) expect(stored.value.events.filter(event => event.type === "message" || event.type === "conversation_item").slice(-2)).toEqual([
      expect.objectContaining({ type: "message", role: "user", content: HANDOFF_PROMPT, agentId: "bob-the-builder" }),
      expect.objectContaining({ type: "message", role: "assistant", content: "Implemented original plan", agentId: "bob-the-builder" })
    ]);
    expect(seen[0]?.some(message => "receipt" in message || "agentId" in message)).toBe(false);
  });

  it("burns an approved snapshot after one failed non-Bob submission", async () => {
    // Given
    const workspace = await tempWorkspace();
    const runner = new AgentRunner(workspace.context, new SessionStore(workspace.context.dataDir), createDefaultToolRegistry());
    const receipt = await successfulPlan(runner, workspace.config.agents.default, "bob-only");
    const consumed = runner.consumePlanReceipt("bob-only", receipt);
    if (!consumed.ok) throw consumed.error;
    const tesla = agent("tesla", workspace.config.agents.default, async () => ({ message: "Must not run", toolCalls: [] }));
    const bob = agent("bob-the-builder", workspace.config.agents.default, async () => ({ message: "Must not run later", toolCalls: [] }));

    // When
    const wrongAgent = await runner.runApprovedPlan(tesla, HANDOFF_PROMPT, "bob-only", consumed.value);
    const retry = await runner.runApprovedPlan(bob, HANDOFF_PROMPT, "bob-only", consumed.value);

    // Then
    expect(wrongAgent.ok).toBe(false);
    expect(retry.ok).toBe(false);
  });
});
