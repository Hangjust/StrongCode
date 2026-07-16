import * as core from "@opentui/core";
import { click, createQuestionSurfaceHarness, request, settled, type QuestionSurfaceFixtureSetup } from "./question-surface-support";

const VISUAL_MODES = ["previous-focus", "focus", "validation", "repeat-simplify", "loading"];

export function isQuestionSurfaceVisualMode(mode: string): boolean {
  return VISUAL_MODES.includes(mode);
}

function focusedId(setup: QuestionSurfaceFixtureSetup): string | undefined {
  return setup.renderer.currentFocusedRenderable?.id;
}

function focusedTextareaText(setup: QuestionSurfaceFixtureSetup, id: string): string {
  const focused = setup.renderer.currentFocusedRenderable;
  if (!(focused instanceof core.TextareaRenderable) || focused.id !== id) throw new Error(`missing ${id}`);
  return focused.plainText;
}

async function settleRender(setup: QuestionSurfaceFixtureSetup): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
  await setup.flush();
}

async function rejectedEditorSnapshots(setup: QuestionSurfaceFixtureSetup, id: string, invalidSuffixes: readonly string[]): Promise<{
  readonly plainTexts: readonly string[];
  readonly focusIds: readonly (string | undefined)[];
  readonly frames: readonly string[];
}> {
  const plainTexts: string[] = [];
  const focusIds: (string | undefined)[] = [];
  const frames: string[] = [];
  for (const suffix of invalidSuffixes) {
    await setup.mockInput.pasteBracketedText(suffix);
    await setup.flush();
    plainTexts.push(focusedTextareaText(setup, id));
    focusIds.push(focusedId(setup));
    frames.push(setup.captureCharFrame());
  }
  return { plainTexts, focusIds, frames };
}

async function previousFocusScenario(): Promise<Record<string, unknown>> {
  let external: InstanceType<typeof core.BoxRenderable> | undefined;
  const harness = await createQuestionSurfaceHarness("previous-focus", {
    preMount(setup) {
      external = new core.BoxRenderable(setup.renderer, { id: "external-focus", width: 1, height: 1, focusable: true });
      setup.renderer.root.add(external);
      external.focus();
      setup.renderer.focusRenderable(external);
    }
  });
  if (!external) throw new Error("missing external focus");
  try {
    const answer = harness.broker.ask(request(2));
    await harness.setup.flush();
    harness.testKeymap.dispatch("question.next");
    await harness.setup.flush();
    harness.testKeymap.dispatch("question.next-page");
    await harness.setup.flush();
    harness.setup.resize(60, 28);
    await harness.setup.flush();
    harness.controller.destroy();
    const dismissed = await settled(answer, harness.setup);
    const externallyFocused = harness.setup.renderer.currentFocusedRenderable === external;
    return { externalAlive: !external.isDestroyed, currentFocusIsExternal: externallyFocused, externalFocused: externallyFocused, dismissed };
  } finally {
    harness.destroy();
  }
}

async function focusScenario(): Promise<Record<string, unknown>> {
  const harness = await createQuestionSurfaceHarness("focus");
  try {
    harness.broker.ask(request(2, [0]));
    await harness.setup.flush();
    const initialId = focusedId(harness.setup);
    harness.testKeymap.dispatch("question.activate");
    await harness.setup.flush();
    harness.testKeymap.dispatch("question.next-focus");
    await harness.setup.flush();
    const customId = focusedId(harness.setup);
    harness.testKeymap.dispatch("question.next-focus");
    await harness.setup.flush();
    const simplifyId = focusedId(harness.setup);
    harness.testKeymap.dispatch("question.next-focus");
    await harness.setup.flush();
    const nextId = focusedId(harness.setup);
    harness.testKeymap.dispatch("question.activate");
    await harness.setup.flush();
    harness.testKeymap.dispatch("question.activate");
    await harness.setup.flush();
    harness.testKeymap.dispatch("question.next-focus");
    await harness.setup.flush();
    harness.testKeymap.dispatch("question.next-focus");
    await harness.setup.flush();
    const submitId = focusedId(harness.setup);
    harness.testKeymap.dispatch("question.next-focus");
    await harness.setup.flush();
    const cancelId = focusedId(harness.setup);
    harness.testKeymap.dispatch("question.previous-page");
    await harness.setup.flush();
    const roundTripId = focusedId(harness.setup);
    harness.testKeymap.dispatch("question.next-page");
    await harness.setup.flush();
    return { initialId, customId, simplifyId, nextId, submitId, cancelId, roundTripId, restoredId: focusedId(harness.setup), frame: harness.setup.captureCharFrame() };
  } finally {
    harness.destroy();
  }
}

async function validationScenario(): Promise<Record<string, unknown>> {
  const harness = await createQuestionSurfaceHarness("validation");
  try {
    const customAccepted = ` ${"x".repeat(1999)}`;
    const guidanceAccepted = `${"y".repeat(1999)} `;
    const invalidSuffixes = ["\n", "\u202E", "\u0001", "\u0085", " "];
    harness.broker.ask(request(3));
    await harness.setup.flush();
    harness.testKeymap.dispatch("question.next-page");
    harness.testKeymap.dispatch("question.next-page");
    harness.testKeymap.dispatch("question.next-focus");
    await harness.setup.flush();
    await harness.setup.mockInput.pasteBracketedText(customAccepted);
    await harness.setup.flush();
    const custom = await rejectedEditorSnapshots(harness.setup, "question-custom", invalidSuffixes);
    harness.testKeymap.dispatch("question.dismiss");
    harness.testKeymap.dispatch("question.next-page");
    await harness.setup.flush();
    await harness.setup.mockInput.pasteBracketedText(guidanceAccepted);
    await harness.setup.flush();
    const guidance = await rejectedEditorSnapshots(harness.setup, "question-guidance", invalidSuffixes);
    return {
      customAccepted,
      customPlainTexts: custom.plainTexts,
      customFocusIds: custom.focusIds,
      customFrames: custom.frames,
      guidanceAccepted,
      guidancePlainTexts: guidance.plainTexts,
      guidanceFocusIds: guidance.focusIds,
      guidanceFrames: guidance.frames
    };
  } finally {
    harness.destroy();
  }
}

async function repeatSimplifyScenario(): Promise<Record<string, unknown>> {
  const harness = await createQuestionSurfaceHarness("repeat-simplify");
  try {
    harness.broker.ask(request(3));
    await harness.setup.flush();
    harness.testKeymap.dispatch("question.simplify");
    await settleRender(harness.setup);
    harness.testKeymap.dispatch("question.simplify");
    await settleRender(harness.setup);
    harness.testKeymap.dispatch("question.next-focus");
    harness.testKeymap.dispatch("question.activate");
    await harness.setup.flush();
    harness.testKeymap.dispatch("question.simplify");
    await settleRender(harness.setup);
    const inputs = harness.simplifierInputs();
    return {
      questionTexts: inputs.map(input => input.questions.map(question => question.question)),
      noCustomOrGuidance: inputs.every(input => !("custom" in input) && !("guidance" in input))
    };
  } finally {
    harness.destroy();
  }
}

async function loadingScenario(): Promise<Record<string, unknown>> {
  const harness = await createQuestionSurfaceHarness("loading");
  try {
    const answer = harness.broker.ask(request(3));
    await harness.setup.flush();
    harness.testKeymap.dispatch("question.simplify");
    await harness.setup.flush();
    await click(harness.setup, "question-option-0");
    const activationResults = [harness.testKeymap.dispatch("question.activate"), harness.testKeymap.dispatch("question.activate")];
    const selectionFrame = harness.setup.captureCharFrame();
    harness.testKeymap.dispatch("question.next-focus");
    await harness.setup.flush();
    const cancelActivated = harness.testKeymap.dispatch("question.activate");
    return { activationResults, selectionFrame, cancelActivated, aborted: harness.aborted(), dismissed: await settled(answer, harness.setup) };
  } finally {
    harness.destroy();
  }
}

export async function renderQuestionSurfaceVisualScenario(mode: string): Promise<Record<string, unknown>> {
  if (mode === "previous-focus") return await previousFocusScenario();
  if (mode === "focus") return await focusScenario();
  if (mode === "validation") return await validationScenario();
  if (mode === "repeat-simplify") return await repeatSimplifyScenario();
  if (mode === "loading") return await loadingScenario();
  throw new Error(`unknown visual question mode: ${mode}`);
}
