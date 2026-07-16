import * as core from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { buildHome, buildSession } from "../../src/tui/app";
import { DialogManager } from "../../src/tui/ui/dialog";
import { modelUiControls } from "../../src/tui/ui/session-chrome";

async function main(): Promise<void> {
  const width = Math.max(60, Number.parseInt(process.argv[2] ?? "80", 10));
  const mode = process.argv[3] === "session" ? "session" : "home";
  const setup = await createTestRenderer({ width, height: 30, exitOnCtrlC: false });
  const state = {
    provider: "openai",
    providerDisplayName: "OpenAI",
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
    telemetry: { totalTokens: 42100, costUsd: 0.84, toolCalls: 6, skillsRead: 2, mcpServersLoaded: 3, mcpServersUsed: 1 }
  };

  try {
    if (mode === "home") {
      buildHome(core, setup.renderer, { state } as never, services as never, () => undefined, undefined, {
        onSlashFocus() {},
        onSlashSelect() {},
        onProviderSelect() {},
        onProviderQueryChange() {},
        onProviderAuthMethodSelect() {},
        onProviderAuthSubmit() {},
        onCustomProviderFieldFocus() {},
        onCustomProviderFieldChange() {},
        onCustomProviderDiscover() {},
        onCustomProviderModelToggle() {},
        onCustomProviderSubmit() {},
        onModelSelect() {}
      });
    } else {
      buildSession(core, setup.renderer, { state } as never, services as never, "Improve the StrongCode interface", () => undefined);
    }
    await setup.flush();
    process.stdout.write(`${setup.captureCharFrame()}\n`);
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy();
  }
}

void main();
