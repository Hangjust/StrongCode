import type { Agent } from "../src/agents/agent";
import { PlanHandoffStore, type PlanReceipt } from "../src/agents/plan-handoff";
import { AgentRunner } from "../src/agents/runner";
import { StrongCodeError } from "../src/core/errors";
import { err } from "../src/core/result";
import type { ConversationItem } from "../src/core/types";
import type { ModelResponse } from "../src/models/provider";
import { SessionStore } from "../src/sessions/session-store";
import { createDefaultToolRegistry } from "../src/tools/registry";
import { tempWorkspace } from "./helpers";

const PLAN_ITEMS = [{ type: "text", role: "assistant", content: "Approved plan" }] satisfies readonly ConversationItem[];

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

function testAgent(name: string, config: Agent["config"], complete: Agent["model"]["complete"]): Agent {
  return { name, config: { ...config, tools: [] }, model: { name: `${name}-lifecycle`, complete } };
}

function handoffsOf(runner: AgentRunner): PlanHandoffStore {
  const handoffs: unknown = Reflect.get(runner, "planHandoffs");
  if (!(handoffs instanceof PlanHandoffStore)) throw new Error("Expected runner plan handoff store");
  return handoffs;
}

function generationCount(store: PlanHandoffStore): number {
  const generations: unknown = Reflect.get(store, "generations");
  if (!(generations instanceof Map)) throw new Error("Expected plan generation map");
  return generations.size;
}

async function issuePlan(runner: AgentRunner, config: Agent["config"], sessionId: string): Promise<PlanReceipt> {
  const result = await runner.run(
    testAgent("jbp", config, async () => ({ message: "Approved plan", toolCalls: [] })),
    "Create a plan",
    sessionId
  );
  if (!result.ok) throw result.error;
  if (result.value.planReceipt === undefined) throw new Error("Expected plan receipt");
  return result.value.planReceipt;
}

describe("plan handoff lifecycle", () => {
  it.runIf(process.platform === "win32")("shares authority across real Windows case aliases while retaining raw run spelling", async () => {
    // Given
    const workspace = await tempWorkspace();
    const sessions = new SessionStore(workspace.context.dataDir);
    const append = vi.spyOn(sessions, "append");
    const runner = new AgentRunner(workspace.context, sessions, createDefaultToolRegistry());
    const oldReceipt = await issuePlan(runner, workspace.config.agents.default, "Plan");

    // When
    const later = await runner.run(
      testAgent("jbp", workspace.config.agents.default, async () => ({ message: "Replacement plan", toolCalls: [] })),
      "Revise",
      "plan"
    );

    // Then
    expect(later.ok).toBe(true);
    if (!later.ok || later.value.planReceipt === undefined) throw new Error("Expected replacement receipt");
    expect(later.value.sessionId).toBe("plan");
    expect(append.mock.calls.some(([sessionId]) => sessionId === "plan")).toBe(true);
    expect(runner.consumePlanReceipt("Plan", oldReceipt).ok).toBe(false);
    expect(runner.consumePlanReceipt("PLAN", later.value.planReceipt).ok).toBe(true);
  });

  it("shares process-local authority across runners using the same operation key", async () => {
    // Given
    const workspace = await tempWorkspace();
    const firstRunner = new AgentRunner(
      workspace.context,
      new SessionStore(workspace.context.dataDir),
      createDefaultToolRegistry()
    );
    const secondRunner = new AgentRunner(
      workspace.context,
      new SessionStore(workspace.context.dataDir),
      createDefaultToolRegistry()
    );
    const staleReceipt = await issuePlan(firstRunner, workspace.config.agents.default, "cross-runner");

    // When
    const currentReceipt = await issuePlan(secondRunner, workspace.config.agents.default, "cross-runner");

    // Then
    expect(firstRunner.consumePlanReceipt("cross-runner", staleReceipt).ok).toBe(false);
    expect(firstRunner.consumePlanReceipt("cross-runner", currentReceipt).ok).toBe(true);
  });

  it("retires only the exact generation when issuing a receipt", () => {
    // Given
    const store = new PlanHandoffStore();
    const stale = store.begin("shared-key");
    const current = store.begin("shared-key");

    // When
    store.retire("shared-key", stale);
    const receipt = store.issue("shared-key", current, PLAN_ITEMS);

    // Then
    expect(receipt).toBeDefined();
    expect(generationCount(store)).toBe(0);
    expect(store.issue("shared-key", current, PLAN_ITEMS)).toBeUndefined();
    if (receipt === undefined) throw new Error("Expected issued receipt");
    expect(store.consume("shared-key", receipt)).toBeDefined();
  });

  it("does not create a generation for an invalid session id", async () => {
    // Given
    const workspace = await tempWorkspace();
    const complete = vi.fn(async (): Promise<ModelResponse> => ({ message: "Must not run", toolCalls: [] }));
    const runner = new AgentRunner(workspace.context, new SessionStore(workspace.context.dataDir), createDefaultToolRegistry());

    // When
    const result = await runner.run(testAgent("jbp", workspace.config.agents.default, complete), "Plan", "../escape");

    // Then
    expect(result.ok).toBe(false);
    expect(complete).not.toHaveBeenCalled();
    expect(generationCount(handoffsOf(runner))).toBe(0);
  });

  it.each([
    { label: "blank response", arrange: async () => ({ message: "   ", toolCalls: [] }) },
    { label: "model failure", arrange: async (): Promise<ModelResponse> => { throw new StrongCodeError("MODEL_ERROR", "failed"); } }
  ])("retires after $label", async ({ arrange }) => {
    // Given
    const workspace = await tempWorkspace();
    const runner = new AgentRunner(workspace.context, new SessionStore(workspace.context.dataDir), createDefaultToolRegistry());

    // When
    await runner.run(testAgent("jbp", workspace.config.agents.default, arrange), "Plan", "terminal-model");

    // Then
    expect(generationCount(handoffsOf(runner))).toBe(0);
  });

  it("retires after session failure, cancellation, and terminal commit failure", async () => {
    // Given
    const workspace = await tempWorkspace();
    const failingSessions = new SessionStore(workspace.context.dataDir);
    vi.spyOn(failingSessions, "readOrEmpty").mockResolvedValue(err(new StrongCodeError("SESSION_ERROR", "read failed")));
    const sessionRunner = new AgentRunner(workspace.context, failingSessions, createDefaultToolRegistry());
    const controller = new AbortController();
    controller.abort();
    const cancelledRunner = new AgentRunner(
      { ...workspace.context, signal: controller.signal },
      new SessionStore(workspace.context.dataDir),
      createDefaultToolRegistry()
    );
    const commitSessions = new SessionStore(workspace.context.dataDir);
    vi.spyOn(commitSessions, "commitGuarded").mockResolvedValue(err(new StrongCodeError("SESSION_ERROR", "commit failed")));
    const commitRunner = new AgentRunner(workspace.context, commitSessions, createDefaultToolRegistry());
    const planner = testAgent("jbp", workspace.config.agents.default, async () => ({ message: "Plan", toolCalls: [] }));

    // When
    await Promise.all([
      sessionRunner.run(planner, "Plan", "session-failure"),
      cancelledRunner.run(planner, "Plan", "cancelled"),
      commitRunner.run(planner, "Plan", "commit-failure")
    ]);

    // Then
    expect([sessionRunner, cancelledRunner, commitRunner].map(runner => generationCount(handoffsOf(runner)))).toEqual([0, 0, 0]);
  });

  it("retires queued plan work rejected during close", async () => {
    // Given
    const workspace = await tempWorkspace();
    const runner = new AgentRunner(workspace.context, new SessionStore(workspace.context.dataDir), createDefaultToolRegistry());
    const started = deferred<void>();
    const release = deferred<ModelResponse>();
    const active = runner.run(testAgent("tesla", workspace.config.agents.default, async () => {
      started.resolve(undefined);
      return release.promise;
    }), "Active", "close-queue");
    await started.promise;
    const queued = runner.run(testAgent("jbp", workspace.config.agents.default, async () => ({ message: "Must not run", toolCalls: [] })), "Plan", "close-queue");

    // When
    const closing = runner.close();
    release.resolve({ message: "Late", toolCalls: [] });
    await Promise.all([active, queued, closing]);

    // Then
    expect(generationCount(handoffsOf(runner))).toBe(0);
  });

  it("leaves no generations after 10,000 issue and consume cycles", () => {
    // Given
    const store = new PlanHandoffStore();

    // When
    for (let index = 0; index < 10_000; index += 1) {
      const key = `session-${index}`;
      const generation = store.begin(key);
      const receipt = store.issue(key, generation, PLAN_ITEMS);
      if (receipt === undefined) throw new Error("Expected issued receipt");
      store.consume(key, receipt);
    }

    // Then
    expect(generationCount(store)).toBe(0);
  });

  it("preserves a snapshot after a wrong key but burns it after a wrong agent", async () => {
    // Given
    const workspace = await tempWorkspace();
    const runner = new AgentRunner(workspace.context, new SessionStore(workspace.context.dataDir), createDefaultToolRegistry());
    const receipt = await issuePlan(runner, workspace.config.agents.default, "snapshot-owner");
    const approved = runner.consumePlanReceipt("snapshot-owner", receipt);
    if (!approved.ok) throw approved.error;
    const bob = testAgent("bob-the-builder", workspace.config.agents.default, async () => ({ message: "Built", toolCalls: [] }));

    // When / Then
    expect((await runner.runApprovedPlan(bob, "Build", "other-session", approved.value)).ok).toBe(false);
    expect((await runner.runApprovedPlan(bob, "Build", "snapshot-owner", approved.value)).ok).toBe(true);
    const secondReceipt = await issuePlan(runner, workspace.config.agents.default, "wrong-agent");
    const secondApproved = runner.consumePlanReceipt("wrong-agent", secondReceipt);
    if (!secondApproved.ok) throw secondApproved.error;
    const tesla = testAgent("tesla", workspace.config.agents.default, async () => ({ message: "Must not run", toolCalls: [] }));
    expect((await runner.runApprovedPlan(tesla, "Build", "wrong-agent", secondApproved.value)).ok).toBe(false);
    expect((await runner.runApprovedPlan(bob, "Build", "wrong-agent", secondApproved.value)).ok).toBe(false);
  });
});
