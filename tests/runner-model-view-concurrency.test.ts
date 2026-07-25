import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Agent } from "../src/agents/agent";
import { AgentRunner } from "../src/agents/runner";
import { ok } from "../src/core/result";
import type { ModelProvider, ModelRequest } from "../src/models/provider";
import type { Tool } from "../src/tools/tool";
import {
  continuationAgent,
  createContinuationHarness
} from "./runner-continuation-fixtures";

type Deferred = Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}>;

function deferred(): Deferred {
  let resolve = (): void => undefined;
  const promise = new Promise<void>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

function concurrentProvider(expectedRequests: number, requests: ModelRequest[]): ModelProvider {
  const admitted = deferred();
  const startedSessions = new Set<string>();
  return {
    name: "concurrent-scripted",
    async complete(request) {
      requests.push(request);
      const firstRequest = !startedSessions.has(request.sessionId);
      if (firstRequest) {
        startedSessions.add(request.sessionId);
        if (startedSessions.size === expectedRequests) admitted.resolve();
        await admitted.promise;
      }
      if (firstRequest && request.sessionId.startsWith("ordinary-")) {
        return {
          message: "",
          toolCalls: [{ callId: `hidden-${request.sessionId}`, name: "contextual_search", input: {} }]
        };
      }
      return { message: `completed ${request.sessionId}`, toolCalls: [] };
    }
  };
}

describe("runner model tool views", () => {
  it("isolates one resolved model view per request across 20 concurrent context pairs", async () => {
    const pairCount = 20;
    const toolNames = ["contextual_search", "static_search"];
    const harness = await createContinuationHarness(toolNames);
    const staticSchema = Object.freeze({ type: "object", additionalProperties: false });
    const contextualSchema = Object.freeze({
      type: "object",
      properties: Object.freeze({ scope: Object.freeze({ type: "string", enum: Object.freeze(["visible"]) }) }),
      required: Object.freeze(["scope"]),
      additionalProperties: false
    });
    const resolutions: boolean[] = [];
    let contextualExecutions = 0;
    const contextualTool: Tool = {
      name: "contextual_search",
      description: "Static contextual search.",
      effect: "search",
      inputSchema: z.unknown(),
      inputJsonSchema: staticSchema,
      modelView: context => {
        const visible = context.configPath.endsWith("visible.config.yaml");
        resolutions.push(visible);
        return visible
          ? Object.freeze({
              description: "Visible contextual search.",
              inputJsonSchema: contextualSchema
            })
          : undefined;
      },
      async execute() {
        contextualExecutions += 1;
        return ok({ content: "contextual execution must remain unavailable" });
      }
    };
    const staticTool: Tool = {
      name: "static_search",
      description: "Static search.",
      effect: "search",
      inputSchema: z.unknown(),
      inputJsonSchema: staticSchema,
      async execute() {
        return ok({ content: "unused" });
      }
    };
    harness.registry.register(contextualTool);
    harness.registry.register(staticTool);

    const requests: ModelRequest[] = [];
    const provider = concurrentProvider(pairCount * 2, requests);
    const agent: Agent = continuationAgent(harness.config, provider);
    const ordinaryRunner = new AgentRunner(harness.context, harness.sessions, harness.registry);
    const visibleRunner = new AgentRunner(
      { ...harness.context, configPath: `${harness.context.workspaceRoot}/visible.config.yaml` },
      harness.sessions,
      harness.registry
    );

    const results = await Promise.all(Array.from({ length: pairCount }, (_, index) => Promise.all([
      ordinaryRunner.run(agent, "ordinary", `ordinary-${index}`),
      visibleRunner.run(agent, "visible", `visible-${index}`)
    ])));

    for (const [ordinary, visible] of results) {
      expect(ordinary).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
      expect(visible).toMatchObject({ ok: true });
    }
    expect(requests).toHaveLength(pairCount * 2);
    for (let index = 0; index < pairCount; index += 1) {
      const ordinary = requests.find(request => request.sessionId === `ordinary-${index}`);
      const visible = requests.find(request => request.sessionId === `visible-${index}`);
      expect(ordinary?.tools).toEqual(["static_search"]);
      expect(ordinary?.toolDefinitions?.map(definition => definition.name)).toEqual(["static_search"]);
      expect(visible?.tools).toEqual(["contextual_search", "static_search"]);
      expect(visible?.toolDefinitions?.map(definition => definition.name)).toEqual(visible?.tools);
      expect(visible?.toolDefinitions?.[0]).toEqual({
        name: "contextual_search",
        description: "Visible contextual search.",
        inputSchema: contextualSchema
      });
    }
    expect(resolutions.filter(visible => !visible)).toHaveLength(pairCount);
    expect(resolutions.filter(visible => visible)).toHaveLength(pairCount);
    expect(contextualExecutions).toBe(0);
    expect(contextualTool.description).toBe("Static contextual search.");
    expect(contextualTool.inputJsonSchema).toBe(staticSchema);
  });
});
