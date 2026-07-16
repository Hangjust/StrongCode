import { isTerminalSafeQuestionDraft, parseQuestionResult, selectQuestionDisplayMode, type Question, type QuestionId, type QuestionOptionId, type QuestionRequest, type QuestionResult } from "../../questions/schema";
import type { Result } from "../../core/result";

export type SimplificationState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "simplified" }
  | { readonly kind: "error"; readonly message: string };

type SharedQuestionState = {
  readonly original: QuestionRequest;
  readonly display: QuestionRequest;
  readonly selections: ReadonlyMap<QuestionId, readonly QuestionOptionId[]>;
  readonly customDrafts: ReadonlyMap<QuestionId, string>;
  readonly guidance: string;
  readonly optionHighlights: ReadonlyMap<QuestionId, number>;
  readonly validationError: string | undefined;
  readonly simplification: SimplificationState;
  readonly showOriginalDisplay: boolean;
};

export type QuestionState = SharedQuestionState & (
  | { readonly mode: "compact"; readonly activeQuestionIndex: number }
  | { readonly mode: "tabbed"; readonly activeTabIndex: number }
);

function bounded(value: number, upperBound: number): number {
  return Math.max(0, Math.min(upperBound, value));
}

function activeQuestionIndex(state: QuestionState): number | undefined {
  return state.mode === "compact"
    ? state.activeQuestionIndex
    : state.activeTabIndex < state.original.questions.length ? state.activeTabIndex : undefined;
}

function activeDisplayQuestion(state: QuestionState): Question | undefined {
  const index = activeQuestionIndex(state);
  return index === undefined ? undefined : state.display.questions[index];
}

export function activeOptionHighlight(state: QuestionState): number {
  const question = activeDisplayQuestion(state);
  return question ? bounded(state.optionHighlights.get(question.id) ?? 0, question.options.length - 1) : 0;
}

function answered(state: QuestionState, question: Question): boolean {
  return (state.selections.get(question.id)?.length ?? 0) > 0 || (state.customDrafts.get(question.id)?.trim().length ?? 0) > 0;
}

function matchingIdentity(original: QuestionRequest, replacement: QuestionRequest): boolean {
  if (original.questions.length !== replacement.questions.length) return false;
  return original.questions.every((question, questionIndex) => {
    const candidate = replacement.questions[questionIndex];
    return candidate?.id === question.id
      && candidate.options.length === question.options.length
      && question.options.every((option, optionIndex) => candidate.options[optionIndex]?.id === option.id);
  });
}

export function createQuestionState(original: QuestionRequest): QuestionState {
  const shared: SharedQuestionState = {
    original,
    display: original,
    selections: new Map(),
    customDrafts: new Map(),
    guidance: "",
    optionHighlights: new Map(),
    validationError: undefined,
    simplification: { kind: "idle" },
    showOriginalDisplay: false
  };
  return selectQuestionDisplayMode(original.questions.length) === "compact"
    ? { ...shared, mode: "compact", activeQuestionIndex: 0 }
    : { ...shared, mode: "tabbed", activeTabIndex: 0 };
}

export function moveActiveTab(state: QuestionState, delta: -1 | 1 | number): QuestionState {
  switch (state.mode) {
    case "compact": {
      const index = bounded(state.activeQuestionIndex + delta, state.original.questions.length - 1);
      return { ...state, activeQuestionIndex: index };
    }
    case "tabbed": {
      const index = bounded(state.activeTabIndex + delta, state.original.questions.length);
      return { ...state, activeTabIndex: index };
    }
  }
}

export function moveOptionHighlight(state: QuestionState, delta: number): QuestionState {
  const question = activeDisplayQuestion(state);
  if (!question) return state;
  const optionHighlights = new Map(state.optionHighlights);
  optionHighlights.set(question.id, bounded(activeOptionHighlight(state) + delta, question.options.length - 1));
  return { ...state, optionHighlights };
}

export function selectOption(state: QuestionState, questionId: QuestionId, optionId: QuestionOptionId): QuestionState {
  const question = state.original.questions.find(candidate => candidate.id === questionId);
  if (!question || !question.options.some(option => option.id === optionId)) return state;
  const selected = state.selections.get(questionId) ?? [];
  const next = question.multiple
    ? selected.includes(optionId)
      ? selected.filter(id => id !== optionId)
      : question.options.filter(option => selected.includes(option.id) || option.id === optionId).map(option => option.id)
    : [optionId];
  const selections = new Map(state.selections);
  selections.set(questionId, next);
  return { ...state, selections };
}

export function setCustomDraft(state: QuestionState, questionId: QuestionId, draft: string): QuestionState {
  const question = state.original.questions.find(candidate => candidate.id === questionId);
  if (!question?.allowCustom) return state;
  if (!isTerminalSafeQuestionDraft(draft)) return { ...state, validationError: "Custom answers must be one line." };
  if (draft === (state.customDrafts.get(questionId) ?? "") && state.validationError) return state;
  const customDrafts = new Map(state.customDrafts);
  if (draft) customDrafts.set(questionId, draft);
  else customDrafts.delete(questionId);
  return { ...state, customDrafts, validationError: undefined };
}

export function setGuidance(state: QuestionState, guidance: string): QuestionState {
  if (state.mode !== "tabbed" || state.activeTabIndex !== state.original.questions.length) return state;
  return !isTerminalSafeQuestionDraft(guidance)
    ? { ...state, validationError: "Guidance must be one line." }
    : guidance === state.guidance && state.validationError
      ? state
    : { ...state, guidance, validationError: undefined };
}

export function canSubmit(state: QuestionState): boolean {
  return state.original.questions.every(question => answered(state, question));
}

export function buildResult(state: QuestionState): Result<QuestionResult> {
  const answers = state.original.questions.map(question => {
    const selected = state.selections.get(question.id) ?? [];
    const customAnswer = state.customDrafts.get(question.id)?.trim();
    return {
      questionId: question.id,
      question: question.question,
      selections: question.options
        .filter(option => selected.includes(option.id))
        .map(option => ({ optionId: option.id, optionLabel: option.label })),
      ...(customAnswer ? { customAnswer } : {})
    };
  });
  return parseQuestionResult({
    outcome: "answered",
    answers,
    ...(state.mode === "tabbed" && state.guidance ? { guidance: state.guidance } : {})
  });
}

export function dismiss(): QuestionResult {
  return { outcome: "dismissed" };
}

export function startSimplification(state: QuestionState): QuestionState {
  return { ...state, simplification: { kind: "loading" } };
}

export function applySimplifiedDisplay(state: QuestionState, display: QuestionRequest): QuestionState {
  if (state.simplification.kind !== "loading" || !matchingIdentity(state.original, display)) {
    return { ...state, simplification: { kind: "error", message: "Simplified questions did not preserve stable IDs and counts" } };
  }
  return { ...state, display, simplification: { kind: "simplified" } };
}

export function failSimplification(state: QuestionState, message: string): QuestionState {
  return { ...state, simplification: { kind: "error", message } };
}

export function toggleOriginalDisplay(state: QuestionState): QuestionState {
  return { ...state, showOriginalDisplay: !state.showOriginalDisplay };
}

export function selectDisplayedRequest(state: QuestionState): QuestionRequest {
  return state.showOriginalDisplay ? state.original : state.display;
}
