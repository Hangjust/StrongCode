import * as core from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createPrompt } from "../../src/tui/app";
import { modelUiControls } from "../../src/tui/ui/session-chrome";

async function flushDeferredLayout(setup: Awaited<ReturnType<typeof createTestRenderer>>): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
  await setup.flush();
}

async function main(): Promise<void> {
  const setup = await createTestRenderer({ width: 100, height: 30, exitOnCtrlC: false });
  try {
    setup.renderer.root.flexDirection = "column";
    const parent = new core.BoxRenderable(setup.renderer, { width: "100%", flexDirection: "column" });
    setup.renderer.root.add(parent);
    let contentChanges = 0;
    const prompt = createPrompt(core, setup.renderer, parent, {
      provider: "mock",
      model: "mock",
      modelDisplayName: "Mock",
      defaultAgent: "Tesla",
      agentIdentity: "tesla",
      configPath: "strongcode.config.yaml",
      configMissing: false
    }, modelUiControls({ supportsReasoning: false, supportsFastMode: false, reasoning: false, fastMode: false }, "mock"), "/", () => undefined, () => {
      contentChanges += 1;
    });

    await flushDeferredLayout(setup);
    const mount = contentChanges;

    prompt.textarea.focus();
    setup.renderer.focusRenderable(prompt.textarea);
    await setup.mockInput.pasteBracketedText("edit");
    await flushDeferredLayout(setup);
    const afterEdit = contentChanges;

    prompt.resize(80);
    await setup.flush();
    await flushDeferredLayout(setup);

    process.stdout.write(`${JSON.stringify({ mount, afterEdit, afterResize: contentChanges })}\n`);
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy();
  }
}

void main();
