import { activeOptionHighlight, canSubmit, selectDisplayedRequest, type QuestionState } from "./state";
import { actionEnabled, focusRing } from "./interaction-model";
import type { QuestionActionFocus, QuestionSurfaceActions, QuestionSurfaceFocus } from "./interaction";
import {
  addQuestionAction,
  addQuestionTabs,
  addQuestionText,
  questionFooter,
  type QuestionControlContext,
  type QuestionRenderable,
} from "./question-controls";

export interface QuestionSurfaceViewOptions {
  readonly core: QuestionControlContext["core"];
  readonly renderer: QuestionControlContext["renderer"];
  readonly theme: QuestionControlContext["theme"];
  readonly state: QuestionState;
  readonly focus: QuestionSurfaceFocus;
  readonly actions: QuestionSurfaceActions;
}

export interface QuestionSurfaceView {
  readonly focusable: QuestionRenderable;
}

const PRIVACY = "Simplify sends the visible questions and options to DeepSeek. Do not enter secrets.";

function activeIndex(state: QuestionState): number | undefined {
  return state.mode === "compact"
    ? state.activeQuestionIndex
    : state.activeTabIndex < state.original.questions.length ? state.activeTabIndex : undefined;
}

function addQuestion(options: QuestionSurfaceViewOptions, body: InstanceType<QuestionControlContext["core"]["ScrollBoxRenderable"]>): QuestionRenderable | undefined {
  const { core, renderer, theme, state, focus, actions } = options;
  const context = { core, renderer, theme };
  const index = activeIndex(state);
  if (index === undefined) return undefined;
  const display = selectDisplayedRequest(state);
  const question = display.questions[index];
  const original = state.original.questions[index];
  if (!question || !original) return undefined;
  addQuestionText(context, body, { content: `${state.mode === "compact" ? `Question ${index + 1} of ${state.original.questions.length}: ` : ""}${question.header}` });
  addQuestionText(context, body, { content: question.question });
  let focusable: QuestionRenderable | undefined;
  question.options.forEach((option, optionIndex) => {
    const selected = state.selections.get(question.id)?.includes(option.id) === true;
    const highlighted = activeOptionHighlight(state) === optionIndex;
    const background = highlighted ? theme.element : theme.panel;
    const row = new core.BoxRenderable(renderer, {
      id: `question-option-${optionIndex}`,
      width: "100%",
      minHeight: 1,
      flexDirection: "column",
      paddingLeft: 1,
      backgroundColor: background,
      onMouseOver: () => actions.highlightOption(optionIndex),
      onMouseDown: event => { if (event.button === 0) actions.selectOption(optionIndex); }
    });
    row.add(new core.TextRenderable(renderer, { content: `${highlighted ? ">" : " "} [${selected ? "x" : " "}] ${optionIndex + 1}. ${option.label}`, fg: highlighted ? theme.primary : theme.text, bg: background, width: "100%", height: 1, wrapMode: "none" }));
    if (option.description) row.add(new core.TextRenderable(renderer, { content: `   ${option.description}`, fg: theme.muted, bg: background, width: "100%", height: "auto", wrapMode: "word" }));
    body.add(row);
    if (highlighted && focus === "option") focusable = row;
  });
  if (!original.allowCustom) return focusable;
  const customAction = new core.BoxRenderable(renderer, {
    id: "question-custom-action",
    width: "100%",
    height: 1,
    onMouseDown: event => { if (event.button === 0) actions.setFocus("custom"); }
  });
  customAction.add(new core.TextRenderable(renderer, { content: "Custom answer", fg: theme.muted, bg: theme.panel, height: 1, onMouseDown: event => { if (event.button === 0) actions.setFocus("custom"); } }));
  body.add(customAction);
  const editor = new core.TextareaRenderable(renderer, {
    id: "question-custom",
    width: "100%",
    height: 2,
    initialValue: state.customDrafts.get(original.id) ?? "",
    placeholder: "Type a custom answer",
    placeholderColor: theme.muted,
    backgroundColor: theme.element,
    textColor: theme.text,
    focusedBackgroundColor: theme.element,
    focusedTextColor: theme.text,
    wrapMode: "word",
    onMouseDown: () => actions.setFocus("custom"),
    onContentChange: () => actions.setCustom(editor.plainText)
  });
  body.add(editor);
  return focus === "custom" ? editor : focusable;
}

function addConfirm(options: QuestionSurfaceViewOptions, body: InstanceType<QuestionControlContext["core"]["ScrollBoxRenderable"]>): QuestionRenderable | undefined {
  const { core, renderer, theme, state, focus, actions } = options;
  const context = { core, renderer, theme };
  addQuestionText(context, body, { content: "Confirm answers" });
  state.original.questions.forEach((question, index) => {
    const selected = state.selections.get(question.id) ?? [];
    const labels = question.options.filter(option => selected.includes(option.id)).map(option => option.label);
    const custom = state.customDrafts.get(question.id)?.trim();
    addQuestionText(context, body, {
      content: `${index + 1}. ${labels.length > 0 ? labels.join(", ") : custom || "Unanswered"}${custom && labels.length > 0 ? `; ${custom}` : ""}`,
      muted: labels.length === 0 && !custom
    });
  });
  addQuestionText(context, body, { content: "Guidance (optional)", muted: true });
  const guidance = new core.TextareaRenderable(renderer, {
    id: "question-guidance",
    width: "100%",
    height: 2,
    initialValue: state.guidance,
    placeholder: "Add optional guidance",
    placeholderColor: theme.muted,
    backgroundColor: theme.element,
    textColor: theme.text,
    focusedBackgroundColor: theme.element,
    focusedTextColor: theme.text,
    wrapMode: "word",
    onMouseDown: () => actions.setFocus("guidance"),
    onContentChange: () => actions.setGuidance(guidance.plainText)
  });
  body.add(guidance);
  return focus === "guidance" ? guidance : undefined;
}

export function renderQuestionSurface(options: QuestionSurfaceViewOptions): QuestionSurfaceView {
  const { core, renderer, theme, state, focus, actions } = options;
  const context = { core, renderer, theme };
  const layer = new core.BoxRenderable(renderer, { id: "question-layer", position: "absolute", top: 0, left: 0, width: "100%", height: "100%", alignItems: "center", justifyContent: "center", zIndex: 500 });
  renderer.root.add(new core.BoxRenderable(renderer, { id: "question-backdrop", position: "absolute", top: 0, left: 0, width: "100%", height: "100%", backgroundColor: theme.background, opacity: 0.8, zIndex: 499 }));
  renderer.root.add(layer);
  const panel = new core.BoxRenderable(renderer, { id: "question-panel", width: "100%", maxWidth: 100, height: "100%", maxHeight: 24, flexDirection: "column", backgroundColor: theme.panel, border: ["left"], borderColor: theme.border, paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1, focusable: true, overflow: "hidden" });
  layer.add(panel);
  addQuestionText(context, panel, { content: "Questions" });
  addQuestionTabs(context, panel, state, actions);
  const body = new core.ScrollBoxRenderable(renderer, { width: "100%", height: 1, flexGrow: 1, flexShrink: 1, minHeight: 1, scrollY: true, scrollbarOptions: { visible: false }, backgroundColor: theme.panel });
  panel.add(body);
  const questionFocus = state.mode === "tabbed" && activeIndex(state) === undefined ? addConfirm(options, body) : addQuestion(options, body);
  if (state.simplification.kind === "loading") addQuestionText(context, body, { content: "Simplifying...", muted: true });
  if (state.simplification.kind === "simplified") addQuestionText(context, body, { content: "Simplified", muted: true });
  if (state.simplification.kind === "error") {
    addQuestionText(context, body, { content: state.simplification.message, id: "question-simplification-error", color: theme.warning });
  }
  if (state.validationError) addQuestionText(context, panel, { content: state.validationError, id: "question-validation-error", color: theme.warning });
  addQuestionText(context, panel, { content: PRIVACY, muted: true });
  const compactControls = state.mode === "compact" && renderer.width < 80;
  const actionsRow = new core.BoxRenderable(renderer, {
    id: "question-actions",
    width: "100%",
    height: 1,
    flexDirection: "row",
    gap: compactControls ? 1 : 0,
    backgroundColor: theme.panel,
    overflow: "hidden"
  });
  panel.add(actionsRow);
  let actionFocus: QuestionRenderable | undefined;
  const addSurfaceAction = (action: QuestionActionFocus, label: string): void => {
    if (!focusRing(state).includes(action)) return;
    const focused = focus === action;
    const actionRow = addQuestionAction(context, actionsRow, {
      id: `question-${action}`,
      label: focused ? `> ${label}` : label,
      highlighted: focused,
      disabled: !actionEnabled(action, state),
      compact: compactControls,
      onClick: () => actions.activateAction(action)
    });
    if (focused) actionFocus = actionRow;
  };
  addSurfaceAction("original", compactControls ? "Original" : state.showOriginalDisplay ? "Show simplified" : "Show original");
  addSurfaceAction("simplify", state.simplification.kind === "loading" ? "Simplifying..." : "F3 Simplify");
  addSurfaceAction("next", "Next");
  addSurfaceAction("submit", canSubmit(state) ? "Submit" : "Submit (answer all)");
  addSurfaceAction("cancel", "Cancel");
  addQuestionText(context, panel, { content: questionFooter(state, renderer.width), muted: true, id: "question-footer", wrapMode: "none" });
  return { focusable: actionFocus ?? questionFocus ?? panel };
}
