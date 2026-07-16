import { parseQuestionRequest, type QuestionRequest } from "../src/questions/schema";
import { createQuestionSurfaceInteraction, type QuestionSurfaceInteractionHost } from "../src/tui/question/interaction";
import { buildResult, canSubmit, createQuestionState, moveActiveTab, selectOption, type QuestionState } from "../src/tui/question/state";

type EditorCase = {
  readonly name: "custom" | "guidance";
  readonly accepted: string;
  readonly invalid: readonly string[];
};

type EditorTransitionCase = {
  readonly name: "custom" | "guidance";
  readonly accepted: string;
  readonly invalid: string;
  readonly replacement: string;
};

function request(): QuestionRequest {
  const parsed = parseQuestionRequest({
    questions: Array.from({ length: 3 }, (_, index) => ({
      id: `question-${index + 1}`,
      header: `Topic ${index + 1}`,
      question: `Which plan fits topic ${index + 1}?`,
      allowCustom: index === 2,
      options: [{ id: `option-${index + 1}-a`, label: "Basic plan" }, { id: `option-${index + 1}-b`, label: "Advanced plan" }]
    }))
  });
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

function answeredState(source: QuestionRequest): QuestionState {
  let state = createQuestionState(source);
  for (const question of source.questions) {
    const option = question.options[0];
    if (!option) throw new Error("fixture is incomplete");
    state = selectOption(state, question.id, option.id);
  }
  return state;
}

function createHost(initial: QuestionState): { readonly host: QuestionSurfaceInteractionHost; readonly current: () => QuestionState; readonly rerenders: () => number } {
  let state = initial;
  let rerenderCount = 0;
  return {
    host: {
      currentState: () => state,
      replaceState(next) { state = next; },
      rerender() { rerenderCount += 1; },
      settleAnswer() {},
      settleDismissal() {},
      async simplify() {},
      hasPending: () => true
    },
    current: () => state,
    rerenders: () => rerenderCount
  };
}

describe("question interaction validation restoration", () => {
  it.each<readonly [EditorCase]>([
    [{ name: "custom", accepted: "Accepted custom", invalid: ["\n", "\u202E", "\u0001", "\u0085", ` ${"x".repeat(2000)}`] }],
    [{ name: "guidance", accepted: "Accepted guidance", invalid: ["\n", "\u202E", "\u0001", "\u0085", ` ${"x".repeat(2000)}`] }]
  ])("rerenders and restores %s after every consecutive invalid edit", ({ name, accepted, invalid }) => {
    // Given
    const original = request();
    const third = original.questions[2];
    if (!third) throw new Error("fixture is incomplete");
    const host = createHost(name === "custom" ? answeredState(original) : moveActiveTab(answeredState(original), original.questions.length));
    const interaction = createQuestionSurfaceInteraction(host.host);
    if (name === "custom") {
      interaction.keyActions.nextPage();
      interaction.keyActions.nextPage();
      interaction.actions.setFocus("custom");
      interaction.actions.setCustom(accepted);
    } else {
      interaction.keyActions.nextPage();
      interaction.keyActions.nextPage();
      interaction.keyActions.nextPage();
      interaction.actions.setGuidance(accepted);
    }
    const beforeInvalid = host.rerenders();

    // When
    for (const value of invalid) {
      if (name === "custom") interaction.actions.setCustom(value);
      else interaction.actions.setGuidance(value);
    }
    const state = host.current();

    // Then
    expect(host.rerenders()).toBe(beforeInvalid + invalid.length);
    expect(interaction.focus()).toBe(name);
    expect(state.validationError).toBe(name === "custom" ? "Custom answers must be one line." : "Guidance must be one line.");
    expect(name === "custom" ? state.customDrafts.get(third.id) : state.guidance).toBe(accepted);
    expect(canSubmit(state)).toBe(true);
    expect(buildResult(state).ok).toBe(true);
  });

  it.each<readonly [EditorTransitionCase]>([
    [{ name: "custom", accepted: "Accepted custom", invalid: "Unsafe\ncustom", replacement: "Replacement custom" }],
    [{ name: "guidance", accepted: "Accepted guidance", invalid: "Unsafe\nguidance", replacement: "Replacement guidance" }]
  ])("accounts for %s editor transition rerenders", ({ name, accepted, invalid, replacement }) => {
    // Given
    const original = request();
    const third = original.questions[2];
    if (!third) throw new Error("fixture is incomplete");
    const host = createHost(name === "custom" ? answeredState(original) : moveActiveTab(answeredState(original), original.questions.length));
    const interaction = createQuestionSurfaceInteraction(host.host);
    if (name === "custom") {
      interaction.keyActions.nextPage();
      interaction.keyActions.nextPage();
      interaction.actions.setFocus("custom");
    } else {
      interaction.keyActions.nextPage();
      interaction.keyActions.nextPage();
      interaction.keyActions.nextPage();
      interaction.actions.setFocus("guidance");
    }
    const baselineRerenders = host.rerenders();

    // When
    if (name === "custom") interaction.actions.setCustom(accepted);
    else interaction.actions.setGuidance(accepted);

    // Then
    let state = host.current();
    expect(host.rerenders()).toBe(baselineRerenders);
    expect(name === "custom" ? state.customDrafts.get(third.id) : state.guidance).toBe(accepted);
    expect(state.validationError).toBeUndefined();
    expect(interaction.focus()).toBe(name);
    expect(canSubmit(state)).toBe(true);
    expect(buildResult(state).ok).toBe(true);

    // When
    if (name === "custom") interaction.actions.setCustom(invalid);
    else interaction.actions.setGuidance(invalid);

    // Then
    state = host.current();
    expect(host.rerenders()).toBe(baselineRerenders + 1);
    expect(name === "custom" ? state.customDrafts.get(third.id) : state.guidance).toBe(accepted);
    expect(state.validationError).toBe(name === "custom" ? "Custom answers must be one line." : "Guidance must be one line.");
    expect(interaction.focus()).toBe(name);
    expect(canSubmit(state)).toBe(true);
    expect(buildResult(state).ok).toBe(true);

    // When
    if (name === "custom") interaction.actions.setCustom(replacement);
    else interaction.actions.setGuidance(replacement);

    // Then
    state = host.current();
    expect(host.rerenders()).toBe(baselineRerenders + 2);
    expect(name === "custom" ? state.customDrafts.get(third.id) : state.guidance).toBe(replacement);
    expect(state.validationError).toBeUndefined();
    expect(interaction.focus()).toBe(name);
    expect(canSubmit(state)).toBe(true);
    expect(buildResult(state).ok).toBe(true);
  });
});
