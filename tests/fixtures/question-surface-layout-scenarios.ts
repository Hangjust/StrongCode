import * as core from "@opentui/core";
import { parseQuestionRequest, type QuestionRequest } from "../../src/questions/schema";
import { defaultTuiConfig } from "../../src/tui/config/tui";
import { createQuestionSurfaceHarness, request, type QuestionSurfaceFixtureSetup } from "./question-surface-support";

const LAYOUT_MODES = ["layout", "warning", "wide"];

type Bounds = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

export function isQuestionSurfaceLayoutMode(mode: string): boolean {
  return LAYOUT_MODES.includes(mode);
}

function bounds(renderable: core.Renderable | undefined): Bounds | undefined {
  return renderable ? { x: renderable.x, y: renderable.y, width: renderable.width, height: renderable.height } : undefined;
}

function textInfo(renderable: core.Renderable | undefined, warning: string): { readonly text: string; readonly warningTone: boolean } | undefined {
  if (!(renderable instanceof core.TextRenderable)) return undefined;
  return { text: renderable.plainText, warningTone: renderable.fg.equals(core.RGBA.fromHex(warning)) };
}

function visibleLine(frame: string, text: string): string | undefined {
  return frame.split(/\r?\n/).find(line => line.includes(text));
}

function spanWidth(setup: QuestionSurfaceFixtureSetup, text: string): number | undefined {
  return setup.captureSpans().lines.flatMap(line => line.spans).find(span => span.text.includes(text))?.width;
}

function wideRequest(): QuestionRequest {
  const parsed = parseQuestionRequest({
    questions: ["설정⚙️", "배포🚀", "검토🧪"].map((header, index) => ({
      id: `wide-${index + 1}`,
      header,
      question: `${header}에서 무엇을 선택할까요?`,
      multiple: false,
      options: [{ id: `wide-${index + 1}-a`, label: "🚀 빠른 선택" }, { id: `wide-${index + 1}-b`, label: "🧪 안전 선택" }]
    }))
  });
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

async function layoutScenario(): Promise<Record<string, unknown>> {
  const harness = await createQuestionSurfaceHarness("layout");
  try {
    harness.broker.ask(request(2));
    await harness.setup.flush();
    harness.setup.mockInput.pressKey("F3");
    await new Promise<void>(resolve => setImmediate(resolve));
    await harness.setup.flush();
    harness.setup.resize(60, 28);
    await harness.setup.flush();
    const frame = harness.setup.captureCharFrame();
    const simplify = bounds(harness.setup.renderer.root.findDescendantById("question-simplify"));
    const next = bounds(harness.setup.renderer.root.findDescendantById("question-next"));
    const submit = bounds(harness.setup.renderer.root.findDescendantById("question-submit"));
    const cancel = bounds(harness.setup.renderer.root.findDescendantById("question-cancel"));
    const controls = [simplify, next, submit, cancel];
    const actionsShareRow = controls.every(control => control !== undefined && control.y === simplify?.y && control.height > 0);
    const actionsNonOverlapping = controls.every((control, index) => !control || index === controls.length - 1 || control.x + control.width <= (controls[index + 1]?.x ?? 0));
    const footer = textInfo(harness.setup.renderer.root.findDescendantById("question-footer"), defaultTuiConfig().theme.warning);
    return {
      frame,
      actionLine: visibleLine(frame, "F3 Simplify"),
      simplify,
      next,
      submit,
      cancel,
      actionsRow: bounds(harness.setup.renderer.root.findDescendantById("question-actions")),
      footer: footer ? { ...footer, bounds: bounds(harness.setup.renderer.root.findDescendantById("question-footer")) } : undefined,
      actionsShareRow,
      actionsNonOverlapping
    };
  } finally {
    harness.destroy();
  }
}

async function warningScenario(): Promise<Record<string, unknown>> {
  const simplification = await createQuestionSurfaceHarness("error");
  try {
    simplification.broker.ask(request(3));
    await simplification.setup.flush();
    simplification.setup.mockInput.pressKey("F3");
    await simplification.setup.flush();
    const theme = defaultTuiConfig().theme;
    const simplificationError = textInfo(simplification.setup.renderer.root.findDescendantById("question-simplification-error"), theme.warning);
    const validation = await createQuestionSurfaceHarness("warning");
    try {
      validation.broker.ask(request(3));
      await validation.setup.flush();
      validation.testKeymap.dispatch("question.next-page");
      validation.testKeymap.dispatch("question.next-page");
      validation.testKeymap.dispatch("question.next-focus");
      await validation.setup.flush();
      await validation.setup.mockInput.pasteBracketedText("\ninvalid");
      await validation.setup.flush();
      return {
        simplificationError,
        validationError: textInfo(validation.setup.renderer.root.findDescendantById("question-validation-error"), theme.warning)
      };
    } finally {
      validation.destroy();
    }
  } finally {
    simplification.destroy();
  }
}

async function wideScenario(): Promise<Record<string, unknown>> {
  const harness = await createQuestionSurfaceHarness("wide");
  try {
    harness.broker.ask(wideRequest());
    await harness.setup.flush();
    const tab0 = bounds(harness.setup.renderer.root.findDescendantById("question-tab-0"));
    const tab1 = bounds(harness.setup.renderer.root.findDescendantById("question-tab-1"));
    const tab2 = bounds(harness.setup.renderer.root.findDescendantById("question-tab-2"));
    const confirm = bounds(harness.setup.renderer.root.findDescendantById("question-confirm"));
    const option0 = bounds(harness.setup.renderer.root.findDescendantById("question-option-0"));
    const option1 = bounds(harness.setup.renderer.root.findDescendantById("question-option-1"));
    const cjkTabSpanWidth = spanWidth(harness.setup, "설정⚙️");
    const confirmTextVisible = visibleLine(harness.setup.captureCharFrame(), "Confirm") !== undefined;
    const tabBounds = [tab0, tab1, tab2, confirm];
    const tabsNonOverlapping = tabBounds.every((tab, index) => !tab || index === tabBounds.length - 1 || tab.x + tab.width <= (tabBounds[index + 1]?.x ?? 0));
    return {
      frame: harness.setup.captureCharFrame(),
      tab0,
      tab1,
      tab2,
      confirm,
      option0,
      option1,
      cjkTabSpanWidth,
      cjkTabFits: tab0 !== undefined && cjkTabSpanWidth !== undefined && tab0.width >= cjkTabSpanWidth,
      tabsNonOverlapping,
      confirmFits: confirm !== undefined && confirmTextVisible,
      confirmVisible: confirm !== undefined && confirm.x + confirm.width <= harness.setup.renderer.width,
      optionMarkersAligned: option0 !== undefined && option1 !== undefined && option0.x === option1.x,
      hasReplacementGlyph: harness.setup.captureCharFrame().includes("�")
    };
  } finally {
    harness.destroy();
  }
}

export async function renderQuestionSurfaceLayoutScenario(mode: string): Promise<Record<string, unknown>> {
  if (mode === "layout") return await layoutScenario();
  if (mode === "warning") return await warningScenario();
  if (mode === "wide") return await wideScenario();
  throw new Error(`unknown layout question mode: ${mode}`);
}
