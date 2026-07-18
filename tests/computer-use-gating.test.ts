import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

describe("computer-use gating", () => {
  it.each([
    ["Inspect this repository", false],
    ["Explain how computer use works without using it", false],
    ["Can you explain how to use my computer?", false],
    ["The documentation says to use my computer for this workflow", false],
    ["Please use my computer science notes to answer this", false],
    ["Computer use: explain the security model without using it", false],
    ["Do not use my computer", false],
    ["Please use my computer to open Calculator", true],
    ["Can you control the desktop and click the Settings icon?", true],
    ["/computer use open Calculator", true]
  ] as const)("classifies explicit user intent for %s", (prompt, expected) => {
    // Given / When / Then
    expect(computerUseRequested(prompt)).toBe(expected);
  });

  it("exposes computer tools only on explicitly activated turns", async () => {
    // Given
    const harness = await createContinuationHarness(["helper", COMPUTER_TOOL]);
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

  it("rejects a hallucinated computer-tool call on an ordinary turn", async () => {
    // Given
    const harness = await createContinuationHarness([COMPUTER_TOOL]);
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
    const harness = await createContinuationHarness(["helper", COMPUTER_TOOL]);
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
    const workspace = await tempWorkspace();
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
      await registry.close();
    }
  });
});
