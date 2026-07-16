import { canSubmit, type QuestionState } from "./state";

export type QuestionActionFocus = "original" | "simplify" | "next" | "submit" | "cancel";
export type QuestionSurfaceFocus = "option" | "custom" | "guidance" | QuestionActionFocus;

export function pageIndex(state: QuestionState): number {
  return state.mode === "compact" ? state.activeQuestionIndex : state.activeTabIndex;
}

export function isConfirmPage(state: QuestionState): boolean {
  return state.mode === "tabbed" && state.activeTabIndex === state.original.questions.length;
}

export function activeQuestion(state: QuestionState) {
  const index = pageIndex(state);
  return index < state.original.questions.length ? state.original.questions[index] : undefined;
}

export function isActionFocus(candidate: QuestionSurfaceFocus): candidate is QuestionActionFocus {
  return candidate === "original" || candidate === "simplify" || candidate === "next" || candidate === "submit" || candidate === "cancel";
}

export function actionEnabled(action: QuestionActionFocus, state: QuestionState): boolean {
  return {
    original: state.simplification.kind === "simplified",
    simplify: state.simplification.kind !== "loading",
    next: state.mode === "compact" && state.activeQuestionIndex < state.original.questions.length - 1 && state.simplification.kind !== "loading",
    submit: canSubmit(state) && state.simplification.kind !== "loading",
    cancel: true
  }[action];
}

export function focusRing(state: QuestionState): readonly QuestionSurfaceFocus[] {
  const ring: QuestionSurfaceFocus[] = isConfirmPage(state) ? ["guidance"] : ["option"];
  if (!isConfirmPage(state) && activeQuestion(state)?.allowCustom) ring.push("custom");
  if (state.simplification.kind === "simplified") ring.push("original");
  ring.push("simplify");
  if (state.mode === "compact" && state.activeQuestionIndex < state.original.questions.length - 1) ring.push("next");
  ring.push("submit", "cancel");
  return ring;
}

export function defaultFocus(state: QuestionState): QuestionSurfaceFocus {
  return isConfirmPage(state) ? "guidance" : "option";
}

export function focusEnabled(candidate: QuestionSurfaceFocus, state: QuestionState): boolean {
  return focusRing(state).includes(candidate) && (!isActionFocus(candidate) || actionEnabled(candidate, state));
}
