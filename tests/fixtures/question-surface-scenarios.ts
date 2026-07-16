import * as core from "@opentui/core";
import { click, createQuestionSurfaceHarness, maxLine, request, settled } from "./question-surface-support";

const SURFACE_MODES = new Set(["compact", "tabbed", "error", "unavailable", "editor", "lifecycle", "resources", "width"]);

export function isQuestionSurfaceMode(mode: string): boolean {
  return SURFACE_MODES.has(mode);
}

export async function renderQuestionSurfaceScenario(mode: string): Promise<Record<string, unknown>> {
  const harness = await createQuestionSurfaceHarness(mode);
  const { setup, broker, testKeymap, controller } = harness;

  try {
    const count = mode === "compact" ? 2 : 3;
    const answer = broker.ask(request(count));
    await setup.flush();

    if (mode === "compact") {
      await click(setup, "question-option-0");
      setup.mockInput.pressArrow("right");
      await setup.flush();
      testKeymap.dispatch("question.enter");
      await setup.flush();
      const frame = setup.captureCharFrame();
      if (!testKeymap.dispatch("question.submit")) throw new Error(`editor submit was blocked\n${setup.captureCharFrame()}`);
      await setup.flush();
      return { frame, answer: await settled(answer, setup) };
    }

    if (mode === "tabbed") {
      for (let index = 0; index < 3; index += 1) {
        testKeymap.dispatch("question.enter");
        await setup.flush();
        if (index < 2) {
          setup.mockInput.pressArrow("right");
          await setup.flush();
        }
      }
      setup.mockInput.pressKey("F3");
      await setup.flush();
      const frame = setup.captureCharFrame();
      setup.mockInput.pressArrow("right");
      await setup.flush();
      const guidance = setup.renderer.root.findDescendantById("question-guidance");
      if (!guidance) throw new Error("missing guidance");
      guidance.focus();
      setup.renderer.focusRenderable(guidance);
      await setup.mockInput.pasteBracketedText("Use the small change.");
      await new Promise<void>(resolve => setImmediate(resolve));
      await setup.flush();
      const confirmFrame = setup.captureCharFrame();
      if (!testKeymap.dispatch("question.submit")) throw new Error(`editor submit was blocked\n${setup.captureCharFrame()}`);
      await setup.flush();
      return { frame, confirmFrame, answer: await settled(answer, setup) };
    }

    if (mode === "error") {
      setup.mockInput.pressKey("F3");
      await setup.flush();
      return { frame: setup.captureCharFrame(), simplifyCalls: harness.simplifyCalls() };
    }

    if (mode === "unavailable") {
      setup.mockInput.pressKey("F3");
      await setup.flush();
      return { frame: setup.captureCharFrame() };
    }

    if (mode === "editor") {
      testKeymap.dispatch("question.enter");
      setup.mockInput.pressArrow("right");
      await setup.flush();
      testKeymap.dispatch("question.enter");
      setup.mockInput.pressArrow("right");
      await setup.flush();
      testKeymap.dispatch("question.enter");
      await setup.flush();
      await click(setup, "question-custom");
      const custom = setup.renderer.currentFocusedRenderable;
      if (!custom || custom.id !== "question-custom") throw new Error("missing custom editor");
      custom.focus();
      setup.renderer.focusRenderable(custom);
      await setup.mockInput.pasteBracketedText("Keep");
      setup.mockInput.pressKey(" ");
      await setup.mockInput.pasteBracketedText("plan");
      setup.mockInput.pressEnter();
      await setup.flush();
      if (!testKeymap.dispatch("question.dismiss")) throw new Error("first Escape was not handled");
      await setup.flush();
      if (!testKeymap.dispatch("question.next-page")) throw new Error("page command was not handled");
      await setup.flush();
      const guidance = setup.renderer.currentFocusedRenderable;
      if (!guidance || guidance.id !== "question-guidance") throw new Error("missing guidance editor");
      guidance.focus();
      setup.renderer.focusRenderable(guidance);
      await setup.mockInput.pasteBracketedText("Use small steps");
      setup.mockInput.pressEnter();
      await setup.flush();
      if (!testKeymap.dispatch("question.submit")) throw new Error(`editor submit was blocked\n${setup.captureCharFrame()}`);
      await setup.flush();
      const editedAnswer = await settled(answer, setup);

      const dismissal = broker.ask(request(3));
      await setup.flush();
      setup.mockInput.pressArrow("right");
      setup.mockInput.pressArrow("right");
      await setup.flush();
      await click(setup, "question-custom");
      const nextCustom = setup.renderer.currentFocusedRenderable;
      if (!nextCustom || nextCustom.id !== "question-custom") throw new Error("missing next custom editor");
      nextCustom.focus();
      setup.renderer.focusRenderable(nextCustom);
      if (!testKeymap.dispatch("question.dismiss")) throw new Error("first Escape was not handled");
      await setup.flush();
      let pendingAfterFirstEscape = true;
      void dismissal.then(() => { pendingAfterFirstEscape = false; });
      await new Promise<void>(resolve => setImmediate(resolve));
      const wasPendingAfterFirstEscape = pendingAfterFirstEscape;
      if (!testKeymap.dispatch("question.dismiss")) throw new Error("second Escape was not handled");
      await setup.flush();
      return { editedAnswer, pendingAfterFirstEscape: wasPendingAfterFirstEscape, dismissed: await settled(dismissal, setup) };
    }

    if (mode === "lifecycle") {
      setup.mockInput.pressEscape();
      await setup.flush();
      const dismissed = await settled(answer, setup);
      const running = broker.ask(request(3));
      await setup.flush();
      setup.mockInput.pressKey("F3");
      await setup.flush();
      controller.destroy();
      await settled(running, setup);
      return { dismissed, aborted: harness.aborted() };
    }

    if (mode === "resources") {
      setup.mockInput.pressArrow("right");
      setup.mockInput.pressArrow("right");
      await setup.flush();
      const mountedListenerCount = setup.renderer.listenerCount("selection");
      const mountedResizeListenerCount = setup.renderer.listenerCount("resize");
      const outgoingEditors: NonNullable<InstanceType<typeof core.CliRenderer>["currentFocusedRenderable"]>[] = [];
      const rerenderListenerCounts: number[] = [];

      for (let index = 0; index < 12; index += 1) {
        await click(setup, "question-custom");
        const editor = setup.renderer.currentFocusedRenderable;
        if (!editor || editor.id !== "question-custom") throw new Error("missing custom editor");
        outgoingEditors.push(editor);
        rerenderListenerCounts.push(setup.renderer.listenerCount("selection"));
        if (!testKeymap.dispatch("question.dismiss")) throw new Error("first Escape was not handled");
        await setup.flush();
        rerenderListenerCounts.push(setup.renderer.listenerCount("selection"));
      }

      controller.destroy();
      await settled(answer, setup);
      return {
        preMountListenerCount: harness.preMountListenerCount,
        mountedListenerCount,
        preMountResizeListenerCount: harness.preMountResizeListenerCount,
        mountedResizeListenerCount,
        mountedResizeListenerDelta: mountedResizeListenerCount - harness.preMountResizeListenerCount,
        rerenderListenerCounts,
        outgoingEditorDestroyed: outgoingEditors.map(editor => editor.isDestroyed),
        destroyedListenerCount: setup.renderer.listenerCount("selection"),
        destroyedResizeListenerCount: setup.renderer.listenerCount("resize")
      };
    }

    const widths = [60, 80, 100];
    const lines: number[] = [];
    const frames: string[] = [];
    for (const width of widths) {
      setup.resize(width, 28);
      await setup.flush();
      const frame = setup.captureCharFrame();
      lines.push(maxLine(frame));
      frames.push(frame);
    }
    return { maxLine60: lines[0], maxLine80: lines[1], maxLine100: lines[2], frame60: frames[0], frame80: frames[1], frame100: frames[2] };
  } finally {
    harness.destroy();
  }
}
