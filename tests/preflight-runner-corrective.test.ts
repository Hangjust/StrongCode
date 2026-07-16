import { describe, expect, it } from "vitest";
import type { Agent } from "../src/agents/agent";
import { PreflightRunRegistry } from "../src/agents/preflight/scheduler-registry";
import { PreflightScheduler } from "../src/agents/preflight/scheduler";
import { AgentRunner } from "../src/agents/runner";
import { ok } from "../src/core/result";
import type { ModelRequest } from "../src/models/provider";
import { projectSessionLedger } from "../src/sessions/session-ledger-projection";
import { RuntimeAgentRunnerFactory } from "../src/runtime/runner-factory";
import { RecordingPreflight, committed, primaryHarness } from "./fixtures/preflight-runner-harness";
import { schedulerHarness } from "./fixtures/preflight-scheduler-harness";
import { tempWorkspace } from "./helpers";

describe("Todo 8 corrective runner integration", () => {
  it("gates an omitted runtimeRole through the established default-primary path", async () => {
    const preflight = new RecordingPreflight(ok(committed()));
    const harness = await primaryHarness(preflight);
    const agent: Agent = {
      name: harness.agent.name,
      config: harness.agent.config,
      model: harness.agent.model,
      systemPrompt: harness.agent.systemPrompt
    };

    const result = await harness.runner.run(agent, "omitted role prompt", "omitted-role-corrective");

    expect(result.ok).toBe(true);
    expect(preflight.inputs).toHaveLength(1);
    expect(harness.requests).toHaveLength(1);
  });

  it("terminalizes a durable reserved orphan before one primary fail-open dispatch", async () => {
    const harness = await schedulerHarness();
    const sessionId = "runner-reserved-orphan";
    const prompt = "durable reserved prompt";
    const reserved = await harness.sessions.reserveFirstSummary(sessionId, {
      sourceMessageId: "persisted-source-message",
      originalPrompt: prompt
    });
    if (!reserved.ok) throw reserved.error;
    let id = 0;
    const scheduler = new PreflightScheduler({
      sessions: harness.sessions,
      registry: new PreflightRunRegistry(),
      clock: harness.clock,
      ids: { next: () => `corrective-scheduler-${++id}` },
      createAgent: harness.models.factory,
      resolveModelSnapshot: ({ role }) => ({
        modelRef: `fixture-${role}`,
        providerRef: "fixture-provider",
        displayName: `Fixture ${role}`
      })
    });
    const requests: ModelRequest[] = [];
    const agent: Agent = {
      name: "orphan-primary",
      runtimeRole: "primary",
      config: harness.context.config.agents[harness.context.config.defaultAgent],
      model: {
        name: "primary-model",
        async complete(request) {
          requests.push(request);
          return { message: "primary done", toolCalls: [] };
        }
      }
    };
    const runner = new AgentRunner(harness.context, harness.sessions, harness.tools, { preflight: scheduler });

    const result = await runner.run(agent, prompt, sessionId);

    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(harness.models.requests.summary).toHaveLength(0);
    const stored = await harness.sessions.read(sessionId);
    if (!stored.ok) throw stored.error;
    expect(projectSessionLedger(stored.value.events).summary)
      .toMatchObject({ kind: "failed-open", reasonCode: "orphaned_reservation" });
  });

  it("shares one private registry across runtime factory instances in this process", async () => {
    const workspace = await tempWorkspace();
    const first = new RuntimeAgentRunnerFactory(workspace.context);
    const second = new RuntimeAgentRunnerFactory(workspace.context);

    expect(first["registry"]).toBe(second["registry"]);
  });
});
