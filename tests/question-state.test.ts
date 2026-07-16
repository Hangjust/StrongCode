import {
  activeOptionHighlight,
  applySimplifiedDisplay,
  buildResult,
  canSubmit,
  createQuestionState,
  dismiss,
  failSimplification,
  moveActiveTab,
  moveOptionHighlight,
  selectOption,
  setCustomDraft,
  setGuidance,
  selectDisplayedRequest,
  startSimplification,
  toggleOriginalDisplay
} from "../src/tui/question/state";
import { parseQuestionRequest, type QuestionRequest } from "../src/questions/schema";

function request(count: number): QuestionRequest {
  const parsed = parseQuestionRequest({
    questions: Array.from({ length: count }, (_, index) => ({
      id: `question-${index + 1}`,
      header: `Topic ${index + 1}`,
      question: `Which plan fits topic ${index + 1}?`,
      multiple: index === 1,
      allowCustom: index !== 3,
      options: [
        { id: `option-${index + 1}-a`, label: "Basic plan", description: "Choose the smaller plan." },
        { id: `option-${index + 1}-b`, label: "Advanced plan", description: "Choose the broader plan." }
      ]
    }))
  });
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

function simplified(original: QuestionRequest): QuestionRequest {
  const parsed = parseQuestionRequest({
    questions: original.questions.map(question => ({
      ...question,
      header: "Updated topic",
      question: "Which updated plan should we use?",
      options: question.options.map(option => ({
        ...option,
        label: `Updated ${option.label}`,
        description: "A simpler explanation."
      }))
    }))
  });
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

describe("question state", () => {
  it("uses compact mode for one question and produces an immediate canonical single-select result", () => {
    const original = request(1);
    const question = original.questions[0];
    const option = question?.options[1];
    if (!question || !option) throw new Error("fixture is incomplete");

    let state = selectOption(createQuestionState(original), question.id, question.options[0]?.id ?? option.id);
    state = selectOption(state, question.id, option.id);

    expect(state.mode).toBe("compact");
    expect(canSubmit(state)).toBe(true);
    const result = buildResult(state);
    expect(result.ok && result.value).toEqual({
      outcome: "answered",
      answers: [{ questionId: question.id, question: question.question, selections: [{ optionId: option.id, optionLabel: option.label }] }]
    });
  });

  it("requires every compact question, toggles multi-selects, and bounds option navigation", () => {
    const original = request(2);
    const first = original.questions[0];
    const second = original.questions[1];
    const firstOption = first?.options[0];
    const secondOptions = second?.options;
    if (!first || !second || !firstOption || !secondOptions) throw new Error("fixture is incomplete");

    let state = selectOption(createQuestionState(original), second.id, secondOptions[1]?.id ?? secondOptions[0]?.id);
    state = selectOption(state, second.id, secondOptions[0]?.id ?? secondOptions[1]?.id);
    state = moveOptionHighlight(state, 10);
    state = moveOptionHighlight(state, -10);

    expect(canSubmit(state)).toBe(false);
    expect(activeOptionHighlight(state)).toBe(0);
    expect(state.selections.get(second.id)).toEqual([secondOptions[0]?.id, secondOptions[1]?.id]);
    expect(canSubmit(selectOption(state, first.id, firstOption.id))).toBe(true);
  });

  it("remembers each compact question's option highlight independently", () => {
    // Given
    const original = request(2);

    // When
    let state = moveOptionHighlight(createQuestionState(original), 1);
    const firstHighlight = activeOptionHighlight(state);
    state = moveActiveTab(state, 1);
    const secondHighlight = activeOptionHighlight(state);
    state = moveActiveTab(state, -1);

    // Then
    expect(firstHighlight).toBe(1);
    expect(secondHighlight).toBe(0);
    expect(activeOptionHighlight(state)).toBe(1);
  });

  it("uses tabbed mode through six questions, permits unanswered tabs, and accepts guidance only on Confirm", () => {
    const original = request(6);
    const third = original.questions[2];
    const fourth = original.questions[3];
    if (!third || !fourth) throw new Error("fixture is incomplete");

    let state = setGuidance(createQuestionState(original), "ignore this");
    state = moveActiveTab(state, 20);
    state = setGuidance(state, "  Prefer the smallest change.  ");
    state = setCustomDraft(state, third.id, "  Keep compatibility.  ");
    state = setCustomDraft(state, fourth.id, "Not accepted.");

    if (state.mode !== "tabbed") throw new Error("expected tabbed state");
    expect(state.mode).toBe("tabbed");
    expect(state.activeTabIndex).toBe(original.questions.length);
    expect(state.guidance).toBe("  Prefer the smallest change.  ");
    expect(state.customDrafts.has(fourth.id)).toBe(false);
    expect(canSubmit(state)).toBe(false);
  });

  it("submits tabbed answers in original order with separate Confirm guidance and validates custom text", () => {
    const original = request(3);
    const first = original.questions[0];
    const second = original.questions[1];
    const third = original.questions[2];
    const firstOption = first?.options[1];
    const secondOptions = second?.options;
    if (!first || !second || !third || !firstOption || !secondOptions?.[0] || !secondOptions[1]) throw new Error("fixture is incomplete");

    let state = selectOption(createQuestionState(original), first.id, firstOption.id);
    state = selectOption(state, second.id, secondOptions[1].id);
    state = selectOption(state, second.id, secondOptions[0].id);
    state = setCustomDraft(state, second.id, "Include both options.");
    state = setCustomDraft(state, third.id, "  Keep compatibility.  ");
    state = moveActiveTab(state, 20);
    state = setGuidance(state, "  Prefer the smallest change.  ");

    expect(canSubmit(state)).toBe(true);
    const result = buildResult(state);
    expect(result.ok && result.value).toEqual({
      outcome: "answered",
      answers: [
        { questionId: first.id, question: first.question, selections: [{ optionId: firstOption.id, optionLabel: firstOption.label }] },
        { questionId: second.id, question: second.question, selections: secondOptions.map(option => ({ optionId: option.id, optionLabel: option.label })), customAnswer: "Include both options." },
        { questionId: third.id, question: third.question, selections: [], customAnswer: "Keep compatibility." }
      ],
      guidance: "Prefer the smallest change."
    });
    const blankGuidance = buildResult(setGuidance(state, "  "));
    if (!blankGuidance.ok || blankGuidance.value.outcome !== "answered") throw new Error("expected answered result");
    expect(blankGuidance.value).not.toHaveProperty("guidance");
  });

  it("keeps stable selections while replacing display text and always builds from originals", () => {
    const original = request(3);
    const first = original.questions[0];
    const firstOption = first?.options[0];
    if (!first || !firstOption) throw new Error("fixture is incomplete");

    let selected = createQuestionState(original);
    for (const question of original.questions) {
      const option = question.options[0];
      if (!option) throw new Error("fixture is incomplete");
      selected = selectOption(selected, question.id, option.id);
    }
    const state = applySimplifiedDisplay(startSimplification(selected), simplified(original));
    const result = buildResult(state);

    expect(state.simplification.kind).toBe("simplified");
    expect(state.display.questions[0]?.question).toBe("Which updated plan should we use?");
    expect(state.selections.get(first.id)).toEqual([firstOption.id]);
    if (!result.ok) throw result.error;
    if (result.value.outcome !== "answered") throw new Error("expected answered result");
    expect(result.value.answers.map(answer => answer.question)).toEqual(original.questions.map(question => question.question));
    expect(toggleOriginalDisplay(state).showOriginalDisplay).toBe(true);
    expect(selectDisplayedRequest(toggleOriginalDisplay(state))).toBe(original);
  });

  it("keeps the current simplified display when another simplification starts", () => {
    // Given
    const original = request(3);
    const simplifiedDisplay = simplified(original);
    const state = applySimplifiedDisplay(startSimplification(createQuestionState(original)), simplifiedDisplay);

    // When
    const restarted = startSimplification(state);

    // Then
    expect(restarted.simplification).toEqual({ kind: "loading" });
    expect(selectDisplayedRequest(restarted)).toBe(simplifiedDisplay);
  });

  it("rejects incompatible simplifications without changing the displayed request and returns the exact dismissal", () => {
    const state = createQuestionState(request(3));
    const display = state.display;
    const failed = applySimplifiedDisplay(startSimplification(state), request(2));
    const transportFailure = failSimplification(startSimplification(state), "Service unavailable");

    expect(failed.simplification.kind).toBe("error");
    expect(failed.display).toBe(display);
    expect(transportFailure.simplification).toEqual({ kind: "error", message: "Service unavailable" });
    expect(transportFailure.display).toBe(display);
    expect(dismiss()).toEqual({ outcome: "dismissed" });
  });
});
