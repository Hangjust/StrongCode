import * as core from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import stringWidth from "string-width";
import { addSummaryOverlay, buildSession } from "../../src/tui/app";
import { modelUiControls } from "../../src/tui/ui/session-chrome";
import type { SessionTelemetry } from "../../src/tui/ui/session-chrome";

const width = Number.parseInt(process.argv[2] ?? "110", 10);
const mode = process.argv[3] ?? "success";

function telemetry(): SessionTelemetry {
  const dynamicUnicode = "日本語 e\u0301 👩‍💻";
  const control = "\x1b[2J";
  const originalPrompt = `  Exact first prompt ${dynamicUnicode}${control}\nwith a second line  `;
  const summary = mode === "success" || mode === "fallback"
    ? {
        status: "committed" as const,
        originalPrompt,
        title: `Immutable title ${dynamicUnicode}${control}`,
        generalSummary: `A concise general summary ${dynamicUnicode}${control}.`,
        requestedItems: [`First requested item ${dynamicUnicode}${control}`, `Second requested item ${dynamicUnicode}${control}`]
      }
    : {
        status: mode === "cancelled" ? "cancelled" as const : "failed-open" as const,
        originalPrompt,
        requestedItems: []
      };
  return {
    totalTokens: 8_700,
    costUsd: 0.0123,
    costProvenance: mode === "fallback" ? "estimated" : "provider-reported",
    contextInputTokens: 8_500,
    contextWindowTokens: 10_000,
    toolCalls: 0,
    summary
  };
}

async function main(): Promise<void> {
  const setup = await createTestRenderer({ width, height: 30, exitOnCtrlC: false });
  const state = {
    provider: "openai",
    model: "gpt-5",
    modelDisplayName: "GPT-5",
    defaultAgent: "Newton",
    configPath: "strongcode.config.yaml",
    configMissing: false
  };
  const services = {
    startupOverlay: "none",
    dialogs: { active: () => undefined },
    controls: modelUiControls(undefined),
    promptDraft: "",
    telemetry: telemetry()
  };
  try {
    buildSession(core, setup.renderer, { state } as never, services as never, "Original header title", () => undefined);
    await setup.flush();
    const rail = setup.captureCharFrame();
    addSummaryOverlay(core, setup.renderer, { state } as never, services as never, "Original header title");
    await setup.flush();
    const overlay = setup.captureCharFrame();
    process.stdout.write(JSON.stringify({
      mode,
      width,
      railVisible: rail.includes("SESSION SUMMARY"),
      hasContext: rail.includes("Context 85.0%"),
      hasRequestedItems: rail.includes("1. First requested item"),
      hasGeneratedUnicode: rail.includes("日本語") && overlay.includes("日本語"),
      hasGeneratedEscapeControl: rail.includes("\x1b") || overlay.includes("\x1b"),
      hasOriginalPrompt: overlay.includes("Exact first prompt 日本語"),
      hasEscapeControl: overlay.includes("\x1b"),
      maxCellWidth: Math.max(...`${rail}\n${overlay}`.trimEnd().split(/\r?\n/).map(line => stringWidth(line)) )
    }) + "\n");
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy();
  }
}

void main();
