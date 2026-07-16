import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "../src/agents/agent";
import { strongCodeConfigSchema } from "../src/config/schema";
import { createRuntimeContext } from "../src/runtime/context";
import { SessionStore } from "../src/sessions/session-store";
import {
  projectInclusiveAccounting,
  projectSessionLedger
} from "../src/sessions/session-ledger-projection";
import { createDefaultToolRegistry } from "../src/tools/registry";
import {
  projectSessionTelemetry,
  summaryDetailLines
} from "../src/tui/ui/session-summary";
import { RuntimeAgentRunnerFactory } from "../src/runtime/runner-factory";
import { protocolCases } from "./fixtures/preflight-integration-protocols";
import {
  mixedDeniedFetcher,
  runtimeIntegrationHarness,
  twentyFiveChildFetcher
} from "./fixtures/preflight-integration-runtime";
import {
  scheduleInput,
  schedulerHarness,
  terminal
} from "./fixtures/preflight-scheduler-harness";
import { tempWorkspace } from "./helpers";

vi.mock("../src/models/gcloud-delegated", () => ({
  getGoogleAdcAccessToken: vi.fn(async () => "vertex-access-token")
}));

const execFileAsync = promisify(execFile);

describe("preflight adversarial integration matrix", () => {
  it("runs an arbitrary route through 25 tool-capable children, exact handoff, primary mutation, and reload", async () => {
    // Given
    const scripted = twentyFiveChildFetcher();
    const harness = await runtimeIntegrationHarness(scripted.fetcher);
    const original = "  Exact first request 東京\x1b[2J\r\nkeep bytes unchanged.  ";

    try {
      // When
      const first = await harness.runner.run(harness.primary, original, "integration-happy");
      const later = await harness.runner.run(harness.primary, "later request", "integration-happy");
      const reloaded = await new SessionStore(harness.dataDir).read("integration-happy");

      // Then
      if (!first.ok) throw first.error;
      if (!later.ok) throw later.error;
      if (!reloaded.ok) throw reloaded.error;
      expect(scripted.childPeak()).toBe(25);
      expect(scripted.childTools.length).toBeGreaterThanOrEqual(25);
      expect(harness.invocations.filter(value => value.startsWith("read_file:"))).toHaveLength(1);
      expect(harness.invocations.filter(value => value.startsWith("write_file:"))).toHaveLength(1);
      expect(harness.primary.model.name).toBe("tenant/arbitrary-summary-v9");
      expect(harness.primaryRequests[0]?.prompt).toBe(original);
      const projection = projectSessionLedger(reloaded.value.events);
      expect(projection.summary).toMatchObject({
        kind: "committed",
        result: { title: "Integrated title", requestedItems: ["First request", "Second request"] }
      });
      expect(Object.isFrozen(projection.summary)).toBe(true);
      const telemetry = projectSessionTelemetry(reloaded.value.events);
      expect(telemetry.summary?.originalPrompt).toBe(original);
      expect(summaryDetailLines(telemetry).join("\n")).not.toContain("\x1b");
    } finally {
      await harness.cleanup();
    }
  });

  it("fails open a mixed safe/denied batch before invocation and dispatches primary once", async () => {
    // Given
    const harness = await runtimeIntegrationHarness(mixedDeniedFetcher(), false);

    try {
      // When
      const result = await harness.runner.run(harness.primary, "mixed permissions", "integration-denied");
      const stored = await harness.sessions.read("integration-denied");

      // Then
      if (!result.ok) throw result.error;
      if (!stored.ok) throw stored.error;
      expect(harness.invocations).toEqual([]);
      expect(harness.primaryRequests).toHaveLength(1);
      expect(projectSessionLedger(stored.value.events).summary)
        .toMatchObject({ kind: "failed-open", reasonCode: "tool_permission_denied" });
    } finally {
      await harness.cleanup();
    }
  });

  it("projects OpenAI, ChatGPT, native, and direct attempts through durable de-duplicated accounting", async () => {
    // Given
    const cases = await protocolCases();

    for (const protocol of cases) {
      const harness = await schedulerHarness();
      try {
        harness.models.enqueue("summary", protocol.response);

        // When
        const settled = await terminal(await harness.scheduler.run(scheduleInput(harness)));
        const before = await harness.sessions.read("preflight-session");
        if (!settled.ok) throw settled.error;
        if (!before.ok) throw before.error;
        const usageEvent = before.value.events.find(event => event.type === "attempt_usage");
        if (usageEvent === undefined) throw new Error(`Missing ${protocol.name} usage event`);
        const replay = await harness.sessions.commitLedgerEvent("preflight-session", usageEvent);
        const reloaded = await new SessionStore(harness.context.dataDir).read("preflight-session");

        // Then
        if (!replay.ok) throw replay.error;
        if (!reloaded.ok) throw reloaded.error;
        expect(replay.value.kind, protocol.name).toBe("duplicate");
        const projection = projectSessionLedger(reloaded.value.events);
        const root = Array.from(projection.attempts.values()).find(attempt => attempt.created.parentAttemptId === undefined);
        if (root === undefined) throw new Error(`Missing ${protocol.name} root attempt`);
        const accounting = projectInclusiveAccounting(projection, root.attemptId);
        expect(accounting.tokens.inputTokens, protocol.name).toEqual({ known: protocol.inputTokens, complete: true });
        expect(accounting.tokens.outputTokens, protocol.name).toEqual({ known: protocol.outputTokens, complete: true });
        expect(accounting.tokens.totalTokens, protocol.name).toEqual(protocol.totalTokens === undefined
          ? { known: 0, complete: false }
          : { known: protocol.totalTokens, complete: true });
        if (protocol.costUsd !== undefined) {
          expect(accounting.inclusiveCost, protocol.name).toEqual({ amount: protocol.costUsd, currency: "USD" });
        }
        expect(reloaded.value.events.filter(event => event.type === "attempt_usage").length, protocol.name)
          .toBe(protocol.name === "direct-attempts" ? 2 : 1);
      } finally {
        await harness.scheduler.close();
        await harness.tools.close();
        await rm(harness.context.workspaceRoot, { recursive: true, force: true });
      }
    }
  });

  it("loads legacy JSONL and config while disabled preflight dispatches the original request once", async () => {
    // Given
    const workspace = await tempWorkspace();
    const legacyConfig = strongCodeConfigSchema.parse({
      version: 1,
      workspace: ".",
      dataDir: ".strongcode",
      defaultAgent: "default",
      providers: { mock: { type: "mock", displayName: "Mock", enabled: true } },
      agents: { default: { model: "mock", tools: [] } },
      models: { mock: { provider: "mock", model: "mock", enabled: true } },
      permissions: { tools: {} }
    });
    const context = createRuntimeContext(legacyConfig, workspace.configPath, workspace.root);
    const sessions = new SessionStore(context.dataDir);
    const sessionPath = sessions.pathFor("legacy-integration");
    if (!sessionPath.ok) throw sessionPath.error;
    await mkdir(path.dirname(sessionPath.value), { recursive: true });
    await writeFile(sessionPath.value, [
      JSON.stringify({
        type: "message",
        timestamp: "2026-07-16T00:00:00.000Z",
        role: "user",
        content: "legacy prompt"
      }),
      JSON.stringify({
        type: "tool",
        timestamp: "2026-07-16T00:00:01.000Z",
        tool: "read_file",
        input: {},
        output: "legacy output"
      })
    ].join("\n") + "\n", "utf8");
    const requests: string[] = [];
    const agent: Agent = {
      name: "default",
      config: legacyConfig.agents.default,
      model: {
        name: "mock",
        async complete(request) {
          requests.push(request.prompt);
          return { message: "legacy complete", toolCalls: [] };
        }
      }
    };
    const runner = new RuntimeAgentRunnerFactory(context).create({
      sessions,
      tools: createDefaultToolRegistry()
    });

    try {
      // When
      const legacy = await sessions.read("legacy-integration");
      const result = await runner.run(agent, "  original disabled bytes  ", "disabled-integration");

      // Then
      if (!legacy.ok) throw legacy.error;
      if (!result.ok) throw result.error;
      expect(legacy.value.events).toHaveLength(2);
      expect(projectSessionTelemetry(legacy.value.events).summary?.status).toBe("unavailable");
      expect(requests).toEqual(["  original disabled bytes  "]);
      expect(await readFile(sessionPath.value, "utf8")).toContain("legacy output");
    } finally {
      await runner.close();
      await rm(workspace.root, { recursive: true, force: true });
    }
  });

  it("drives wide and narrow OpenTUI Summary mouse, F2, Enter, Escape, and terminal safety", async () => {
    // Given
    const fixture = path.resolve(__dirname, "fixtures", "preflight-tui-interactions.ts");

    // When
    const [wide, narrow] = await Promise.all([
      execFileAsync("bun", [fixture, "110"], { cwd: path.resolve(__dirname, "..") }),
      execFileAsync("bun", [fixture, "109"], { cwd: path.resolve(__dirname, "..") })
    ]);
    const wideResult = JSON.parse(wide.stdout);
    const narrowResult = JSON.parse(narrow.stdout);

    // Then
    expect(wideResult).toMatchObject({
      width: 110,
      railVisible: true,
      mouseOpened: true,
      f2Opened: true,
      enterOpened: true,
      escapeRestored: true,
      unknownDidNotDispatch: true,
      storedPromptExact: true,
      visiblePromptParts: true,
      terminalControlVisible: false,
      railFound: true,
      railWidth: 32,
      railVisibleState: true
    });
    expect(narrowResult).toMatchObject({
      width: 109,
      railVisible: false,
      f2Opened: true,
      enterOpened: true,
      escapeRestored: true,
      unknownDidNotDispatch: true,
      storedPromptExact: true,
      visiblePromptParts: true,
      terminalControlVisible: false,
      railFound: true,
      railVisibleState: false
    });
  });
});
