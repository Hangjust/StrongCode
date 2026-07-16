import {
  ACTIVE_TURN_BUSY_MESSAGE,
  acquireTurnLease,
  compactActiveContext,
  type ContextCompactionRunner,
  createExclusiveOperationGate,
  createModelRefreshGate,
  releaseOperationAndSubmit,
  requireIdleTurn,
  snapshotTurnReceiptLabels
} from "../src/tui/app";
import type { Agent } from "../src/agents/agent";
import { StrongCodeError } from "../src/core/errors";
import { err, ok } from "../src/core/result";
import { MockModelProvider } from "../src/models/mock-provider";
import { parseSlashCommand, slashCommandAllowedDuringTurn } from "../src/tui/slash-command-registry";
import { testConfig } from "./helpers";
import { vi } from "vitest";

describe("TUI turn safety", () => {
  const activeAgent = (): Agent => ({
    name: "tesla",
    config: testConfig(process.cwd()).agents.default,
    model: new MockModelProvider()
  });

  it("compacts the active context once with concise system feedback", async () => {
    const messages: string[] = [];
    const agent = activeAgent();
    const compact = vi.fn(async () => ok({
      sessionId: "session-compact",
      summary: "Internal summary must not be shown.",
      retainedUserItemCount: 3
    }));
    const runner: ContextCompactionRunner = { compact };

    await compactActiveContext(runner, agent, "session-compact", (_role, text) => {
      messages.push(text);
    });

    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact).toHaveBeenCalledWith(agent, "session-compact");
    expect(messages).toEqual([
      "Compacting active context...",
      "Context compacted. Retained user items: 3."
    ]);
  });

  it("reports compact provider failures without exposing the summary", async () => {
    const messages: string[] = [];
    const runner: ContextCompactionRunner = {
      compact: async () => err(new StrongCodeError("MODEL_ERROR", "provider unavailable"))
    };

    await compactActiveContext(runner, activeAgent(), "session-compact", (_role, text) => {
      messages.push(text);
    });

    expect(messages).toEqual([
      "Compacting active context...",
      "Unable to compact context: provider unavailable"
    ]);
  });

  it("rejects unavailable compact runtime without invoking a normal turn", async () => {
    const messages: string[] = [];

    await compactActiveContext(undefined, activeAgent(), "session-compact", (_role, text) => {
      messages.push(text);
    });

    expect(messages).toEqual(["Unable to compact context: active runner, agent, or session is unavailable."]);
  });

  it("refuses a mutation while a turn is running with the shared message", () => {
    const messages: string[] = [];

    const allowed = requireIdleTurn(true, message => messages.push(message));

    expect(allowed).toBe(false);
    expect(messages).toEqual([ACTIVE_TURN_BUSY_MESSAGE]);
  });

  it("permits the same mutation seam while idle", () => {
    const messages: string[] = [];

    const allowed = requireIdleTurn(false, message => messages.push(message));

    expect(allowed).toBe(true);
    expect(messages).toEqual([]);
  });

  it("snapshots receipt labels before mutable state changes", () => {
    const state = {
      provider: "openai",
      model: "gpt-5",
      modelDisplayName: "GPT-5",
      defaultAgent: "Tesla",
      configPath: "strongcode.config.yaml",
      configMissing: false
    };

    const labels = snapshotTurnReceiptLabels(state);
    state.defaultAgent = "Newton";
    state.modelDisplayName = "Gemini";

    expect(labels).toEqual({ agent: "Tesla", model: "GPT-5" });
  });

  it("keeps read-only slash actions available and blocks mutations", () => {
    const allowed = ["/MODEL", "/MODELS", "/CONNECT", "/HELP", "/AGENTS"];
    const blocked = ["/compact", "/model gpt-5", "/connect openai secret", "/agent next", "/start-work"];

    for (const input of allowed) {
      const command = parseSlashCommand(input);
      if (!command) throw new Error(`Expected ${input} to parse`);
      expect(slashCommandAllowedDuringTurn(command)).toBe(true);
    }
    for (const input of blocked) {
      const command = parseSlashCommand(input);
      if (!command) throw new Error(`Expected ${input} to parse`);
      expect(slashCommandAllowedDuringTurn(command)).toBe(false);
    }
  });

  it("keeps operation ownership exclusive across stale and duplicate releases", () => {
    const gate = createExclusiveOperationGate();
    const first = gate.acquire();

    expect(first).toBeDefined();
    expect(gate.acquire()).toBeUndefined();
    if (!first) throw new Error("Expected first operation lease");

    gate.release(first);
    const second = gate.acquire();
    if (!second) throw new Error("Expected second operation lease");

    gate.release(first);
    expect(gate.isActive()).toBe(true);
    gate.release(first);
    expect(gate.isActive()).toBe(true);
    gate.release(second);
    expect(gate.isActive()).toBe(false);
    expect(gate.acquire()).toBeDefined();
  });

  it("prevents reentrant turns while the first history save is deferred", async () => {
    const turns = createExclusiveOperationGate();
    const mutations = createExclusiveOperationGate();
    let turnRunning = false;
    let releaseSave: (() => void) | undefined;
    const save = new Promise<void>(resolve => {
      releaseSave = resolve;
    });
    const start = async (): Promise<boolean> => {
      const lease = acquireTurnLease(turns, mutations, turnRunning);
      if (!lease) return false;
      turnRunning = true;
      try {
        await save;
        return true;
      } finally {
        turnRunning = false;
        turns.release(lease);
      }
    };

    const first = start();
    const second = start();
    expect(await second).toBe(false);
    if (!releaseSave) throw new Error("Expected deferred history save resolver");
    releaseSave();
    expect(await first).toBe(true);
  });

  it("blocks a turn while a mutation lease is active", () => {
    const turns = createExclusiveOperationGate();
    const mutations = createExclusiveOperationGate();
    const mutation = mutations.acquire();
    if (!mutation) throw new Error("Expected mutation lease");

    expect(acquireTurnLease(turns, mutations, false)).toBeUndefined();
    mutations.release(mutation);
    expect(acquireTurnLease(turns, mutations, false)).toBeDefined();
  });

  it("releases a failed compact mutation lease before the next operation", async () => {
    const turns = createExclusiveOperationGate();
    const mutations = createExclusiveOperationGate();
    const lease = mutations.acquire();
    if (!lease) throw new Error("Expected compact mutation lease");
    const messages: string[] = [];

    expect(mutations.acquire()).toBeUndefined();
    expect(acquireTurnLease(turns, mutations, false)).toBeUndefined();
    try {
      await compactActiveContext({
        compact: async () => err(new StrongCodeError("MODEL_ERROR", "provider unavailable"))
      }, activeAgent(), "session-compact", (_role, text) => {
        messages.push(text);
      });
    } finally {
      mutations.release(lease);
    }

    expect(messages.at(-1)).toBe("Unable to compact context: provider unavailable");
    expect(mutations.acquire()).toBeDefined();
  });

  it("rejects stale model refresh tokens after a newer popup supersedes them", () => {
    const refreshes = createModelRefreshGate();
    const first = refreshes.begin();
    const second = refreshes.begin();

    expect(refreshes.isCurrent(first, "models")).toBe(false);
    expect(refreshes.isCurrent(second, "models")).toBe(true);
    refreshes.invalidate();
    expect(refreshes.isCurrent(second, "models")).toBe(false);
  });

  it("transfers a start-work mutation lease directly into one nested turn submission", () => {
    const turns = createExclusiveOperationGate();
    const mutations = createExclusiveOperationGate();
    const outer = mutations.acquire();
    if (!outer) throw new Error("Expected outer mutation lease");
    let submissions = 0;
    let nestedTurnAcquired = false;
    let newerMutation: object | undefined;

    releaseOperationAndSubmit(mutations, outer, () => {
      submissions += 1;
      const turn = acquireTurnLease(turns, mutations, false);
      nestedTurnAcquired = turn !== undefined;
      if (turn) turns.release(turn);
      newerMutation = mutations.acquire();
    });

    expect(submissions).toBe(1);
    expect(nestedTurnAcquired).toBe(true);
    if (!newerMutation) throw new Error("Expected newer mutation lease");
    mutations.release(outer);
    expect(mutations.isActive()).toBe(true);
    mutations.release(newerMutation);
    expect(mutations.isActive()).toBe(false);
  });
});
