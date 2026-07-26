import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Agent } from "../src/agents/agent";
import type { PrimaryPreflightScheduler } from "../src/agents/preflight/runner-gate";
import { PreflightScheduler } from "../src/agents/preflight/scheduler";
import { PreflightRunRegistry } from "../src/agents/preflight/scheduler-registry";
import { AgentRunner } from "../src/agents/runner";
import { ok } from "../src/core/result";
import type { ModelRequest } from "../src/models/provider";
import type { ToolInvocationContext } from "../src/runtime/context";
import { computerUseEnabled, withComputerUseEnabled } from "../src/tools/computer-use-policy";
import { ToolRegistry } from "../src/tools/registry";
import type { Tool } from "../src/tools/tool";
import {
  completeDecision,
  modelResponse,
  scheduleInput,
  schedulerHarness,
  terminal
} from "./fixtures/preflight-scheduler-harness";

describe("preflight model tool projection", () => {
  it("scrubs inherited computer-use authority before primary preflight projection", async () => {
    // Given
    const harness = await schedulerHarness();
    const inheritedContext = withComputerUseEnabled(harness.context);
    const tools = new ToolRegistry();
    const managerConnectionAttempts: string[] = [];
    tools.register({
      name: "web_search",
      description: "Computer Use search route.",
      effect: "read-only-web",
      readOnly: true,
      inputSchema: z.unknown(),
      modelView: context => computerUseEnabled(context)
        ? { description: "Computer Use route: mcp__open_computer_use__click" }
        : undefined,
      async execute() {
        managerConnectionAttempts.push("connect");
        return ok({ content: "unexpected manager result" });
      }
    });
    harness.models.enqueue("summary", modelResponse("", [{
      callId: "inherited-computer-use",
      name: "web_search",
      input: { query: "must not run" }
    }]));
    harness.models.enqueue("summary", completeDecision("Unexpected inherited route"));
    let schedulerId = 0;
    const scheduler = new PreflightScheduler({
      sessions: harness.sessions,
      registry: new PreflightRunRegistry(),
      clock: harness.clock,
      ids: { next: () => `inherited-preflight-${++schedulerId}` },
      createAgent: harness.models.factory,
      resolveModelSnapshot: ({ role }) => ({
        modelRef: `fixture-${role}`,
        providerRef: "fixture-provider",
        displayName: `Fixture ${role}`
      })
    });
    let scheduledContext: ToolInvocationContext | undefined;
    const preflight: PrimaryPreflightScheduler = {
      async run(input) {
        scheduledContext = input.context;
        return scheduler.run(input);
      },
      async close(reason) {
        await scheduler.close(reason);
      }
    };
    const primaryRequests: ModelRequest[] = [];
    const primary: Agent = {
      name: "ordinary-primary",
      runtimeRole: "primary",
      config: {
        ...inheritedContext.config.agents[inheritedContext.config.defaultAgent],
        tools: ["web_search"]
      },
      model: {
        name: "primary-model",
        async complete(request) {
          primaryRequests.push(request);
          return { message: "primary complete", toolCalls: [] };
        }
      }
    };
    const runner = new AgentRunner(inheritedContext, harness.sessions, tools, { preflight });

    // When
    const result = await runner.run(primary, "Inspect this repository", "preflight-inherited-computer-use");

    // Then
    expect(result.ok).toBe(true);
    expect.soft(scheduledContext).not.toHaveProperty("computerUse");
    const preflightRequest = harness.models.requests.summary[0];
    if (preflightRequest === undefined) throw new Error("Missing preflight request");
    expect.soft(preflightRequest.tools).toEqual([]);
    expect.soft(preflightRequest.toolDefinitions).toEqual([]);
    expect.soft(managerConnectionAttempts).toEqual([]);
    expect(primaryRequests).toHaveLength(1);
    expect(primaryRequests[0]?.prompt).toBe("Inspect this repository");
    expect(primaryRequests[0]?.tools).toEqual([]);
  });

  it("uses one contextual projection for provider metadata and admission", async () => {
    const harness = await schedulerHarness();
    const tools = new ToolRegistry();
    let projectionContext: ToolInvocationContext | undefined;
    let hiddenExecutions = 0;
    const staticTool: Tool = {
      name: "read_file",
      description: "Static reader.",
      effect: "read",
      inputSchema: z.unknown(),
      inputJsonSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false
      },
      async execute() {
        return ok({ content: "unused" });
      }
    };
    const overriddenTool: Tool = {
      name: "ripgrep",
      description: "Static search.",
      effect: "search",
      inputSchema: z.unknown(),
      modelView: context => {
        projectionContext = context;
        return {
          description: "Contextual search.",
          inputJsonSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
              options: {
                type: "object",
                properties: { fixedStrings: { type: "boolean" } },
                additionalProperties: false
              }
            },
            required: ["query"],
            additionalProperties: false
          }
        };
      },
      async execute() {
        return ok({ content: "unused" });
      }
    };
    const hiddenTool: Tool = {
      name: "web_search",
      description: "Hidden web route.",
      effect: "read-only-web",
      inputSchema: z.unknown(),
      modelView: () => undefined,
      async execute() {
        hiddenExecutions += 1;
        return ok({ content: "unexpected" });
      }
    };
    tools.register(staticTool);
    tools.register(overriddenTool);
    tools.register(hiddenTool);
    harness.models.enqueue("summary", modelResponse("", [{
      callId: "hidden-preflight-call",
      name: "web_search",
      input: { query: "should not run" }
    }]));

    const settled = await terminal(await harness.scheduler.run(scheduleInput(harness, {
      toolRegistry: tools
    })));

    expect(settled).toMatchObject({
      ok: true,
      value: { kind: "failed-open", reasonCode: "tool_permission_denied" }
    });
    expect(hiddenExecutions).toBe(0);
    const request = harness.models.requests.summary[0];
    if (request === undefined) throw new Error("Missing projected preflight request");
    expect(request.tools).toEqual(["read_file", "ripgrep"]);
    expect(request.tools).toEqual(request.toolDefinitions?.map(definition => definition.name));
    expect(request.toolDefinitions?.[1]).toEqual({
      name: "ripgrep",
      description: "Contextual search.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          options: {
            type: "object",
            properties: { fixedStrings: { type: "boolean" } },
            additionalProperties: false
          }
        },
        required: ["query"],
        additionalProperties: false
      }
    });
    expect(projectionContext?.signal).toBe(request.signal);
    expect(projectionContext?.effectivePermissions?.ripgrep).toBe("allow");
  });
});
