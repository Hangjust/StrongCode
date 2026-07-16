import * as core from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createPrompt } from "../../src/tui/app";
import { modelUiControls } from "../../src/tui/ui/session-chrome";

async function main(): Promise<void> {
  const setup = await createTestRenderer({ width: 100, height: 60, exitOnCtrlC: false });
  try {
    setup.renderer.root.flexDirection = "column";
    const parent = new core.BoxRenderable(setup.renderer, { width: "100%", flexDirection: "column" });
    setup.renderer.root.add(parent);
    const prompt = createPrompt(core, setup.renderer, parent, {
      provider: "mock",
      model: "composer-2.5",
      modelDisplayName: "Composer 2.5",
      defaultAgent: "Tesla",
      agentIdentity: "tesla",
      configPath: "strongcode.config.yaml",
      configMissing: false
    }, modelUiControls({ supportsReasoning: true, supportsFastMode: true, reasoning: true, fastMode: true }, "openai"), "", () => undefined, undefined, 96);
    for (const [agentIdentity, defaultAgent] of [
      ["newton", "Newton"],
      ["jbp", "JBP"],
      ["bob-the-builder", "Bob The Builder"],
      ["steve-jobs", "Steve Jobs"],
      ["custom-worker", "Custom Worker"],
      ["custom-agent", "Tesla"],
      ["tesla", "Ada"],
      ["tesla", "JBP"]
    ]) {
      createPrompt(core, setup.renderer, parent, {
        provider: "mock",
        model: "composer-2.5",
        modelDisplayName: "Composer 2.5",
        defaultAgent,
        agentIdentity,
        configPath: "strongcode.config.yaml",
        configMissing: false
      }, modelUiControls({ supportsReasoning: true, supportsFastMode: true, reasoning: true, fastMode: true }, "openai"), "", () => undefined, undefined, 96);
    }

    prompt.textarea.focus();
    setup.renderer.focusRenderable(prompt.textarea);
    await setup.flush();
    const initialHeight = prompt.textarea.height;
    const initialFrame = setup.captureCharFrame();
    const composerStatuses = initialFrame.split("\n")
      .filter(line => line.includes("Composer 2.5"))
      .map(line => line.trim());
    await setup.mockInput.pasteBracketedText("wrapped input ".repeat(120));
    await new Promise<void>(resolve => setImmediate(resolve));
    await setup.flush();

    const frame = setup.captureCharFrame();
    const modelSpan = setup.captureSpans().lines
      .flatMap(line => line.spans)
      .find(span => span.text.includes("Composer 2.5"));
    process.stdout.write(`${JSON.stringify({
      initialHeight,
      finalHeight: prompt.textarea.height,
      anchorHeight: prompt.anchor.height,
      virtualLines: prompt.textarea.editorView.getTotalVirtualLineCount(),
      textLength: prompt.textarea.plainText.length,
      width: prompt.textarea.width,
      hasHelpHint: frame.includes("Ctrl+H commands"),
      composerStatuses,
      modelColor: modelSpan?.fg.toInts()
    })}\n`);
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy();
  }
}

void main();
