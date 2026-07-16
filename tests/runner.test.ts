import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent } from "../src/agents/agent";
import { AgentRunner } from "../src/agents/runner";
import { MockModelProvider } from "../src/models/mock-provider";
import { SessionStore } from "../src/sessions/session-store";
import { createDefaultToolRegistry } from "../src/tools/registry";
import { tempWorkspace } from "./helpers";

describe("runner", () => {
  it("preserves one session across a JBP to Bob handoff", async () => {
    const workspace = await tempWorkspace();
    const seen: Array<Array<{ role: string; content: string }>> = [];
    const runner = new AgentRunner(workspace.context, new SessionStore(workspace.context.dataDir), createDefaultToolRegistry());
    const jbp: Agent = {
      name: "jbp",
      config: workspace.config.agents.default,
      model: { name: "planner", async complete() { return { message: "Approved plan: update A, then verify B.", toolCalls: [] }; } }
    };
    const bob: Agent = {
      name: "bob-the-builder",
      config: workspace.config.agents.default,
      systemPrompt: "The user invoked /start-work.",
      model: {
        name: "builder",
        async complete(request) {
          seen.push(request.messages);
          return { message: "Executing the approved plan.", toolCalls: [] };
        }
      }
    };

    const plan = await runner.run(jbp, "Make a plan", "shared-plan-session");
    if (!plan.ok || !plan.value.planReceipt) throw new Error("Expected JBP plan receipt");
    const approved = runner.consumePlanReceipt("shared-plan-session", plan.value.planReceipt);
    if (!approved.ok) throw approved.error;
    const result = await runner.runApprovedPlan(bob, "Start implementation", "shared-plan-session", approved.value);

    expect(result.ok).toBe(true);
    expect(seen[0]).toEqual(expect.arrayContaining([
      { role: "user", content: "Make a plan" },
      { role: "assistant", content: "Approved plan: update A, then verify B." },
      { role: "user", content: "Start implementation" }
    ]));
  });

  it("stores canonical agent provenance on both sides of a completed turn", async () => {
    const workspace = await tempWorkspace();
    const sessions = new SessionStore(workspace.context.dataDir);
    const runner = new AgentRunner(workspace.context, sessions, createDefaultToolRegistry());
    const agent: Agent = {
      name: "jbp",
      displayName: "JBP Plan Builder",
      config: workspace.config.agents.default,
      model: { name: "planner", async complete() { return { message: "A retained plan", toolCalls: [] }; } }
    };

    const result = await runner.run(agent, "Plan this", "provenance");
    const session = await sessions.read("provenance");

    expect(result.ok).toBe(true);
    expect(session.ok).toBe(true);
    if (session.ok) {
      expect(session.value.events.filter(event => event.type === "message" || event.type === "conversation_item")).toEqual([
        expect.objectContaining({ type: "message", role: "user", content: "Plan this", agentId: "jbp" }),
        expect.objectContaining({ type: "message", role: "assistant", content: "A retained plan", agentId: "jbp" })
      ]);
    }
  });

  it("runs hello with the mock provider and stores a session", async () => {
    const workspace = await tempWorkspace();
    const agent: Agent = {
      name: "default",
      config: workspace.config.agents.default,
      model: new MockModelProvider()
    };
    const runner = new AgentRunner(workspace.context, new SessionStore(workspace.context.dataDir), createDefaultToolRegistry());

    const result = await runner.run(agent, "hello", "demo");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.response).toBe("Mock response: hello");
      expect(result.value.toolExecutions).toHaveLength(0);
    }
  });

  it("executes allowed read-only tools requested by the mock provider", async () => {
    const workspace = await tempWorkspace();
    await writeFile(path.join(workspace.root, "note.txt"), "agent-readable", "utf8");
    const agent: Agent = {
      name: "default",
      config: workspace.config.agents.default,
      model: new MockModelProvider()
    };
    const runner = new AgentRunner(workspace.context, new SessionStore(workspace.context.dataDir), createDefaultToolRegistry());

    const result = await runner.run(agent, "read file note.txt", "tools");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.response).toBe("Mock response: (empty prompt)");
      expect(result.value.toolExecutions).toHaveLength(1);
      expect(result.value.toolExecutions[0]?.output).toContain("agent-readable");
    }
  });

  it("bounds canonical model tool calls", async () => {
    const workspace = await tempWorkspace();
    const agent: Agent = {
      name: "default",
      config: workspace.config.agents.default,
      model: {
        name: "too-many-tools",
        async complete() {
          return {
            message: "too much",
            toolCalls: [
              { callId: "call-list-first", name: "list_files", input: { path: "." } },
              { callId: "call-list-second", name: "list_files", input: { path: "." } }
            ]
          };
        }
      }
    };
    const runner = new AgentRunner(workspace.context, new SessionStore(workspace.context.dataDir), createDefaultToolRegistry(), { maxToolCalls: 1 });

    const result = await runner.run(agent, "list files", "bounded");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TOOL_TOTAL_LIMIT");
  });
});
