import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach } from "vitest";
import { AgentRunner } from "../src/agents/runner";
import { computerUseRequested, withComputerUseEnabled } from "../src/tools/computer-use-policy";
import { createRuntimeToolRegistry } from "../src/mcp/runtime-registry";
import type { ModelRequest } from "../src/models/provider";
import {
  continuationAgent,
  continuationTool,
  createContinuationHarness,
  scriptedProvider
} from "./runner-continuation-fixtures";
import { tempWorkspace } from "./helpers";

const COMPUTER_TOOL = "mcp__open_computer_use__click";
const ALIASED_COMPUTER_SERVER = "desktop_control";
const INCIDENT_PROMPT = [
  "Alright I want you to download these 2 songs as a mp3 file inside the Singles in the Molly Santana Folder.",
  "",
  "You need to use YT-DLP and make sure that the title and the thumbnails are correct.",
  "",
  "",
  "https://www.youtube.com/watch?v=crjLz21XlxI",
  "https://www.youtube.com/watch?v=6Wt1GsrOkbk"
].join("\n");
const ORDINARY_PROMPT = "Inspect this repository";
const EXPLICIT_PROMPT = "Please use my computer to open Calculator";
const SLASH_REWRITTEN_PROMPT = "Use the computer to open Calculator";
const roots = new Set<string>();
const activeRoots = new Set<string>();

async function trackedContinuationHarness(toolNames: readonly string[]): Promise<Awaited<ReturnType<typeof createContinuationHarness>>> {
  const harness = await createContinuationHarness(toolNames);
  roots.add(harness.context.workspaceRoot);
  activeRoots.add(harness.context.workspaceRoot);
  return harness;
}

async function trackedWorkspace(): Promise<Awaited<ReturnType<typeof tempWorkspace>>> {
  const workspace = await tempWorkspace();
  roots.add(workspace.root);
  activeRoots.add(workspace.root);
  return workspace;
}

afterEach(async () => {
  await Promise.all([...activeRoots].map(root => rm(root, { recursive: true, force: true })));
  activeRoots.clear();
});

afterAll(async () => {
  await Promise.all([...roots].map(root => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("computer-use gating", () => {
  it.each([
    [ORDINARY_PROMPT, false],
    [INCIDENT_PROMPT, false],
    ["Explain how computer use works without using it", false],
    ["Can you explain how to use my computer?", false],
    ["The documentation says to use my computer for this workflow", false],
    ["Please use my computer science notes to answer this", false],
    ["Computer use: explain the security model without using it", false],
    ["Do not use my computer", false],
    [EXPLICIT_PROMPT, true],
    ["Can you control the desktop and click the Settings icon?", true],
    ["/computer use open Calculator", true]
  ] as const)("classifies explicit user intent for %s", (prompt, expected) => {
    // Given / When / Then
    expect(computerUseRequested(prompt)).toBe(expected);
  });

  it("exposes computer tools only on explicitly activated turns", async () => {
    // Given
    const harness = await trackedContinuationHarness(["helper", COMPUTER_TOOL]);
    harness.registry.register(continuationTool("helper", "HELPER_OK", []));
    harness.registry.register(continuationTool(COMPUTER_TOOL, "CLICK_OK", []));
    const requests: ModelRequest[] = [];
    const prompts = [
      "Inspect this repository",
      "Please use my computer to open Calculator",
      "/computer use open Calculator"
    ] as const;
    const model = scriptedProvider(prompts.map(() => ({ message: "Done", toolCalls: [] })), requests);
    const runner = new AgentRunner(harness.context, harness.sessions, harness.registry);
    const agent = continuationAgent(harness.config, model);

    // When
    for (const [index, prompt] of prompts.entries()) {
      const result = await runner.run(agent, prompt, `computer-visibility-${index}`);
      if (!result.ok) throw result.error;
    }

    // Then
    expect(requests.map(request => request.tools)).toEqual([
      ["helper"],
      ["helper", COMPUTER_TOOL],
      ["helper", COMPUTER_TOOL]
    ]);
  });

  it("limits explicit and slash-rewritten authority to their own turns on one runner", async () => {
    // Given
    const harness = await trackedContinuationHarness(["helper", COMPUTER_TOOL]);
    harness.registry.register(continuationTool("helper", "HELPER_OK", []));
    harness.registry.register(continuationTool(COMPUTER_TOOL, "CLICK_OK", []));
    const requests: ModelRequest[] = [];
    const prompts = [EXPLICIT_PROMPT, ORDINARY_PROMPT, SLASH_REWRITTEN_PROMPT, ORDINARY_PROMPT] as const;
    const model = scriptedProvider(prompts.map(() => ({ message: "Done", toolCalls: [] })), requests);
    const runner = new AgentRunner(harness.context, harness.sessions, harness.registry);
    const agent = continuationAgent(harness.config, model);

    // When
    for (const prompt of prompts) {
      const result = await runner.run(agent, prompt, "computer-one-turn-sequence");
      if (!result.ok) throw result.error;
    }

    // Then
    expect(requests.map(request => request.prompt)).toEqual(prompts);
    expect(requests.map(request => request.tools)).toEqual([
      ["helper", COMPUTER_TOOL],
      ["helper"],
      ["helper", COMPUTER_TOOL],
      ["helper"]
    ]);
  });

  it.each([
    { label: "ordinary primary", runtimeRole: "primary" as const, prompt: INCIDENT_PROMPT },
    { label: "child", runtimeRole: "child" as const, prompt: EXPLICIT_PROMPT },
    { label: "task-associated primary", runtimeRole: "primary" as const, taskId: "primary-task", prompt: EXPLICIT_PROMPT },
    { label: "delegated child task", runtimeRole: "child" as const, taskId: "delegated-task", prompt: EXPLICIT_PROMPT }
  ])("clears inherited computer use for $label runs before a manager-backed tool can execute", async ({ label, runtimeRole, taskId, prompt }) => {
    // Given
    const harness = await trackedContinuationHarness([COMPUTER_TOOL]);
    const managerConnectionAttempts: string[] = [];
    harness.registry.register(continuationTool(COMPUTER_TOOL, "CLICK_OK", managerConnectionAttempts));
    const requests: ModelRequest[] = [];
    const model = scriptedProvider([
      {
        message: "",
        toolCalls: [{ callId: `inherited-${label}`, name: COMPUTER_TOOL, input: {} }]
      },
      { message: "Unexpected second model step", toolCalls: [] }
    ], requests);
    const runner = new AgentRunner(
      {
        ...withComputerUseEnabled(harness.context),
        ...(taskId === undefined ? {} : { taskId }),
        effectivePermissions: { [COMPUTER_TOOL]: "allow" }
      },
      harness.sessions,
      harness.registry
    );
    const agent = {
      ...continuationAgent(harness.config, model),
      runtimeRole
    };
    const sessionId = `inherited-computer-${label.replaceAll(" ", "-")}`;

    // When
    const result = await runner.run(agent, prompt, sessionId);

    // Then
    expect(result).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.prompt).toBe(prompt);
    expect(requests[0]?.tools).toEqual([]);
    expect(managerConnectionAttempts).toEqual([]);
    const stored = await harness.sessions.readOrEmpty(sessionId);
    if (!stored.ok) throw stored.error;
    expect(stored.value.events.flatMap(event => (
      event.type === "message" && event.role === "user" ? [event.content] : []
    ))).toEqual([prompt]);
  });

  it("rejects a hallucinated computer-tool call on an ordinary turn", async () => {
    // Given
    const harness = await trackedContinuationHarness([COMPUTER_TOOL]);
    const executions: string[] = [];
    harness.registry.register(continuationTool(COMPUTER_TOOL, "CLICK_OK", executions));
    const model = scriptedProvider([{
      message: "",
      toolCalls: [{ callId: "unexpected-computer", name: COMPUTER_TOOL, input: {} }]
    }], []);
    const runner = new AgentRunner(harness.context, harness.sessions, harness.registry);

    // When
    const result = await runner.run(continuationAgent(harness.config, model), "Inspect this repository", "computer-denied");

    // Then
    expect(result).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    expect(executions).toEqual([]);
  });

  it("does not let delegated task text authorize computer use", async () => {
    // Given
    const harness = await trackedContinuationHarness(["helper", COMPUTER_TOOL]);
    harness.registry.register(continuationTool("helper", "HELPER_OK", []));
    harness.registry.register(continuationTool(COMPUTER_TOOL, "CLICK_OK", []));
    const requests: ModelRequest[] = [];
    const model = scriptedProvider([{ message: "Done", toolCalls: [] }], requests);
    const runner = new AgentRunner(
      {
        ...harness.context,
        taskId: "delegated-computer-request",
        effectivePermissions: { helper: "allow", [COMPUTER_TOOL]: "allow" }
      },
      harness.sessions,
      harness.registry
    );
    const agent = {
      ...continuationAgent(harness.config, model),
      runtimeRole: "child" as const
    };

    // When
    const result = await runner.run(agent, "Please use my computer to open Calculator", "delegated-computer");

    // Then
    if (!result.ok) throw result.error;
    expect(requests[0]?.tools).toEqual(["helper"]);
  });

  it("denies generic MCP discovery and calls until the turn enables computer use", async () => {
    // Given
    const workspace = await trackedWorkspace();
    const home = await mkdtemp(path.join(tmpdir(), "strongcode-computer-gateway-"));
    const fixture = path.join(process.cwd(), "tests", "fixtures", "mcp-echo.cjs");
    workspace.config.permissions.tools.mcp_list_tools = "allow";
    workspace.config.permissions.tools.mcp_call = "allow";
    workspace.config.permissions.tools["mcp__desktop_control__*"] = "allow";
    await writeFile(path.join(home, "mcp.json"), JSON.stringify({
      version: 1,
      defaults: {
        autoStart: false,
        timeout: { startupMs: 5000, requestMs: 5000 },
        environment: { inherit: false, allowlist: ["PATH", "HOME", "USERPROFILE", "TEMP", "TMP"] }
      },
      mcpServers: {
        [ALIASED_COMPUTER_SERVER]: {
          enabled: true,
          autoStart: true,
          type: "local",
          readOnly: false,
          command: [process.execPath, fixture, "open-computer-use@0.2.0"]
        }
      },
      webSearch: {
        providers: [{ server: ALIASED_COMPUTER_SERVER, tool: "search", queryParameter: "query", enabled: true }]
      }
    }), "utf8");
    const context = { ...workspace.context, configPath: path.join(home, "strongcode.config.yaml") };
    const registry = await createRuntimeToolRegistry(context);

    try {
      const listTools = registry.get("mcp_list_tools");
      const call = registry.get("mcp_call");
      const search = registry.get("web_search");
      if (!listTools || !call || !search) throw new Error("MCP gateway tools were not registered");
      expect(registry.get("mcp__desktop_control__echo")).toBeUndefined();

      // When
      const deniedList = await listTools.execute({ server: ALIASED_COMPUTER_SERVER }, context);
      const deniedCall = await call.execute({ server: ALIASED_COMPUTER_SERVER, tool: "echo", arguments: { value: "blocked" } }, context);
      const deniedSearch = await search.execute({ query: "blocked" }, context);
      const enabledContext = withComputerUseEnabled(context);
      const allowedList = await listTools.execute({ server: ALIASED_COMPUTER_SERVER }, enabledContext);
      const allowedCall = await call.execute({ server: ALIASED_COMPUTER_SERVER, tool: "echo", arguments: { value: "allowed" } }, enabledContext);
      const allowedSearch = await search.execute({ query: "allowed" }, enabledContext);

      // Then
      expect(deniedList).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
      expect(deniedCall).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
      expect(deniedSearch).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
      expect(allowedList).toMatchObject({ ok: true });
      expect(allowedCall).toMatchObject({ ok: true, value: { content: "allowed" } });
      expect(allowedSearch).toMatchObject({ ok: true, value: { content: expect.stringContaining("result:allowed") } });
    } finally {
      try {
        await registry.close();
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }
  });
});
