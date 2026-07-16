import { commandHelpLines } from "../src/tui/ui/session-chrome";
import { createDefaultPalette } from "../src/tui/ui/palette";
import {
  fullTuiRouteForInput,
  parseSlashCommand,
  resolveSlashSubmission,
  slashCommandAvailability,
  slashCommandAllowedDuringTurn,
  slashCommandHelpRows,
  slashCommandPaletteRows,
  slashCommandRegistry
} from "../src/tui/slash-command-registry";

describe("slash command registry", () => {
  it("owns the updated canonical commands and palette rows in current order", () => {
    const canonicalCommands = slashCommandRegistry.map(command => command.canonical);
    const paletteRows = slashCommandPaletteRows.map(command => command.slash);

    expect(canonicalCommands).toEqual(["connect", "agent", "start-work", "compact", "model", "summary", "help", "exit"]);
    expect(paletteRows).toEqual(["/connect", "/agent", "/agents", "/start-work", "/compact", "/model", "/models", "/summary", "/help", "/exit"]);
    expect(createDefaultPalette().list()).toEqual(slashCommandPaletteRows);
    expect(slashCommandHelpRows.map(command => command.text)).toEqual([
      "  /model             Pick a model for the active agent",
      "  /model <id>        Set the active agent model directly",
      "  /model <agent> <id> Set a specific agent model",
      "  /models            List available model choices",
      "  /connect           Open provider login / API-key setup",
      "  /agent [name]      List or activate any agent",
      "  /start-work        Approve JBP plan → Bob The Builder",
      "  /compact           Compact active context",
      "  /summary / F2     Tokens · cost · tools · MCPs",
      "  /exit              Exit StrongCode"
    ]);
  });

  it("derives unique palette triggers that all resolve to their canonical command", () => {
    const slashes = slashCommandPaletteRows.map(trigger => trigger.slash);
    const ids = slashCommandPaletteRows.map(trigger => trigger.id);

    expect(new Set(slashes).size).toBe(slashes.length);
    expect(new Set(ids).size).toBe(ids.length);
    for (const command of slashCommandRegistry) {
      for (const trigger of command.triggers) {
        expect(slashCommandPaletteRows).toContain(trigger);
        expect(parseSlashCommand(trigger.slash)?.command).toBe(command.canonical);
      }
    }
  });

  it("keeps removed commands absent from every trigger", () => {
    const slashes = slashCommandPaletteRows.map(trigger => trigger.slash);
    const removed = ["/themes", "/plugins", "/new", "/providers", "/commands", "/reasoning", "/effort", "/fast", "/compress"];

    for (const trigger of removed) expect(slashes).not.toContain(trigger);
  });

  it("resolves slash aliases and plain exit aliases case-insensitively", () => {
    expect(parseSlashCommand("/AGENTS")).toEqual({ command: "agent", action: "list" });
    expect(parseSlashCommand("/COMPACT")).toEqual({ command: "compact" });
    expect(parseSlashCommand("/MODELS")).toEqual({ command: "model", action: "list" });
    expect(parseSlashCommand("EXIT")).toEqual({ command: "exit" });
    expect(parseSlashCommand("QuIt")).toEqual({ command: "exit" });
  });

  it("normalizes only the command token and preserves argument casing", () => {
    expect(parseSlashCommand("/AGENT Hood Research Department")).toEqual({
      command: "agent",
      action: "select",
      target: "Hood Research Department"
    });
    expect(parseSlashCommand("/MODEL Newton Gemini-4-Pro")).toEqual({
      command: "model",
      action: "select",
      agentId: "Newton",
      modelId: "Gemini-4-Pro"
    });
    expect(parseSlashCommand("/CONNECT CustomProvider Sk-MixedCase")).toEqual({
      command: "connect",
      rawArgs: "CustomProvider Sk-MixedCase"
    });
  });

  it("parses agent and model actions without accepting invalid fixed-command arguments", () => {
    expect(parseSlashCommand("/agent next")).toEqual({ command: "agent", action: "next" });
    expect(parseSlashCommand("/agent PREV")).toEqual({ command: "agent", action: "previous" });
    expect(parseSlashCommand("/model")).toEqual({ command: "model", action: "open" });
    expect(parseSlashCommand("/compact extra")).toEqual({ command: "unknown", input: "/compact extra" });
    expect(parseSlashCommand("/compress")).toEqual({ command: "unknown", input: "/compress" });
    expect(parseSlashCommand("/model GPT-5.5")).toEqual({ command: "model", action: "select", modelId: "GPT-5.5" });
    expect(parseSlashCommand("/help extra")).toEqual({ command: "unknown", input: "/help extra" });
    expect(parseSlashCommand("/models extra")).toEqual({ command: "unknown", input: "/models extra" });
  });

  it("preserves unknown slash input for the caller", () => {
    expect(parseSlashCommand("  /Unknown MixedCase  ")).toEqual({ command: "unknown", input: "/Unknown MixedCase" });
    expect(parseSlashCommand("hello")).toBeUndefined();
  });

  it("keeps start-work visible while gating it to canonical JBP", () => {
    expect(slashCommandPaletteRows.some(command => command.slash === "/start-work")).toBe(true);
    expect(slashCommandAvailability("start-work", "jbp")).toEqual({ available: true });
    expect(slashCommandAvailability("start-work", "newton")).toEqual({
      available: false,
      message: "Start-work requires an active JBP planning session. Switch with /agent jbp, create the plan, review it, then explicitly run /start-work."
    });
  });

  it("derives only exact full-TUI routes from registry metadata", () => {
    const modelTriggers = slashCommandRegistry.find(command => command.canonical === "model")?.triggers;
    const modelTrigger = modelTriggers?.find(trigger => trigger.slash === "/model");
    const modelsTrigger = modelTriggers?.find(trigger => trigger.slash === "/models");

    expect(modelTrigger && "fullTuiRoute" in modelTrigger ? modelTrigger.fullTuiRoute : undefined).toBe("models");
    expect(modelsTrigger && "fullTuiRoute" in modelsTrigger ? modelsTrigger.fullTuiRoute : undefined).toBeUndefined();
    expect(fullTuiRouteForInput("/CONNECT")).toBe("providers");
    expect(fullTuiRouteForInput("/model")).toBe("models");
    expect(fullTuiRouteForInput("/help")).toBe("help");
    expect(fullTuiRouteForInput("/summary")).toBe("summary");
    expect(fullTuiRouteForInput("/compact")).toBeUndefined();
    expect(fullTuiRouteForInput("/connect custom")).toBeUndefined();
    expect(fullTuiRouteForInput("/models")).toBeUndefined();
  });

  it("uses typed model trigger metadata instead of palette IDs", () => {
    const modelTriggers = slashCommandRegistry.find(command => command.canonical === "model")?.triggers;
    const modelTrigger = modelTriggers?.find(trigger => trigger.slash === "/model");
    const modelsTrigger = modelTriggers?.find(trigger => trigger.slash === "/models");

    expect(modelTrigger && "modelAction" in modelTrigger ? modelTrigger.modelAction : undefined).toBe("open");
    expect(modelsTrigger && "modelAction" in modelsTrigger ? modelsTrigger.modelAction : undefined).toBe("list");
  });

  it("allows only read-only slash actions while a turn runs", () => {
    const allowed = ["/HELP", "/SUMMARY", "/EXIT", "/AGENT", "/AGENTS", "/MODEL", "/MODELS", "/CONNECT", "/unknown"];
    const blocked = ["/agent next", "/agent Newton", "/start-work", "/model GPT-5.5", "/model Newton GPT-5.5", "/connect openai key"];

    for (const input of allowed) {
      const parsed = parseSlashCommand(input);
      if (!parsed) throw new Error(`Expected ${input} to parse`);
      expect(slashCommandAllowedDuringTurn(parsed)).toBe(true);
    }
    for (const input of blocked) {
      const parsed = parseSlashCommand(input);
      if (!parsed) throw new Error(`Expected ${input} to parse`);
      expect(slashCommandAllowedDuringTurn(parsed)).toBe(false);
    }
  });

  it("projects exactly the existing slash-bearing help rows", () => {
    const renderedSlashRows = commandHelpLines().filter(line => line.trimStart().startsWith("/"));

    expect(renderedSlashRows).toEqual(slashCommandHelpRows.map(row => row.text));
  });

  it("prefers current argument-bearing submitted text over a stale selected suggestion", () => {
    expect(resolveSlashSubmission("/connect CustomProvider Sk-MixedCase", "/connect")).toBe("/connect CustomProvider Sk-MixedCase");
    expect(resolveSlashSubmission("/help extra", "/help")).toBe("/help extra");
    expect(resolveSlashSubmission("/con", "/connect")).toBe("/connect");
  });
});
