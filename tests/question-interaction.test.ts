import { parseQuestionRequest, type QuestionRequest } from "../src/questions/schema";
import { createQuestionSurfaceInteraction, type QuestionSurfaceInteraction, type QuestionSurfaceInteractionHost } from "../src/tui/question/interaction";
import { createQuestionState, selectOption, startSimplification, type QuestionState } from "../src/tui/question/state";

type TestHost = {
  readonly host: QuestionSurfaceInteractionHost;
  readonly current: () => QuestionState | undefined;
  readonly replace: (next: QuestionState) => void;
  readonly calls: { rerenders: number; answers: number; dismissals: number; simplifications: number };
};

function request(count: number, customIndexes: readonly number[] = [0]): QuestionRequest {
  const parsed = parseQuestionRequest({
    questions: Array.from({ length: count }, (_, index) => ({
      id: `question-${index + 1}`,
      header: `Topic ${index + 1}`,
      question: `Which choice fits topic ${index + 1}?`,
      allowCustom: customIndexes.includes(index),
      options: [
        { id: `option-${index + 1}-a`, label: "First choice" },
        { id: `option-${index + 1}-b`, label: "Second choice" }
      ]
    }))
  });
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

function answeredState(source: QuestionRequest): QuestionState {
  let state = createQuestionState(source);
  for (const question of source.questions) {
    const option = question.options[0];
    if (!option) throw new Error("question fixture is incomplete");
    state = selectOption(state, question.id, option.id);
  }
  return state;
}

function createHost(initial: QuestionState): TestHost {
  let state: QuestionState | undefined = initial;
  const calls = { rerenders: 0, answers: 0, dismissals: 0, simplifications: 0 };
  return {
    host: {
      currentState: () => state,
      replaceState(next) { state = next; },
      rerender() { calls.rerenders += 1; },
      settleAnswer() { calls.answers += 1; },
      settleDismissal() { calls.dismissals += 1; },
      async simplify() { calls.simplifications += 1; },
      hasPending: () => true
    },
    current: () => state,
    replace(next) { state = next; },
    calls
  };
}

function activeState(host: TestHost): QuestionState {
  const state = host.current();
  if (!state) throw new Error("question state unexpectedly disappeared");
  return state;
}

describe("question interaction", () => {
  it("traverses and wraps the enabled question-page focus ring", () => {
    // Given
    const host = createHost(answeredState(request(2)));
    const interaction = createQuestionSurfaceInteraction(host.host);

    // When
    interaction.keyActions.nextFocus();
    const custom = interaction.focus();
    interaction.keyActions.nextFocus();
    const simplify = interaction.focus();
    interaction.keyActions.nextFocus();
    const next = interaction.focus();
    interaction.keyActions.nextFocus();
    const submit = interaction.focus();
    interaction.keyActions.nextFocus();
    const cancel = interaction.focus();
    interaction.keyActions.nextFocus();
    interaction.keyActions.previousFocus();

    // Then
    expect([custom, simplify, next, submit, cancel, interaction.focus()])
      .toEqual(["custom", "simplify", "next", "submit", "cancel", "cancel"]);
  });

  it("starts Confirm on guidance and traverses its enabled ring", () => {
    // Given
    const host = createHost(answeredState(request(3)));
    const interaction = createQuestionSurfaceInteraction(host.host);

    // When
    interaction.keyActions.nextPage();
    interaction.keyActions.nextPage();
    interaction.keyActions.nextPage();
    const guidance = interaction.focus();
    interaction.keyActions.nextFocus();
    const simplify = interaction.focus();
    interaction.keyActions.nextFocus();
    const submit = interaction.focus();
    interaction.keyActions.nextFocus();
    const cancel = interaction.focus();

    // Then
    expect([guidance, simplify, submit, cancel]).toEqual(["guidance", "simplify", "submit", "cancel"]);
  });

  it("skips unavailable Next and disabled busy or submit actions", () => {
    // Given
    const host = createHost(createQuestionState(request(3, [])));
    const interaction = createQuestionSurfaceInteraction(host.host);

    // When
    interaction.keyActions.nextPage();
    interaction.keyActions.nextPage();
    interaction.keyActions.nextFocus();
    host.replace(startSimplification(activeState(host)));
    interaction.keyActions.nextFocus();

    // Then
    expect(interaction.focus()).toBe("cancel");
  });

  it("restores Custom and falls back from a remembered disabled Submit", () => {
    // Given
    const compactHost = createHost(createQuestionState(request(2, [0])));
    const compact = createQuestionSurfaceInteraction(compactHost.host);
    compact.actions.setFocus("custom");
    const tabbedRequest = request(3);
    const tabbedHost = createHost(answeredState(tabbedRequest));
    const tabbed = createQuestionSurfaceInteraction(tabbedHost.host);
    tabbed.actions.setFocus("submit");
    tabbedHost.replace(createQuestionState(tabbedRequest));

    // When
    compact.keyActions.nextPage();
    compact.keyActions.previousPage();
    tabbed.keyActions.nextPage();
    tabbed.keyActions.previousPage();

    // Then
    expect(compact.focus()).toBe("custom");
    expect(tabbed.focus()).toBe("option");
  });

  it("leaves Enter and Space with custom and guidance editors", () => {
    // Given
    const customHost = createHost(createQuestionState(request(3)));
    const custom = createQuestionSurfaceInteraction(customHost.host);
    custom.actions.setFocus("custom");
    const guidanceHost = createHost(answeredState(request(3)));
    const guidance = createQuestionSurfaceInteraction(guidanceHost.host);
    guidance.keyActions.nextPage();
    guidance.keyActions.nextPage();
    guidance.keyActions.nextPage();

    // When
    const handled = [custom.keyActions.enter(), custom.keyActions.space(), guidance.keyActions.enter(), guidance.keyActions.space()];

    // Then
    expect(handled).toEqual([false, false, false, false]);
    expect(activeState(customHost).selections.size).toBe(0);
  });

  it("uses Escape first to leave custom or guidance, then activates Cancel", () => {
    // Given
    const customHost = createHost(createQuestionState(request(3)));
    const custom = createQuestionSurfaceInteraction(customHost.host);
    custom.actions.setFocus("custom");
    const guidanceHost = createHost(answeredState(request(3)));
    const guidance = createQuestionSurfaceInteraction(guidanceHost.host);
    guidance.keyActions.nextPage();
    guidance.keyActions.nextPage();
    guidance.keyActions.nextPage();

    // When
    const firstEscape = [custom.keyActions.dismiss(), guidance.keyActions.dismiss()];
    const pageFocus = [custom.focus(), guidance.focus()];
    const secondEscape = [custom.keyActions.dismiss(), guidance.keyActions.dismiss()];

    // Then
    expect(firstEscape).toEqual([true, true]);
    expect(pageFocus).toEqual(["option", "simplify"]);
    expect(customHost.calls.dismissals).toBe(1);
    expect(guidanceHost.calls.dismissals).toBe(1);
    expect(secondEscape).toEqual([true, true]);
  });

  it("uses Escape first to leave a focused action before cancelling", () => {
    // Given
    const host = createHost(answeredState(request(2)));
    const interaction = createQuestionSurfaceInteraction(host.host);
    interaction.actions.setFocus("simplify");

    // When
    const firstEscape = interaction.keyActions.dismiss();
    const afterFirstEscape = { focus: interaction.focus(), dismissals: host.calls.dismissals };
    const secondEscape = interaction.keyActions.dismiss();

    // Then
    expect(firstEscape).toBe(true);
    expect(afterFirstEscape).toEqual({ focus: "option", dismissals: 0 });
    expect(secondEscape).toBe(true);
    expect(host.calls.dismissals).toBe(1);
  });

  it("rejects focus for disabled or unavailable actions while keeping Cancel focusable", () => {
    // Given
    const unansweredHost = createHost(createQuestionState(request(3)));
    const unanswered = createQuestionSurfaceInteraction(unansweredHost.host);
    const loadingHost = createHost(startSimplification(createQuestionState(request(3))));
    const loading = createQuestionSurfaceInteraction(loadingHost.host);

    // When
    unanswered.actions.setFocus("submit");
    const submitFocus = unanswered.focus();
    unanswered.actions.setFocus("next");
    const nextFocus = unanswered.focus();
    loading.actions.setFocus("simplify");
    const simplifyFocus = loading.focus();
    loading.actions.setFocus("cancel");

    // Then
    expect([submitFocus, nextFocus, simplifyFocus, loading.focus()])
      .toEqual(["option", "option", "option", "cancel"]);
  });

  it("rerenders when custom validation appears and clears", () => {
    // Given
    const host = createHost(createQuestionState(request(2)));
    const interaction = createQuestionSurfaceInteraction(host.host);

    // When
    interaction.actions.setCustom("Line one\nLine two");
    const invalid = activeState(host);
    const invalidRenders = host.calls.rerenders;
    interaction.actions.setCustom("Accepted");
    const valid = activeState(host);

    // Then
    expect(invalid.validationError).toBe("Custom answers must be one line.");
    expect(invalidRenders).toBe(1);
    expect(valid.validationError).toBeUndefined();
    expect(host.calls.rerenders).toBe(2);
  });

  it("keeps a busy focused action visible without activating it", () => {
    // Given
    const host = createHost(createQuestionState(request(3)));
    const interaction = createQuestionSurfaceInteraction(host.host);
    interaction.actions.setFocus("simplify");
    host.replace(startSimplification(activeState(host)));

    // When
    const handled = [interaction.keyActions.enter(), interaction.keyActions.space()];

    // Then
    expect(interaction.focus()).toBe("simplify");
    expect(handled).toEqual([false, false]);
    expect(host.calls.simplifications).toBe(0);
  });

  it("blocks mouse and keyboard selection alike while loading", () => {
    // Given
    const host = createHost(startSimplification(createQuestionState(request(3))));
    const interaction = createQuestionSurfaceInteraction(host.host);

    // When
    interaction.actions.selectOption(0);
    const handled = [interaction.keyActions.enter(), interaction.keyActions.space()];

    // Then
    expect(handled).toEqual([false, false]);
    expect(activeState(host).selections.size).toBe(0);
  });

  it("keeps Cancel activatable while loading", () => {
    // Given
    const host = createHost(startSimplification(createQuestionState(request(3))));
    const interaction = createQuestionSurfaceInteraction(host.host);
    interaction.actions.setFocus("cancel");

    // When
    const handled = interaction.keyActions.enter();

    // Then
    expect(handled).toBe(true);
    expect(host.calls.dismissals).toBe(1);
  });
});
