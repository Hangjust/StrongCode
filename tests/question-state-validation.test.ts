import { parseQuestionRequest, type QuestionRequest } from "../src/questions/schema";
import { buildResult, canSubmit, createQuestionState, moveActiveTab, selectOption, setCustomDraft, setGuidance } from "../src/tui/question/state";

function request(): QuestionRequest {
  const parsed = parseQuestionRequest({
    questions: Array.from({ length: 3 }, (_, index) => ({
      id: `question-${index + 1}`,
      header: `Topic ${index + 1}`,
      question: `Which plan fits topic ${index + 1}?`,
      options: [
        { id: `option-${index + 1}-a`, label: "Basic plan", description: "Choose the smaller plan." },
        { id: `option-${index + 1}-b`, label: "Advanced plan", description: "Choose the broader plan." }
      ]
    }))
  });
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

describe("question state validation", () => {
  it("retains in-limit raw spaces while buildResult emits canonical custom and guidance values", () => {
    // Given
    const original = request();
    const [first, second, third] = original.questions;
    const firstOption = first?.options[0];
    const secondOption = second?.options[0];
    const customDraft = ` ${"x".repeat(1999)}`;
    const guidance = `${"y".repeat(1999)} `;
    if (!first || !second || !third || !firstOption || !secondOption) throw new Error("fixture is incomplete");
    let state = selectOption(createQuestionState(original), first.id, firstOption.id);
    state = selectOption(state, second.id, secondOption.id);
    state = setCustomDraft(state, third.id, customDraft);
    state = moveActiveTab(state, original.questions.length);
    state = setGuidance(state, guidance);

    // When
    const result = buildResult(state);

    // Then
    expect(state.customDrafts.get(third.id)).toBe(customDraft);
    expect(state.guidance).toBe(guidance);
    expect(canSubmit(state)).toBe(true);
    if (!result.ok || result.value.outcome !== "answered") throw new Error("expected an answered result");
    expect(result.value.answers[2]).toMatchObject({ questionId: third.id, customAnswer: "x".repeat(1999) });
    expect(result.value.guidance).toBe("y".repeat(1999));
  });

  it("rejects overlength padded custom and guidance drafts without replacing accepted values", () => {
    // Given
    const original = request();
    const [first, second, third] = original.questions;
    const firstOption = first?.options[0];
    const secondOption = second?.options[0];
    const overlength = ` ${"x".repeat(2000)}`;
    if (!first || !second || !third || !firstOption || !secondOption) throw new Error("fixture is incomplete");
    let state = selectOption(createQuestionState(original), first.id, firstOption.id);
    state = selectOption(state, second.id, secondOption.id);
    state = setCustomDraft(state, third.id, "Accepted custom");
    const rejectedCustom = setCustomDraft(state, third.id, overlength);
    state = moveActiveTab(rejectedCustom, original.questions.length);
    state = setGuidance(state, "Accepted guidance");

    // When
    const rejectedGuidance = setGuidance(state, overlength);

    // Then
    expect(rejectedCustom.customDrafts.get(third.id)).toBe("Accepted custom");
    expect(rejectedCustom.validationError).toBe("Custom answers must be one line.");
    expect(rejectedGuidance.guidance).toBe("Accepted guidance");
    expect(rejectedGuidance.validationError).toBe("Guidance must be one line.");
    expect(buildResult(rejectedGuidance).ok).toBe(true);
  });

  it("keeps an empty prior custom answer non-submittable after a padded overlength rejection", () => {
    // Given
    const original = request();
    const third = original.questions[2];
    if (!third) throw new Error("fixture is incomplete");

    // When
    const rejected = setCustomDraft(createQuestionState(original), third.id, ` ${"x".repeat(2000)}`);

    // Then
    expect(rejected.customDrafts.get(third.id)).toBeUndefined();
    expect(rejected.validationError).toBe("Custom answers must be one line.");
    expect(canSubmit(rejected)).toBe(false);
    expect(buildResult(rejected).ok).toBe(false);
  });

  it.each([
    ["newline", "Line one\nLine two"],
    ["C0 control", "Keep\u0001 compatibility."],
    ["C1 control", "Keep\u0085 compatibility."],
    ["bidi control", "Keep\u202E compatibility."]
  ])("rejects %s custom text without replacing the accepted value", (_kind, invalidDraft) => {
    // Given
    const original = request();
    const [first, second, third] = original.questions;
    const firstOption = first?.options[0];
    const secondOption = second?.options[0];
    if (!first || !second || !third || !firstOption || !secondOption) throw new Error("fixture is incomplete");
    let accepted = selectOption(createQuestionState(original), first.id, firstOption.id);
    accepted = selectOption(accepted, second.id, secondOption.id);
    accepted = setCustomDraft(accepted, third.id, "Keep compatibility.");

    // When
    const invalid = setCustomDraft(accepted, third.id, invalidDraft);
    const valid = setCustomDraft(invalid, third.id, "Use the stable API.");

    // Then
    expect({ customDraft: invalid.customDrafts.get(third.id), validationError: invalid.validationError })
      .toEqual({ customDraft: "Keep compatibility.", validationError: "Custom answers must be one line." });
    expect(canSubmit(invalid)).toBe(true);
    expect(buildResult(invalid).ok).toBe(true);
    expect(valid.customDrafts.get(third.id)).toBe("Use the stable API.");
    expect(valid.validationError).toBeUndefined();
  });

  it.each([
    ["newline", "Line one\nLine two"],
    ["C0 control", "Prefer\u0001 the smallest change."],
    ["C1 control", "Prefer\u0085 the smallest change."],
    ["bidi control", "Prefer\u202E the smallest change."]
  ])("rejects %s guidance without replacing the accepted value", (_kind, invalidGuidance) => {
    // Given
    const original = request();
    let state = createQuestionState(original);
    for (const question of original.questions) {
      const option = question.options[0];
      if (!option) throw new Error("fixture is incomplete");
      state = selectOption(state, question.id, option.id);
    }
    state = moveActiveTab(state, original.questions.length);
    state = setGuidance(state, "Prefer the smallest change.");

    // When
    const invalid = setGuidance(state, invalidGuidance);
    const valid = setGuidance(invalid, "Preserve stable behavior.");

    // Then
    expect({ guidance: invalid.guidance, validationError: invalid.validationError })
      .toEqual({ guidance: "Prefer the smallest change.", validationError: "Guidance must be one line." });
    expect(canSubmit(invalid)).toBe(true);
    expect(buildResult(invalid).ok).toBe(true);
    expect(valid.guidance).toBe("Preserve stable behavior.");
    expect(valid.validationError).toBeUndefined();
  });
});
