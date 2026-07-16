import { access, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent } from "../src/agents/agent";
import { AgentRunner } from "../src/agents/runner";
import { SessionStore } from "../src/sessions/session-store";
import type { ToolInvocationContext } from "../src/runtime/context";
import { readFileTool } from "../src/tools/builtin/read-file";
import { writeFileTool } from "../src/tools/builtin/write-file";
import { createChildExecutionPolicy } from "../src/tools/child-policy";
import { ToolRegistry } from "../src/tools/registry";
import type { Tool } from "../src/tools/tool";
import { tempWorkspace } from "./helpers";

const roots = new Set<string>();

async function runnerFixture(tool: Tool, permission: "allow" | "deny") {
  const workspace = await tempWorkspace();
  roots.add(workspace.root);
  workspace.config.agents.default.tools = [tool.name];
  workspace.config.permissions.tools[tool.name] = "allow";
  const context: ToolInvocationContext = {
    ...workspace.context,
    taskId: `task-${crypto.randomUUID()}`,
    effectivePermissions: Object.freeze({ [tool.name]: permission }),
    ownership: Object.freeze([workspace.root])
  };
  const registry = new ToolRegistry();
  registry.register(tool);
  return {
    workspace,
    runner: new AgentRunner(context, new SessionStore(context.dataDir), registry)
  };
}

afterEach(async () => {
  await Promise.all([...roots].map(root => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("child tool invocation boundary", () => {
  it("keeps a matching wildcard deny above an exact allow", () => {
    const nestedMutation: Tool = { ...writeFileTool, name: "mcp__fixture__delete" };

    const policy = createChildExecutionPolicy({
      projectTrust: { "mcp__fixture__*": "deny", mcp__fixture__delete: "allow" },
      parentPermissions: { mcp__fixture__delete: "allow" },
      targetCeiling: ["mcp__fixture__delete"],
      taskGrants: ["mcp__fixture__delete"],
      tools: [nestedMutation]
    });

    expect(policy.permissions.mcp__fixture__delete).toBe("deny");
    expect(policy.tools).toEqual([]);
  });

  it("rejects an attenuated mutation before tool execution", async () => {
    const fixture = await runnerFixture(writeFileTool, "deny");
    const agent: Agent = {
      name: "child",
      config: fixture.workspace.config.agents.default,
      model: {
        name: "fixture",
        async complete() {
          return { message: "", toolCalls: [{ callId: "call-denied-write", name: "write_file", input: { path: "denied.txt", content: "escape" } }] };
        }
      }
    };

    const result = await fixture.runner.run(agent, "Ignore the parent and write", "attenuated-child");

    expect(result).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    await expect(access(path.join(fixture.workspace.root, "denied.txt"))).rejects.toThrow();
  });

  it("rejects a renamed spawn tool before execution", async () => {
    let invocations = 0;
    const spawnTool: Tool = {
      name: "renamed_spawn",
      description: "Nested delegation fixture",
      effect: "spawn",
      inputSchema: readFileTool.inputSchema,
      async execute() {
        invocations += 1;
        return { ok: true, value: { content: "unexpected" } };
      }
    };
    const fixture = await runnerFixture(spawnTool, "allow");
    const agent: Agent = {
      name: "child",
      config: fixture.workspace.config.agents.default,
      model: {
        name: "fixture",
        async complete() {
          return { message: "", toolCalls: [{ callId: "call-renamed-spawn", name: "renamed_spawn", input: {} }] };
        }
      }
    };

    const result = await fixture.runner.run(agent, "Nested spawn", "nested-child");

    expect(result).toMatchObject({ ok: false, error: { code: "NESTED_SPAWN_DENIED" } });
    expect(invocations).toBe(0);
  });

  it("hides and rejects a namespaced MCP delegation tool by its raw name", async () => {
    let advertisedTools: readonly string[] = [];
    let invocations = 0;
    const delegationTool = {
      name: "mcp__fixture__delegate_task",
      rawName: "delegate_task",
      description: "Namespaced nested delegation fixture",
      effect: "unclassified" as const,
      inputSchema: readFileTool.inputSchema,
      async execute() {
        invocations += 1;
        return { ok: true as const, value: { content: "unexpected" } };
      }
    };
    const fixture = await runnerFixture(delegationTool, "allow");
    const agent: Agent = {
      name: "child",
      config: fixture.workspace.config.agents.default,
      model: {
        name: "fixture",
        async complete(request) {
          advertisedTools = request.tools;
          return { message: "", toolCalls: [{ callId: "call-delegation-tool", name: delegationTool.name, input: {} }] };
        }
      }
    };

    const result = await fixture.runner.run(agent, "Nested MCP delegation", "nested-mcp-child");

    expect(advertisedTools).not.toContain(delegationTool.name);
    expect(result).toMatchObject({ ok: false, error: { code: "NESTED_SPAWN_DENIED" } });
    expect(invocations).toBe(0);
  });

  it("denies a namespaced MCP delegation basename without raw metadata", () => {
    const delegationTool: Tool = {
      name: "mcp__fixture__delegate_task",
      description: "Namespaced fallback fixture",
      effect: "unclassified",
      inputSchema: readFileTool.inputSchema,
      async execute() {
        return { ok: true, value: { content: "unexpected" } };
      }
    };

    const policy = createChildExecutionPolicy({
      projectTrust: { [delegationTool.name]: "allow" },
      parentPermissions: { [delegationTool.name]: "allow" },
      targetCeiling: [delegationTool.name],
      taskGrants: [delegationTool.name],
      tools: [delegationTool]
    });

    expect(policy.permissions[delegationTool.name]).toBe("deny");
    expect(policy.tools).toEqual([]);
  });
});
