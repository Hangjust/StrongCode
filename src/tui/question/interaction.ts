import { activeOptionHighlight, canSubmit, moveActiveTab, moveOptionHighlight, selectOption, setCustomDraft, setGuidance, toggleOriginalDisplay, type QuestionState } from "./state";
import type { QuestionKeyActions } from "./keymap";
import { actionEnabled, activeQuestion, defaultFocus, focusEnabled, focusRing, isActionFocus, isConfirmPage, pageIndex } from "./interaction-model";
import type { QuestionActionFocus, QuestionSurfaceFocus } from "./interaction-model";

export type { QuestionActionFocus, QuestionSurfaceFocus } from "./interaction-model";

export interface QuestionSurfaceActions {
  readonly selectOption: (index: number) => void; readonly highlightOption: (index: number) => void;
  readonly moveQuestion: (delta: -1 | 1) => void; readonly selectTab: (index: number) => void;
  readonly setCustom: (value: string) => void; readonly setGuidance: (value: string) => void;
  readonly submit: () => void; readonly dismiss: () => void; readonly simplify: () => void;
  readonly toggleOriginal: () => void; readonly setFocus: (focus: QuestionSurfaceFocus) => void;
  readonly activateAction: (focus: QuestionActionFocus) => boolean; readonly resize: () => void;
}

export interface QuestionSurfaceInteractionHost {
  readonly currentState: () => QuestionState | undefined; readonly replaceState: (state: QuestionState) => void;
  readonly rerender: () => void; readonly settleAnswer: () => void; readonly settleDismissal: () => void;
  readonly simplify: () => Promise<void>; readonly hasPending: () => boolean;
}

export interface QuestionSurfaceInteraction {
  readonly actions: QuestionSurfaceActions; readonly keyActions: QuestionKeyActions & { readonly enter: () => boolean; readonly space: () => boolean };
  readonly focus: () => QuestionSurfaceFocus; readonly resetFocus: () => void;
}

export function createQuestionSurfaceInteraction(host: QuestionSurfaceInteractionHost): QuestionSurfaceInteraction {
  const rememberedFocus = new Map<number, QuestionSurfaceFocus>();
  let focus: QuestionSurfaceFocus = "option";
  let escapeArmed = false;

  function disarmEscape(): void { escapeArmed = false; }

  function rememberCurrentFocus(state: QuestionState): void {
    rememberedFocus.set(pageIndex(state), focus);
  }

  function restorePageFocus(state: QuestionState): void {
    const remembered = rememberedFocus.get(pageIndex(state));
    focus = remembered && focusEnabled(remembered, state) ? remembered : defaultFocus(state);
  }

  function moveToPage(delta: number): boolean {
    const state = host.currentState();
    if (!state) return false;
    disarmEscape();
    rememberCurrentFocus(state);
    const next = moveActiveTab(state, delta);
    host.replaceState(next);
    restorePageFocus(next);
    host.rerender();
    return true;
  }

  function movePage(delta: -1 | 1): boolean {
    return focus === "custom" || focus === "guidance" ? false : moveToPage(delta);
  }

  function moveFocus(delta: -1 | 1): boolean {
    const state = host.currentState();
    if (!state) return false;
    const ring = focusRing(state);
    const current = ring.indexOf(focus);
    for (let step = 1; step <= ring.length; step += 1) {
      const candidate = ring[(current + delta * step + ring.length * 2) % ring.length];
      if (candidate && focusEnabled(candidate, state)) {
        disarmEscape();
        focus = candidate;
        rememberCurrentFocus(state);
        host.rerender();
        return true;
      }
    }
    return false;
  }

  function selectOptionAction(index: number): void {
    const state = host.currentState();
    const question = state ? activeQuestion(state) : undefined;
    const option = question?.options[index];
    if (!state || !question || !option || state.simplification.kind === "loading") return;
    disarmEscape();
    const next = selectOption(state, question.id, option.id);
    host.replaceState(next);
    if (next.original.questions.length === 1 && !question.multiple && canSubmit(next)) host.settleAnswer();
    else host.rerender();
  }

  function highlightOptionAction(index: number): void {
    const state = host.currentState();
    if (!state || activeOptionHighlight(state) === index) return;
    disarmEscape();
    host.replaceState(moveOptionHighlight(state, index - activeOptionHighlight(state)));
    host.rerender();
  }

  function moveQuestionAction(delta: -1 | 1): void {
    void moveToPage(delta);
  }

  function selectTabAction(index: number): void {
    const state = host.currentState();
    if (!state) return;
    void moveToPage(index - pageIndex(state));
  }

  function setCustomAction(value: string): void {
    const state = host.currentState();
    const question = state ? activeQuestion(state) : undefined;
    if (!state || !question) return;
    const next = setCustomDraft(state, question.id, value);
    host.replaceState(next);
    if ((next.customDrafts.get(question.id) ?? "") !== value || next.validationError !== state.validationError) host.rerender();
  }

  function setGuidanceAction(value: string): void {
    const state = host.currentState();
    if (!state) return;
    const next = setGuidance(state, value);
    host.replaceState(next);
    if (next.guidance !== value || next.validationError !== state.validationError) host.rerender();
  }

  function toggleOriginalAction(): void {
    const state = host.currentState();
    if (!state || state.simplification.kind === "loading") return;
    disarmEscape();
    host.replaceState(toggleOriginalDisplay(state));
    host.rerender();
  }

  function selectHighlighted(): boolean {
    const state = host.currentState();
    const question = state ? activeQuestion(state) : undefined;
    const option = question?.options[state ? activeOptionHighlight(state) : -1];
    if (!state || !question || !option || state.simplification.kind === "loading") return false;
    disarmEscape();
    const next = selectOption(state, question.id, option.id);
    host.replaceState(next);
    if (next.original.questions.length === 1 && !question.multiple && canSubmit(next)) host.settleAnswer();
    else host.rerender();
    return true;
  }

  function submitFromKeyboard(): boolean {
    const state = host.currentState();
    if (!state || !canSubmit(state) || state.simplification.kind === "loading") return false;
    host.settleAnswer();
    return true;
  }

  function activateAction(action: QuestionActionFocus): boolean {
    const state = host.currentState();
    if (!state || !actionEnabled(action, state)) return false;
    disarmEscape();
    if (action === "original") {
      toggleOriginalAction();
      return true;
    }
    if (action === "simplify") {
      void host.simplify();
      return true;
    }
    if (action === "next") return movePage(1);
    if (action === "submit") return submitFromKeyboard();
    host.settleDismissal();
    return true;
  }

  function activate(): boolean {
    if (focus === "custom" || focus === "guidance") return false;
    return focus === "option" ? selectHighlighted() : activateAction(focus);
  }

  function setFocus(next: QuestionSurfaceFocus): void {
    const state = host.currentState();
    if (!state || !focusEnabled(next, state) || focus === next) return;
    disarmEscape();
    focus = next;
    rememberCurrentFocus(state);
    host.rerender();
  }

  function escape(): boolean {
    if (!host.hasPending()) return false;
    if (escapeArmed) {
      escapeArmed = false;
      host.settleDismissal();
      return true;
    }
    const state = host.currentState();
    if (focus === "custom") focus = "option";
    else if (focus === "guidance" && state) focus = focusRing(state).find(candidate => isActionFocus(candidate) && focusEnabled(candidate, state)) ?? "cancel";
    else if (isActionFocus(focus) && state) focus = defaultFocus(state);
    else {
      host.settleDismissal();
      return true;
    }
    escapeArmed = true;
    if (state) rememberCurrentFocus(state);
    host.rerender();
    return true;
  }

  return {
    actions: {
      selectOption: selectOptionAction,
      highlightOption: highlightOptionAction,
      moveQuestion: moveQuestionAction,
      selectTab: selectTabAction,
      setCustom: setCustomAction,
      setGuidance: setGuidanceAction,
      submit: host.settleAnswer,
      dismiss: host.settleDismissal,
      simplify: () => { disarmEscape(); void host.simplify(); },
      toggleOriginal: toggleOriginalAction,
      setFocus,
      activateAction,
      resize: host.rerender
    },
    keyActions: {
      previous: () => {
        const state = host.currentState();
        if (!state || focus !== "option" || isConfirmPage(state)) return false;
        disarmEscape();
        host.replaceState(moveOptionHighlight(state, -1));
        host.rerender();
        return true;
      },
      next: () => {
        const state = host.currentState();
        if (!state || focus !== "option" || isConfirmPage(state)) return false;
        disarmEscape();
        host.replaceState(moveOptionHighlight(state, 1));
        host.rerender();
        return true;
      },
      previousPage: () => movePage(-1),
      nextPage: () => movePage(1),
      previousFocus: () => moveFocus(-1),
      nextFocus: () => moveFocus(1),
      activate,
      enter: activate,
      space: activate,
      submit: submitFromKeyboard,
      simplify: () => activateAction("simplify"),
      dismiss: escape
    },
    focus: () => focus,
    resetFocus: () => { rememberedFocus.clear(); escapeArmed = false; focus = "option"; }
  };
}
