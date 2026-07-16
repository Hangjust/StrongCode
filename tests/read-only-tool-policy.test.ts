import { describe, expect, it } from "vitest";
import type { Agent } from "../src/agents/agent";
import { AgentRunner } from "../src/agents/runner";
import { admitToolBatch } from "../src/agents/runner-tool-batch";
import { createAgent } from "../src/runtime/factory";
import type { ToolInvocationContext } from "../src/runtime/context";
import { SessionStore } from "../src/sessions/session-store";
import { readFileTool } from "../src/tools/builtin/read-file";
import { ToolRegistry } from "../src/tools/registry";
import type { Tool, ToolEffect } from "../src/tools/tool";
import { tempWorkspace } from "./helpers";

type ToolFixture = {
  readonly name: string;
  readonly effect: ToolEffect;
  readonly readOnly?: boolean;
};

type ScenarioOptions = {
  readonly fixture: ToolFixture;
  readonly policy?: "standard" | "read-only";
  readonly displayName?: string;
  readonly configuredPermission?: "allow" | "deny";
  readonly effectivePermission?: "allow" | "deny";
  readonly canonicalAgent?: "jbp";
};

async function runScenario(options: ScenarioOptions) {
  const workspace = await tempWorkspace();
  workspace.config.agents.default.tools = options.fixture.name.startsWith("mcp__context7__")
    ? ["mcp__context7__*"]
    : [options.fixture.name];
  workspace.config.permissions.tools[options.fixture.name.startsWith("mcp__context7__")
    ? "mcp__context7__*"
    : options.fixture.name] = options.configuredPermission ?? "allow";
  let invocations = 0;
  const tool: Tool = {
    name: options.fixture.name,
    description: "Resolved tool policy fixture",
    effect: options.fixture.effect,
    inputSchema: readFileTool.inputSchema,
    ...(options.fixture.readOnly === undefined ? {} : { readOnly: options.fixture.readOnly }),
    async execute() {
      invocations += 1;
      return { ok: true, value: { content: "executed" } };
    }
  };
  const registry = new ToolRegistry();
  registry.register(tool);
  const advertised: string[][] = [];
  let completion = 0;
  const model = {
    name: "malicious-policy-fixture",
    async complete(request: Parameters<Agent["model"]["complete"]>[0]) {
      advertised.push([...request.tools]);
      completion += 1;
      return completion === 1
        ? { message: "", toolCalls: [{ callId: "policy-call", name: tool.name, input: {} }] }
        : { message: "done", toolCalls: [] };
    }
  };
  const baseAgent = options.canonicalAgent
    ? createAgent(workspace.config, options.canonicalAgent)
    : {
        name: "manual",
        displayName: options.displayName,
        config: workspace.config.agents.default,
        model
      };
  const agent: Agent = {
    ...baseAgent,
    ...(options.policy === undefined ? {} : { toolPolicy: options.policy }),
    model
  };
  const context: ToolInvocationContext = options.effectivePermission === undefined
    ? workspace.context
    : { ...workspace.context, effectivePermissions: { [tool.name]: options.effectivePermission } };
  const runner = new AgentRunner(context, new SessionStore(context.dataDir), registry);

  const result = await runner.run(agent, "Invoke the requested tool", `policy-${crypto.randomUUID()}`);

  return { advertised, invocations, result };
}

describe("resolved read-only tool policy", () => {
  it("blocks a mutable direct MCP-shaped tool under an allowed Context7 wildcard", async () => {
    const outcome = await runScenario({
      canonicalAgent: "jbp",
      fixture: { name: "mcp__context7__overwrite_docs", effect: "mutation", readOnly: false }
    });

    expect(outcome.advertised[0]).toEqual([]);
    expect(outcome.result).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    expect(outcome.invocations).toBe(0);
  });

  it.each([
    ["unclassified", true],
    ["mutation", true],
    ["read", undefined],
    ["read", false],
    ["discovery", true],
    ["shell", true],
    ["worker", true],
    ["spawn", true]
  ] satisfies ReadonlyArray<readonly [ToolEffect, boolean | undefined]>)
  ("denies resolved %s tools with readOnly %s", async (effect, readOnly) => {
    const outcome = await runScenario({
      policy: "read-only",
      fixture: { name: `mcp__context7__${effect}-${String(readOnly)}`, effect, readOnly }
    });

    expect(outcome.advertised[0]).toEqual([]);
    expect(outcome.result).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    expect(outcome.invocations).toBe(0);
  });

  it.each([
    ["read_file", "read"],
    ["safe_search", "search"],
    ["safe_web", "read-only-web"],
    ["question", "interaction"]
  ] satisfies ReadonlyArray<readonly [string, ToolEffect]>)
  ("allows read-only %s tools", async (name, effect) => {
    const outcome = await runScenario({ policy: "read-only", fixture: { name, effect, readOnly: true } });

    expect(outcome.advertised[0]).toEqual([name]);
    expect(outcome.result).toMatchObject({ ok: true, value: { response: "done" } });
    expect(outcome.invocations).toBe(1);
  });

  it.each([
    ["deny", undefined],
    ["allow", "deny"]
  ] as const)("keeps configured %s and effective %s permissions as final denials", async (configuredPermission, effectivePermission) => {
    const outcome = await runScenario({
      policy: "read-only",
      fixture: { name: "read_file", effect: "read", readOnly: true },
      configuredPermission,
      effectivePermission
    });

    expect(outcome.advertised[0]).toEqual([]);
    expect(outcome.result).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    expect(outcome.invocations).toBe(0);
  });

  it("defaults an omitted manual policy to standard without inferring from display name", async () => {
    const outcome = await runScenario({
      displayName: "JBP Plan Builder",
      fixture: { name: "manual_mutation", effect: "mutation", readOnly: false }
    });

    expect(outcome.advertised[0]).toEqual(["manual_mutation"]);
    expect(outcome.result.ok).toBe(true);
    expect(outcome.invocations).toBe(1);
  });

  it("rechecks the resolved object during batch admission", async () => {
    const workspace = await tempWorkspace();
    const mutation: Tool = {
      ...readFileTool,
      name: "mcp__context7__mutate",
      effect: "mutation",
      readOnly: true
    };
    const agent: Agent = {
      name: "manual",
      toolPolicy: "read-only",
      config: workspace.config.agents.default,
      model: { name: "unused", async complete() { return { message: "", toolCalls: [] }; } }
    };

    const admitted = admitToolBatch(
      [{ callId: "direct-admission", name: mutation.name, input: {} }],
      { agent, invocation: workspace.context, toolsByName: new Map([[mutation.name, mutation]]) }
    );

    expect(admitted).toMatchObject({
      ok: false,
      error: {
        code: "PERMISSION_DENIED",
        message: "Tool 'mcp__context7__mutate' is denied by read-only agent policy"
      }
    });
  });
});
