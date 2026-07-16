import * as core from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { buildSession } from "../../src/tui/app";
import { DialogManager } from "../../src/tui/ui/dialog";
import { modelUiControls } from "../../src/tui/ui/session-chrome";

async function main(): Promise<void> {
  const setup = await createTestRenderer({ width: 160, height: 30, exitOnCtrlC: false });
  const state = {
    provider: "openai",
    model: "gpt-5",
    modelDisplayName: "GPT-5",
    defaultAgent: "Newton",
    agentIdentity: "newton",
    configPath: "strongcode.config.yaml",
    configMissing: false,
    workspace: "C:/projects/strongcode",
    mcpServersLoaded: 3,
    modelOptions: { supportsReasoning: true, supportsFastMode: true, reasoning: true, reasoning_effort: "high", fast_mode: true }
  };
  const services = {
    startupOverlay: "none",
    dialogs: new DialogManager(),
    controls: modelUiControls(state.modelOptions, state.provider),
    promptDraft: "",
    helpOpen: false,
    telemetry: { totalTokens: 42100, costUsd: 0.84, toolCalls: 6, skillsRead: 2, mcpServersLoaded: 3, mcpServersUsed: 1 }
  };

  try {
    const view = buildSession(core, setup.renderer, { state } as never, services as never, "Resize the interface", () => undefined);
    const resize = (width: number) => view.resize(width);
    setup.renderer.on("resize", resize);
    view.textarea.focus();
    setup.renderer.focusRenderable(view.textarea);
    await setup.mockInput.pasteBracketedText("wrapped input ".repeat(35));
    await new Promise<void>(resolve => setImmediate(resolve));
    await setup.flush();
    const wide = setup.captureCharFrame();
    const widePrompt = view.prompt.anchor.width;
    const wideHeight = view.textarea.height;

    setup.resize(80, 30);
    await setup.flush();
    await new Promise<void>(resolve => setImmediate(resolve));
    await setup.flush();
    const narrow = setup.captureCharFrame();
    const narrowPrompt = view.prompt.anchor.width;
    const narrowHeight = view.textarea.height;

    setup.resize(160, 30);
    await setup.flush();
    await new Promise<void>(resolve => setImmediate(resolve));
    await setup.flush();
    const wideAgain = setup.captureCharFrame();
    const wideAgainPrompt = view.prompt.anchor.width;
    const wideAgainHeight = view.textarea.height;
    setup.renderer.off("resize", resize);

    process.stdout.write(`${JSON.stringify({
      wideHasSummary: wide.includes("SESSION SUMMARY"),
      narrowHasSummary: narrow.includes("SESSION SUMMARY"),
      wideAgainHasSummary: wideAgain.includes("SESSION SUMMARY"),
      narrowHasVersion: narrow.includes("v0.1.0"),
      widePrompt,
      narrowPrompt,
      wideAgainPrompt,
      wideHeight,
      narrowHeight,
      wideAgainHeight,
      narrowMaxLine: Math.max(...narrow.trimEnd().split(/\r?\n/).map(line => line.length))
    })}\n`);
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy();
  }
}

void main();
