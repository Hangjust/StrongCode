import { questionResultSchema } from "../src/questions/schema";

type OptionalAnswerField = "customAnswer" | "guidance";

function resultWith(field: OptionalAnswerField, value: string) {
  const answer = {
    questionId: "q1",
    question: "Which scope should we use?",
    selections: [{ optionId: "first", optionLabel: "First choice" }]
  };
  return field === "customAnswer"
    ? { outcome: "answered", answers: [{ ...answer, customAnswer: value }] }
    : { outcome: "answered", answers: [answer], guidance: value };
}

describe("question result raw optional-answer limits", () => {
  it.each<readonly [OptionalAnswerField, string, string]>([
    ["customAnswer", "x".repeat(2000), "x".repeat(2000)],
    ["customAnswer", ` ${"x".repeat(1999)}`, "x".repeat(1999)],
    ["customAnswer", `${"x".repeat(1999)} `, "x".repeat(1999)],
    ["guidance", "x".repeat(2000), "x".repeat(2000)],
    ["guidance", ` ${"x".repeat(1999)}`, "x".repeat(1999)],
    ["guidance", `${"x".repeat(1999)} `, "x".repeat(1999)]
  ])("accepts and canonically trims exactly 2,000 raw units for %s", (field, value, expected) => {
    // Given
    const input = resultWith(field, value);

    // When
    const parsed = questionResultSchema.safeParse(input);

    // Then
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.outcome === "answered") {
      expect(field === "customAnswer" ? parsed.data.answers[0]?.customAnswer : parsed.data.guidance).toBe(expected);
    }
  });

  it.each<readonly [OptionalAnswerField, string]>([
    ["customAnswer", "x".repeat(2001)],
    ["customAnswer", ` ${"x".repeat(2000)}`],
    ["customAnswer", `${"x".repeat(2000)} `],
    ["guidance", "x".repeat(2001)],
    ["guidance", ` ${"x".repeat(2000)}`],
    ["guidance", `${"x".repeat(2000)} `]
  ])("rejects 2,001 raw units for %s before trimming", (field, value) => {
    // Given
    const input = resultWith(field, value);

    // When
    const parsed = questionResultSchema.safeParse(input);

    // Then
    expect(parsed.success).toBe(false);
  });
});
