import * as core from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { addSummaryOverlay } from "../../src/tui/app";
import { modelUiControls } from "../../src/tui/ui/session-chrome";

async function main(): Promise<void> {
  const setup = await createTestRenderer({ width: 60, height: 18, exitOnCtrlC: false });
  const state = {
    provider: "openai",
    model: "gpt-5",
    modelDisplayName: "GPT-5",
    defaultAgent: "Herman",
    configPath: "strongcode.config.yaml",
    configMissing: false,
    workspace: ".",
    modelOptions: { supportsReasoning: true, supportsFastMode: true, reasoning: true, reasoning_effort: "high", fast_mode: true }
  };
  const services = {
    controls: modelUiControls(state.modelOptions, state.provider),
    telemetry: { totalTokens: 42100, costUsd: 0.84, toolCalls: 6, skillsRead: 2, mcpServersLoaded: 3, mcpServersUsed: 1 },
    lastReceipt: { status: "finished", agent: "Herman", model: "GPT-5", durationMs: 1200, toolCalls: 6, skillsRead: 2, mcpServersUsed: 1 }
  };

  try {
    const body = addSummaryOverlay(core, setup.renderer, { state } as never, services as never, "Improve the interface") as InstanceType<typeof core.ScrollBoxRenderable>;
    await setup.flush();
    const top = setup.captureCharFrame();
    const scrollable = body.scrollHeight > body.height;
    body.scrollTo(body.scrollHeight);
    await setup.flush();
    const bottom = setup.captureCharFrame();
    process.stdout.write(`${JSON.stringify({
      topHasTitle: top.includes("SESSION SUMMARY"),
      scrollable,
      bottomHasLatest: bottom.includes("LATEST TURN"),
      bottomHasReceipt: bottom.includes("Finished · Herman"),
      maxLine: Math.max(...`${top}\n${bottom}`.trimEnd().split(/\r?\n/).map(line => line.length))
    })}\n`);
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy();
  }
}

void main();
