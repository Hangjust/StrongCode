import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, vi } from "vitest";
import { AgentRunner } from "../src/agents/runner";
import { StrongCodeError } from "../src/core/errors";
import { McpManager } from "../src/mcp/client";
import { computerUseRequested, withComputerUseEnabled } from "../src/tools/computer-use-policy";
import { createRuntimeToolRegistry, type RuntimeToolRegistryOptions } from "../src/mcp/runtime-registry";
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
const SAFE_SERVER_IDS = ["safe_alpha", "safe_zeta"] as const;
const EXPLICIT_SERVER_IDS = ["desktop_control", "open_computer_use", ...SAFE_SERVER_IDS] as const;
const CONCURRENT_VIEW_REPETITIONS = 12;
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

function observedManagerFactory(activity: string[]): NonNullable<RuntimeToolRegistryOptions["managerFactory"]> {
  return (context, config) => {
    const manager = new McpManager(context, config);
    const listTools = manager.listTools.bind(manager);
    const callTool = manager.callTool.bind(manager);
    vi.spyOn(manager, "listTools").mockImplementation(async (serverId, invocationContext) => {
      activity.push(`discovery:${serverId}`);
      return listTools(serverId, invocationContext);
    });
    vi.spyOn(manager, "callTool").mockImplementation(async (serverId, toolName, args, invocationContext) => {
      activity.push(`invocation:${serverId}:${toolName}`);
      return callTool(serverId, toolName, args, invocationContext);
    });
    vi.spyOn(manager, "connect").mockImplementation(async serverId => {
      activity.push(`connection:${serverId}`);
      throw new StrongCodeError("PERMISSION_DENIED", "Low-level Computer Use guard reached");
    });
    return manager;
  };
}

async function trackedGatewayHarness(mcpServers: Readonly<Record<string, unknown>>) {
  const harness = await trackedContinuationHarness([
    "mcp_call",
    "mcp_list_tools",
    "mcp__safe_alpha__*",
    "mcp__safe_server__*",
    "mcp__safe_zeta__*",
    "mcp__open_computer_use__*",
    "mcp__desktop_control__*"
  ]);
  await writeFile(path.join(harness.context.workspaceRoot, "mcp.json"), JSON.stringify({
    version: 1,
    defaults: {
      autoStart: false,
      timeout: { startupMs: 5000, requestMs: 5000 },
      environment: { inherit: false, allowlist: [] }
    },
    mcpServers
  }), "utf8");
  const managerActivity: string[] = [];
  const registry = await createRuntimeToolRegistry(harness.context, {
    managerFactory: observedManagerFactory(managerActivity)
  });
  return { ...harness, registry, managerActivity };
}

function expectSynchronizedToolMetadata(requests: readonly ModelRequest[]): void {
  for (const request of requests) {
    expect(request.tools).toEqual(request.toolDefinitions?.map(definition => definition.name));
  }
}

function expectGatewayServerView(request: ModelRequest | undefined, serverIds: readonly string[]): void {
  expect(request?.tools).toEqual(["mcp_call", "mcp_list_tools"]);
  for (const definition of request?.toolDefinitions ?? []) {
    expect(definition.description).toContain(serverIds.join(", "));
    expect(definition.inputSchema).toMatchObject({
      properties: { server: { enum: serverIds } }
    });
  }
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
    expectSynchronizedToolMetadata(requests);
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
    expectSynchronizedToolMetadata(requests);
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
    expectSynchronizedToolMetadata(requests);
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
    const requests: ModelRequest[] = [];
    const model = scriptedProvider([
      {
        message: "",
        toolCalls: [{ callId: "unexpected-computer", name: COMPUTER_TOOL, input: {} }]
      },
      { message: "must not run", toolCalls: [] }
    ], requests);
    const runner = new AgentRunner(harness.context, harness.sessions, harness.registry);

    // When
    const result = await runner.run(continuationAgent(harness.config, model), "Inspect this repository", "computer-denied");

    // Then
    expect(result).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    expect(executions).toEqual([]);
    expect(requests).toHaveLength(1);
    expectSynchronizedToolMetadata(requests);
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
    expectSynchronizedToolMetadata(requests);
  });

  it("projects generic MCP metadata from the ordered servers visible in each turn", async () => {
    // Given
    const harness = await trackedGatewayHarness({
      safe_zeta: { enabled: true, autoStart: false, type: "local", command: ["safe-zeta-must-not-run"] },
      open_computer_use: { enabled: true, autoStart: true, type: "local", command: ["canonical-must-not-run"] },
      desktop_control: { enabled: true, autoStart: true, type: "local", command: ["npx", "open-computer-use@0.2.0", "mcp"] },
      safe_alpha: { enabled: true, autoStart: false, type: "local", command: ["safe-alpha-must-not-run"] }
    });
    const requests: ModelRequest[] = [];
    const model = scriptedProvider([
      { message: "Ordinary complete", toolCalls: [] },
      { message: "Explicit complete", toolCalls: [] },
      { message: "Delegated complete", toolCalls: [] }
    ], requests);
    const runner = new AgentRunner(harness.context, harness.sessions, harness.registry);
    const agent = continuationAgent(harness.config, model);
    const delegatedRunner = new AgentRunner(
      {
        ...harness.context,
        taskId: "delegated-gateway-metadata",
        effectivePermissions: { ...harness.context.config.permissions.tools }
      },
      harness.sessions,
      harness.registry
    );
    const delegatedAgent = { ...agent, runtimeRole: "child" as const };

    try {
      // When
      const ordinary = await runner.run(agent, INCIDENT_PROMPT, "gateway-metadata-ordinary");
      const explicit = await runner.run(agent, EXPLICIT_PROMPT, "gateway-metadata-explicit");
      const delegated = await delegatedRunner.run(
        delegatedAgent,
        EXPLICIT_PROMPT,
        "gateway-metadata-delegated"
      );

      // Then
      expect(ordinary).toMatchObject({ ok: true });
      expect(explicit).toMatchObject({ ok: true });
      expect(delegated).toMatchObject({ ok: true });
      expect(requests).toHaveLength(3);
      expectSynchronizedToolMetadata(requests);
      const ordinaryMetadata = JSON.stringify({
        tools: requests[0]?.tools,
        toolDefinitions: requests[0]?.toolDefinitions
      });
      expect(ordinaryMetadata).not.toContain("open_computer_use");
      expect(ordinaryMetadata).not.toContain("desktop_control");
      expectGatewayServerView(requests[0], SAFE_SERVER_IDS);
      const explicitMetadata = JSON.stringify({
        tools: requests[1]?.tools,
        toolDefinitions: requests[1]?.toolDefinitions
      });
      expect(explicitMetadata).toContain("open_computer_use");
      expect(explicitMetadata).toContain("desktop_control");
      expectGatewayServerView(requests[1], EXPLICIT_SERVER_IDS);
      const delegatedMetadata = JSON.stringify({
        tools: requests[2]?.tools,
        toolDefinitions: requests[2]?.toolDefinitions
      });
      expect(delegatedMetadata).not.toContain("open_computer_use");
      expect(delegatedMetadata).not.toContain("desktop_control");
      expectGatewayServerView(requests[2], SAFE_SERVER_IDS);
      expect(harness.managerActivity).toEqual([]);
    } finally {
      await harness.registry.close();
    }
  });

  it("isolates concurrent ordinary and explicit generic MCP views on one registry", async () => {
    // Given
    const harness = await trackedGatewayHarness({
      safe_zeta: { enabled: true, autoStart: false, type: "local", command: ["safe-zeta-must-not-run"] },
      open_computer_use: { enabled: true, autoStart: true, type: "local", command: ["canonical-must-not-run"] },
      desktop_control: { enabled: true, autoStart: true, type: "local", command: ["npx", "open-computer-use@0.2.0", "mcp"] },
      safe_alpha: { enabled: true, autoStart: false, type: "local", command: ["safe-alpha-must-not-run"] }
    });
    const ordinaryRequests: ModelRequest[] = [];
    const explicitRequests: ModelRequest[] = [];
    const ordinaryModel = scriptedProvider(
      Array.from({ length: CONCURRENT_VIEW_REPETITIONS }, () => ({ message: "Ordinary complete", toolCalls: [] })),
      ordinaryRequests
    );
    const explicitModel = scriptedProvider(
      Array.from({ length: CONCURRENT_VIEW_REPETITIONS }, () => ({ message: "Explicit complete", toolCalls: [] })),
      explicitRequests
    );
    const ordinaryRunner = new AgentRunner(harness.context, harness.sessions, harness.registry);
    const explicitRunner = new AgentRunner(harness.context, harness.sessions, harness.registry);

    try {
      // When
      const results = await Promise.all(Array.from(
        { length: CONCURRENT_VIEW_REPETITIONS },
        (_, index) => Promise.all([
          ordinaryRunner.run(
            continuationAgent(harness.config, ordinaryModel),
            ORDINARY_PROMPT,
            `gateway-concurrent-ordinary-${index}`
          ),
          explicitRunner.run(
            continuationAgent(harness.config, explicitModel),
            EXPLICIT_PROMPT,
            `gateway-concurrent-explicit-${index}`
          )
        ])
      ));

      // Then
      expect(results.flat().every(result => result.ok)).toBe(true);
      expect(ordinaryRequests).toHaveLength(CONCURRENT_VIEW_REPETITIONS);
      expect(explicitRequests).toHaveLength(CONCURRENT_VIEW_REPETITIONS);
      expectSynchronizedToolMetadata([...ordinaryRequests, ...explicitRequests]);
      for (const request of ordinaryRequests) {
        expect(JSON.stringify(request.toolDefinitions)).not.toContain("open_computer_use");
        expect(JSON.stringify(request.toolDefinitions)).not.toContain("desktop_control");
        expectGatewayServerView(request, SAFE_SERVER_IDS);
      }
      for (const request of explicitRequests) {
        expectGatewayServerView(request, EXPLICIT_SERVER_IDS);
      }
      expect(harness.managerActivity).toEqual([]);
    } finally {
      await harness.registry.close();
    }
  });

  it("keeps a hidden OCU hallucination terminal and replays the same session on the next user turn", async () => {
    // Given
    const harness = await trackedGatewayHarness({
      desktop_control: {
        enabled: true,
        autoStart: true,
        type: "local",
        command: ["npx", "open-computer-use@0.2.0", "mcp"]
      }
    });
    const requests: ModelRequest[] = [];
    const model = scriptedProvider([
      {
        message: "",
        toolCalls: [{
          callId: "hidden-ocu-call",
          name: "mcp_call",
          input: {
            server: "desktop_control",
            tool: "run_command",
            arguments: { command: "must not run" }
          }
        }]
      },
      { message: "Recovered without computer use", toolCalls: [] }
    ], requests);
    const runner = new AgentRunner(harness.context, harness.sessions, harness.registry);
    const agent = continuationAgent(harness.config, model);
    const sessionId = "hidden-ocu-retry";
    const retryPrompt = "Continue without using the computer";

    try {
      // When
      const denied = await runner.run(agent, INCIDENT_PROMPT, sessionId);
      const afterDenied = await harness.sessions.read(sessionId);
      if (!afterDenied.ok) throw afterDenied.error;
      const retry = await runner.run(agent, retryPrompt, sessionId);

      // Then
      expect(denied).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
      expect(afterDenied.value.events.flatMap(event => (
        event.type === "message" ? [{ role: event.role, content: event.content }] : []
      ))).toEqual([{ role: "user", content: INCIDENT_PROMPT }]);
      expect(afterDenied.value.events.filter(event => event.type === "conversation_item")).toEqual([]);
      expect(retry).toMatchObject({
        ok: true,
        value: { response: "Recovered without computer use", toolExecutions: [] }
      });
      expect(requests).toHaveLength(2);
      expectSynchronizedToolMetadata(requests);
      for (const request of requests) {
        expect(request.tools).toEqual([]);
        expect(request.toolDefinitions).toEqual([]);
      }
      expect(requests[1]?.prompt).toBe(retryPrompt);
      expect(requests[1]?.messages.filter(message => message.role === "user")).toEqual([
        { role: "user", content: INCIDENT_PROMPT },
        { role: "user", content: retryPrompt }
      ]);
      expect(harness.managerActivity).toEqual([]);
      const stored = await harness.sessions.read(sessionId);
      if (!stored.ok) throw stored.error;
      expect(stored.value.events.flatMap(event => (
        event.type === "message" ? [{ role: event.role, content: event.content }] : []
      ))).toEqual([
        { role: "user", content: INCIDENT_PROMPT },
        { role: "user", content: retryPrompt },
        { role: "assistant", content: "Recovered without computer use" }
      ]);
      expect(stored.value.events.filter(event => event.type === "conversation_item")).toEqual([]);
    } finally {
      await harness.registry.close();
    }
  });

  it("keeps an explicit alias namespace denial terminal without connecting", async () => {
    // Given
    const harness = await trackedGatewayHarness({
      desktop_control: {
        enabled: true,
        autoStart: true,
        type: "local",
        command: ["npx", "open-computer-use@0.2.0", "mcp"]
      }
    });
    harness.context.config.permissions.tools.mcp__desktop_control__run_command = "deny";
    const requests: ModelRequest[] = [];
    const model = scriptedProvider([{
      message: "",
      toolCalls: [{
        callId: "explicit-alias-denial",
        name: "mcp_call",
        input: { server: "desktop_control", tool: "run_command", arguments: {} }
      }]
    }], requests);
    const runner = new AgentRunner(harness.context, harness.sessions, harness.registry);

    try {
      // When
      const result = await runner.run(
        continuationAgent(harness.config, model),
        EXPLICIT_PROMPT,
        "explicit-alias-denial"
      );

      // Then
      expect(result).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
      expect(requests).toHaveLength(1);
      expectSynchronizedToolMetadata(requests);
      expect(JSON.stringify(requests[0]?.toolDefinitions)).toContain("desktop_control");
      expect(harness.managerActivity).toEqual([]);
    } finally {
      await harness.registry.close();
    }
  });

  it("denies generic MCP discovery and calls until the turn enables computer use", async () => {
    // Given
    const workspace = await trackedWorkspace();
    const home = await mkdtemp(path.join(tmpdir(), "strongcode-computer-gateway-"));
    const fixture = path.join(process.cwd(), "tests", "fixtures", "mcp-echo.cjs");
    workspace.config.permissions.tools.mcp_list_tools = "allow";
    workspace.config.permissions.tools.mcp_call = "allow";
    workspace.config.permissions.tools["mcp__safe_server__*"] = "allow";
    workspace.config.permissions.tools["mcp__desktop_control__*"] = "allow";
    await writeFile(path.join(home, "mcp.json"), JSON.stringify({
      version: 1,
      defaults: {
        autoStart: false,
        timeout: { startupMs: 5000, requestMs: 5000 },
        environment: { inherit: false, allowlist: ["PATH", "HOME", "USERPROFILE", "TEMP", "TMP"] }
      },
      mcpServers: {
        safe_server: {
          enabled: true,
          autoStart: false,
          type: "local",
          readOnly: true,
          command: [process.execPath, fixture]
        },
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
      const safeList = await listTools.execute({ server: "safe_server" }, context);
      const safeCall = await call.execute({ server: "safe_server", tool: "echo", arguments: { value: "safe" } }, context);
      const deniedList = await listTools.execute({ server: ALIASED_COMPUTER_SERVER }, context);
      const deniedCall = await call.execute({ server: ALIASED_COMPUTER_SERVER, tool: "echo", arguments: { value: "blocked" } }, context);
      const deniedSearch = await search.execute({ query: "blocked" }, context);
      const enabledContext = withComputerUseEnabled(context);
      const allowedList = await listTools.execute({ server: ALIASED_COMPUTER_SERVER }, enabledContext);
      const allowedCall = await call.execute({ server: ALIASED_COMPUTER_SERVER, tool: "echo", arguments: { value: "allowed" } }, enabledContext);
      const allowedSearch = await search.execute({ query: "allowed" }, enabledContext);

      // Then
      expect(safeList).toMatchObject({ ok: true });
      expect(safeCall).toMatchObject({ ok: true, value: { content: "safe" } });
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
