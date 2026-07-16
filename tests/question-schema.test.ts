import { StrongCodeError } from "../src/core/errors";
import {
  parseQuestionRequest,
  parseQuestionResult,
  questionRequestJsonSchema,
  questionRequestSchema,
  questionResultSchema,
  selectQuestionDisplayMode
} from "../src/questions/schema";

function option(id: string, label: string) {
  return { id, label, description: `Choose ${label}.` };
}

function question(id: string, options = [option("first", "First choice"), option("second", "Second choice")]) {
  return { id, header: "Build scope", question: "Which scope should we use?", options };
}

describe("question request schema", () => {
  it("parses a golden request, trims display text, and preserves technical names and order", () => {
    const input = {
      questions: [
        {
          id: "runtime:node.js",
          header: "  Runtime choice  ",
          question: "  Which Node.js version should we use?  ",
          multiple: true,
          allowCustom: false,
          options: [
            { id: "node-22:lts", label: "  Node.js 22 LTS  ", description: "  Current long-term support release.  " },
            { id: "bun_1.2", label: "Bun 1.2", description: "Fast TypeScript runtime." }
          ]
        },
        question("delivery")
      ]
    };

    const parsed = questionRequestSchema.safeParse(input);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({
        questions: [
          {
            id: "runtime:node.js",
            header: "Runtime choice",
            question: "Which Node.js version should we use?",
            multiple: true,
            allowCustom: false,
            options: [
              { id: "node-22:lts", label: "Node.js 22 LTS", description: "Current long-term support release." },
              { id: "bun_1.2", label: "Bun 1.2", description: "Fast TypeScript runtime." }
            ]
          },
          { ...question("delivery"), multiple: false, allowCustom: true }
        ]
      });
    }
  });

  it("enforces the one-to-six question bounds", () => {
    const sixQuestions = Array.from({ length: 6 }, (_, index) => question(`q-${index + 1}`));

    expect(questionRequestSchema.safeParse({ questions: [] }).success).toBe(false);
    expect(questionRequestSchema.safeParse({ questions: [question("only")] }).success).toBe(true);
    expect(questionRequestSchema.safeParse({ questions: sixQuestions }).success).toBe(true);
    expect(questionRequestSchema.safeParse({ questions: [...sixQuestions, question("seventh")] }).success).toBe(false);
  });

  it("requires unique safe ASCII question IDs and option IDs per question", () => {
    const duplicateQuestions = { questions: [question("same"), question("same")] };
    const duplicateOptions = { questions: [question("q1", [option("same", "First"), option("same", "Second")])] };

    expect(questionRequestSchema.safeParse(duplicateQuestions).success).toBe(false);
    expect(questionRequestSchema.safeParse(duplicateOptions).success).toBe(false);
    expect(questionRequestSchema.safeParse({ questions: [question("q1", [option("bad id", "First"), option("second", "Second")])] }).success).toBe(false);
    for (const id of ["-leading", "has space", "slash/id", "naïve", "line\nbreak"]) {
      expect(questionRequestSchema.safeParse({ questions: [question(id)] }).success).toBe(false);
    }
  });

  it("enforces two-to-six options", () => {
    const sixOptions = Array.from({ length: 6 }, (_, index) => option(`o-${index + 1}`, `Choice ${index + 1}`));

    expect(questionRequestSchema.safeParse({ questions: [question("q1", [option("only", "Only")])] }).success).toBe(false);
    expect(questionRequestSchema.safeParse({ questions: [question("q1", sixOptions)] }).success).toBe(true);
    expect(questionRequestSchema.safeParse({ questions: [question("q1", [...sixOptions, option("seventh", "Seventh")])] }).success).toBe(false);
  });

  it("rejects unsafe, multiline, or contract-breaking display text", () => {
    const invalidQuestions = [
      { ...question("q1"), header: "One two three four five" },
      { ...question("q1"), question: "Choose a scope" },
      { ...question("q1"), question: "Which scope?\nNow" },
      { ...question("q1"), header: "Unsafe\u001b[31m" },
      { ...question("q1"), options: [option("first", "One two three four five six seven"), option("second", "Second")] },
      { ...question("q1"), options: [option("first", "First"), { ...option("second", "Second"), description: "Line one\nLine two" }] }
    ];

    for (const candidate of invalidQuestions) {
      expect(questionRequestSchema.safeParse({ questions: [candidate] }).success).toBe(false);
    }
  });

  it("rejects unknown keys at every request object level", () => {
    const candidates = [
      { questions: [question("q1")], extra: true },
      { questions: [{ ...question("q1"), extra: true }] },
      { questions: [{ ...question("q1"), options: [{ ...option("first", "First"), extra: true }, option("second", "Second")] }] }
    ];

    for (const candidate of candidates) {
      expect(questionRequestSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("returns a typed StrongCode validation error from the parser", () => {
    const parsed = parseQuestionRequest({ questions: [] });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toBeInstanceOf(StrongCodeError);
      expect(parsed.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("exports defaults and a strict model-facing JSON Schema with both flags", () => {
    const parsed = questionRequestSchema.safeParse({ questions: [question("q1")] });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.questions[0]).toMatchObject({ multiple: false, allowCustom: true });
    }
    expect(questionRequestJsonSchema).toMatchObject({
      type: "object",
      required: ["questions"],
      additionalProperties: false,
      properties: {
        questions: { type: "array", minItems: 1, maxItems: 6 }
      }
    });
    expect(JSON.stringify(questionRequestJsonSchema)).toContain('"multiple":{"type":"boolean","default":false}');
    expect(JSON.stringify(questionRequestJsonSchema)).toContain('"allowCustom":{"type":"boolean","default":true}');
  });
});

describe("question result schema", () => {
  it("parses ordered answered results with original text, selections, custom answers, and top-level guidance", () => {
    const input = {
      outcome: "answered",
      answers: [
        {
          questionId: "runtime:node.js",
          question: "Which Node.js version should we use?",
          selections: [
            { optionId: "node-22:lts", optionLabel: "Node.js 22 LTS" },
            { optionId: "bun_1.2", optionLabel: "Bun 1.2" }
          ]
        },
        {
          questionId: "delivery",
          question: "Which scope should we use?",
          selections: [],
          customAnswer: "  Keep the exact current API.  "
        }
      ],
      guidance: "  Prefer the smallest safe change.  "
    };

    const parsed = parseQuestionResult(input);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual({
        outcome: "answered",
        answers: [input.answers[0], { ...input.answers[1], customAnswer: "Keep the exact current API." }],
        guidance: "Prefer the smallest safe change."
      });
    }
  });

  it("omits blank optional custom answers and top-level guidance", () => {
    const answer = {
      questionId: "q1",
      question: "Which scope should we use?",
      selections: [{ optionId: "first", optionLabel: "First choice" }],
      customAnswer: "   "
    };

    const parsed = questionResultSchema.safeParse({ outcome: "answered", answers: [answer], guidance: "   " });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({
        outcome: "answered",
        answers: [{ questionId: "q1", question: "Which scope should we use?", selections: answer.selections }]
      });
    }
  });

  it("rejects empty answers, duplicate IDs, unsafe custom text, and nested guidance", () => {
    const answer = {
      questionId: "q1",
      question: "Which scope should we use?",
      selections: [{ optionId: "first", optionLabel: "First choice" }]
    };
    const invalidResults = [
      { outcome: "answered", answers: [{ ...answer, selections: [] }] },
      { outcome: "answered", answers: [answer, answer] },
      { outcome: "answered", answers: [{ ...answer, selections: [answer.selections[0], answer.selections[0]] }] },
      { outcome: "answered", answers: [{ ...answer, customAnswer: "Line one\nLine two" }] },
      { outcome: "answered", answers: [{ ...answer, customAnswer: "x".repeat(2001) }] },
      { outcome: "answered", answers: [{ ...answer, guidance: "Not allowed here" }] },
      { outcome: "answered", answers: [answer], guidance: "x".repeat(2001) },
      { outcome: "answered", answers: [{ ...answer, extra: true }] },
      { outcome: "answered", answers: [{ ...answer, selections: [{ ...answer.selections[0], extra: true }] }] },
      { outcome: "answered", answers: [answer], extra: true }
    ];

    for (const candidate of invalidResults) {
      expect(questionResultSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("enforces one-to-six ordered answers", () => {
    const answers = Array.from({ length: 6 }, (_, index) => ({
      questionId: `q-${index + 1}`,
      question: `Which choice is number ${index + 1}?`,
      selections: [{ optionId: `o-${index + 1}`, optionLabel: `Choice ${index + 1}` }]
    }));

    expect(questionResultSchema.safeParse({ outcome: "answered", answers: [] }).success).toBe(false);
    expect(questionResultSchema.safeParse({ outcome: "answered", answers }).success).toBe(true);
    expect(questionResultSchema.safeParse({ outcome: "answered", answers: [...answers, { ...answers[0], questionId: "q-7" }] }).success).toBe(false);
  });

  it("accepts only the exact dismissed result", () => {
    expect(questionResultSchema.safeParse({ outcome: "dismissed" }).success).toBe(true);
    expect(questionResultSchema.safeParse({ outcome: "dismissed", answers: [] }).success).toBe(false);
    expect(questionResultSchema.safeParse({ outcome: "dismissed", guidance: "Later" }).success).toBe(false);
  });
});

describe("question display mode", () => {
  it("selects compact for one or two questions and tabbed for three or more", () => {
    expect(selectQuestionDisplayMode(1)).toBe("compact");
    expect(selectQuestionDisplayMode(2)).toBe("compact");
    expect(selectQuestionDisplayMode(3)).toBe("tabbed");
    expect(selectQuestionDisplayMode(6)).toBe("tabbed");
  });
});
