import { execFile, spawnSync } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { renderHome, renderSessionLayout, sanitizeDisplayValue, sanitizeMultilineDisplayValue } from "../src/tui/render";
import {
  STRONGCODE_VERSION,
  commandHelpLines,
  compactSessionTitle,
  fastModeLabel,
  formatCost,
  formatTokens,
  promptHeightForVisualLines,
  sanitizeChromeText,
  sessionTelemetryLine,
  shouldFollowLatestPosition,
  shouldSyncSlashOverlay,
  turnReceiptLine
} from "../src/tui/ui/session-chrome";

const execFileAsync = promisify(execFile);
const visualIt = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0 ? it : it.skip;
const BIDI_SPOOFING_CONTROLS = ["\u061C", "\u200E", "\u200F", "\u2028", "\u2029", "\u202A", "\u202B", "\u202C", "\u202D", "\u202E", "\u2066", "\u2067", "\u2068", "\u2069"] as const;

async function renderLayoutFixture(width: number, mode: "home" | "session"): Promise<string> {
  const fixture = path.resolve(__dirname, "fixtures", "render-layout.ts");
  const { stdout } = await execFileAsync("bun", [fixture, String(width), mode], { cwd: path.resolve(__dirname, "..") });
  return stdout;
}

describe("session chrome", () => {
  it("removes every bidi control while preserving RTL, combining text, and ZWJ emoji", () => {
    const safeText = "עברית العربية e\u0301 👩‍💻";

    for (const control of BIDI_SPOOFING_CONTROLS) {
      expect(sanitizeDisplayValue(`${safeText}${control}${safeText}`)).toBe(`${safeText}${safeText}`);
      expect(sanitizeMultilineDisplayValue(`first ${safeText}${control}\nsecond ${safeText}`)).toBe(`first ${safeText}\nsecond ${safeText}`);
      expect(sanitizeChromeText(`${safeText}${control}${safeText}`)).toBe(`${safeText}${safeText}`);
    }

    expect(sanitizeDisplayValue(safeText)).toBe(safeText);
    expect(sanitizeMultilineDisplayValue(`first ${safeText}\nsecond ${safeText}`)).toBe(`first ${safeText}\nsecond ${safeText}`);
    expect(sanitizeChromeText(safeText)).toBe(safeText);
  });

  it("formats honest unknown and known session telemetry", () => {
    expect(formatTokens(undefined)).toBe("— tok");
    expect(formatCost(undefined)).toBe("$—");
    expect(sessionTelemetryLine({ toolCalls: 0 })).toBe("— tok · $— · — MCPs loaded");
    expect(sessionTelemetryLine({ toolCalls: 0, mcpServersLoaded: 3 })).toBe("— tok · $— · 3 MCPs loaded");
    expect(turnReceiptLine({
      status: "finished",
      agent: "Herman",
      model: "GPT",
      durationMs: 1250,
      toolCalls: 2,
      skillsRead: 1,
      mcpServersUsed: 1
    })).toBe("Finished · Herman · GPT · 1.3s · 2 tools · 1 skill · 1 MCP");
    const sanitized = turnReceiptLine({
      status: "finished",
      agent: "Her\u001b]52;c;steal\u0007man",
      model: "GPT\u001b[2J",
      durationMs: 1,
      toolCalls: 0
    });
    expect(sanitized).toContain("Herman · GPT");
    expect(sanitized).not.toMatch(/\u001b|steal/);
  });

  it("keeps titles and composer growth bounded", () => {
    expect(compactSessionTitle("   Build   a better interface   ")).toBe("Build a better interface");
    expect(compactSessionTitle("line one\nline two")).toBe("line one line two");
    expect(compactSessionTitle("x".repeat(80), 20)).toBe(`${"x".repeat(19)}…`);
    expect(promptHeightForVisualLines(0)).toBe(1);
    expect(promptHeightForVisualLines(4)).toBe(4);
    expect(promptHeightForVisualLines(500)).toBe(6);
    expect(shouldFollowLatestPosition(100, 80, 20)).toBe(true);
    expect(shouldFollowLatestPosition(100, 70, 20)).toBe(false);
    expect(shouldSyncSlashOverlay(false)).toBe(true);
    expect(shouldSyncSlashOverlay(true)).toBe(true);
    expect(shouldSyncSlashOverlay(true, true)).toBe(false);
  });

  it("exposes help for chat, reasoning, session navigation, and fallback keys", () => {
    const help = commandHelpLines().join("\n");
    expect(help).toContain("Ctrl+H / F1");
    expect(help).toContain("minimal · low · medium · high · max");
    for (const unavailable of ["/reasoning", "/effort", "/fast"]) expect(help).not.toContain(unavailable);
    expect(help).toContain("/agent [name]");
    expect(help).toContain("Tab / Shift+Tab");
    expect(help).toContain("/start-work");
    expect(help).toContain("/summary / F2");
    expect(help).toContain("PgUp / PgDn");
    expect(help).toContain("/model");
  });

  it("renders compact startup and detailed per-turn receipts in fallback mode", () => {
    const state = {
      provider: "openai",
      model: "gpt",
      modelDisplayName: "GPT",
      defaultAgent: "Herman",
      configPath: "strongcode.config.yaml",
      configMissing: false,
      workspace: ".",
      mcpServersLoaded: 2
    };
    const home = renderHome(state, true);
    const session = renderSessionLayout(state, [
      { role: "user", text: "hi" },
      {
        role: "assistant",
        text: "Hello.",
        receipt: { status: "finished", agent: "Herman", model: "GPT", durationMs: 800, toolCalls: 2, skillsRead: 1, mcpServersUsed: 1 }
      }
    ], true);

    expect(home).toContain("█▀▀▀ ▀█▀▀ █▀▀▄ █▀▀█ █▀▀▄ █▀▀▀");
    expect(home).toContain(`v${STRONGCODE_VERSION}`);
    expect(home).toContain("2 MCPs loaded");
    expect(session).toContain("Sent to Herman · GPT");
    expect(session).toContain("Finished · Herman · GPT · 800ms · 2 tools · 1 skill · 1 MCP");
    expect(session).not.toContain("No messages in session");

    const multiline = renderSessionLayout(state, [{ role: "user", text: "line one\nline two" }], true);
    expect(multiline).toMatch(/line one.*\n.*line two/);
  });

  visualIt("grows the real OpenTUI composer downward, then caps it at six rows", async () => {
    const fixture = path.resolve(__dirname, "fixtures", "render-composer.ts");
    const { stdout } = await execFileAsync("bun", [fixture], { cwd: path.resolve(__dirname, "..") });
    const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as {
      initialHeight: number;
      finalHeight: number;
      anchorHeight: number;
      virtualLines: number;
      hasHelpHint: boolean;
      composerStatuses: string[];
      modelColor: number[] | undefined;
    };

    expect(result.initialHeight).toBe(1);
    expect(result.virtualLines).toBeGreaterThan(6);
    expect(result.finalHeight).toBe(6);
    expect(result.anchorHeight).toBe(10);
    expect(result.hasHelpHint).toBe(true);
    expect(result.composerStatuses).toEqual([
      "Tesla - Main Agent · Composer 2.5 · 🧠 · ⚡",
      "Newton - Deep Worker · Composer 2.5 · 🧠 · ⚡",
      "JBP - Plan Builder · Composer 2.5 · 🧠 · ⚡",
      "Bob The Builder - Plan Executor · Composer 2.5 · 🧠 · ⚡",
      "Steve Jobs · Composer 2.5 · 🧠 · ⚡",
      "Custom Worker · Composer 2.5 · 🧠 · ⚡",
      "Tesla · Composer 2.5 · 🧠 · ⚡",
      "Ada - Main Agent · Composer 2.5 · 🧠 · ⚡",
      "JBP - Main Agent · Composer 2.5 · 🧠 · ⚡"
    ]);
    expect(result.modelColor).toEqual([242, 238, 230, 255]);
  });

  visualIt("keeps the real OpenTUI chrome responsive at compact and wide widths", async () => {
    const [home60, session60, home72, session72, home80, session80, session120, session160] = await Promise.all([
      renderLayoutFixture(60, "home"),
      renderLayoutFixture(60, "session"),
      renderLayoutFixture(72, "home"),
      renderLayoutFixture(72, "session"),
      renderLayoutFixture(80, "home"),
      renderLayoutFixture(80, "session"),
      renderLayoutFixture(120, "session"),
      renderLayoutFixture(160, "session")
    ]);

    expect(home60).toContain(`v${STRONGCODE_VERSION}`);
    expect(session60).toContain(`v${STRONGCODE_VERSION}`);
    expect(home72).toContain(`v${STRONGCODE_VERSION}`);
    expect(home80).toContain("█▀▀▀ ▀█▀▀ █▀▀▄ █▀▀█ █▀▀▄ █▀▀▀");
    expect(home80).toContain("Ctrl+H commands");
    expect(session80).not.toContain("SESSION SUMMARY");
    expect(session120).toContain("SESSION SUMMARY");
    expect(session160).toContain("SESSION SUMMARY");
    expect(session120).toContain("Newton - Deep Worker · GPT-5 · 🧠 · ⚡");
    for (const [frame, width] of [[home60, 60], [session60, 60], [home72, 72], [session72, 72], [home80, 80], [session80, 80], [session120, 120], [session160, 160]] as const) {
      expect(Math.max(...frame.trimEnd().split(/\r?\n/).map(line => line.length))).toBeLessThanOrEqual(width);
    }
  });

  visualIt("reflows one live session when the terminal narrows and widens", async () => {
    const fixture = path.resolve(__dirname, "fixtures", "render-resize.ts");
    const { stdout } = await execFileAsync("bun", [fixture], { cwd: path.resolve(__dirname, "..") });
    const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as {
      wideHasSummary: boolean;
      narrowHasSummary: boolean;
      wideAgainHasSummary: boolean;
      narrowHasVersion: boolean;
      widePrompt: number;
      narrowPrompt: number;
      wideAgainPrompt: number;
      wideHeight: number;
      narrowHeight: number;
      wideAgainHeight: number;
      narrowMaxLine: number;
    };

    expect(result.wideHasSummary).toBe(true);
    expect(result.narrowHasSummary).toBe(false);
    expect(result.wideAgainHasSummary).toBe(true);
    expect(result.narrowHasVersion).toBe(true);
    expect(result.widePrompt).toBeGreaterThan(result.narrowPrompt);
    expect(result.wideAgainPrompt).toBe(result.widePrompt);
    expect(result.wideHeight).toBeLessThan(6);
    expect(result.narrowHeight).toBe(6);
    expect(result.wideAgainHeight).toBe(result.wideHeight);
    expect(result.narrowMaxLine).toBeLessThanOrEqual(80);
  });

  visualIt("keeps the compact summary reachable on short terminals", async () => {
    const fixture = path.resolve(__dirname, "fixtures", "render-summary.ts");
    const { stdout } = await execFileAsync("bun", [fixture], { cwd: path.resolve(__dirname, "..") });
    const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as {
      topHasTitle: boolean;
      scrollable: boolean;
      bottomHasLatest: boolean;
      bottomHasReceipt: boolean;
      maxLine: number;
    };

    expect(result.topHasTitle).toBe(true);
    expect(result.scrollable).toBe(true);
    expect(result.bottomHasLatest).toBe(true);
    expect(result.bottomHasReceipt).toBe(true);
    expect(result.maxLine).toBeLessThanOrEqual(60);
  });
});
