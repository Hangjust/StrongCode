import { describe, expect, it } from "vitest";
import { questionRequestJsonSchema, questionRequestSchema, questionResultSchema } from "../src/questions/schema";

const BIDI_CONTROLS = ["\u061C", "\u200E", "\u200F", "\u2028", "\u2029", "\u202A", "\u202B", "\u202C", "\u202D", "\u202E", "\u2066", "\u2067", "\u2068", "\u2069"] as const;
const SAFE_RTL_TEXT = "עברית العربية e\u0301 👩‍💻";

type OptionInput = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
};

type QuestionInput = {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: readonly [OptionInput, OptionInput];
};

type RequestInput = {
  readonly questions: readonly [QuestionInput];
};

type ResultInput = {
  readonly outcome: "answered";
  readonly answers: readonly [{
    readonly questionId: string;
    readonly question: string;
    readonly selections: readonly [{ readonly optionId: string; readonly optionLabel: string }];
    readonly customAnswer: string;
  }];
  readonly guidance: string;
};

function request(): RequestInput {
  return {
    questions: [{
      id: "scope",
      header: "Build scope",
      question: "Which scope should we use?",
      options: [
        { id: "small", label: "Small change", description: "Keep the change focused." },
        { id: "full", label: "Full change", description: "Include the related work." }
      ]
    }]
  };
}

function result(): ResultInput {
  return {
    outcome: "answered",
    answers: [{
      questionId: "scope",
      question: "Which scope should we use?",
      selections: [{ optionId: "small", optionLabel: "Small change" }],
      customAnswer: "Keep the change focused."
    }],
    guidance: "Prefer the smallest safe change."
  };
}

const requestTextFields = [
  (control: string): RequestInput => {
    const current = request().questions[0];
    return { questions: [{ ...current, header: `Build${control} scope` }] };
  },
  (control: string): RequestInput => {
    const current = request().questions[0];
    return { questions: [{ ...current, question: `Which${control} scope should we use?` }] };
  },
  (control: string): RequestInput => {
    const current = request().questions[0];
    return { questions: [{ ...current, options: [{ ...current.options[0], label: `Small${control} change` }, current.options[1]] }] };
  },
  (control: string): RequestInput => {
    const current = request().questions[0];
    return { questions: [{ ...current, options: [current.options[0], { ...current.options[1], description: `Include${control} the related work.` }] }] };
  }
] as const;

describe("question schema bidi controls", () => {
  it("rejects every bidi control in each request text field", () => {
    for (const build of requestTextFields) {
      for (const control of BIDI_CONTROLS) {
        expect(questionRequestSchema.safeParse(build(control)).success).toBe(false);
      }
    }
  });

  it("rejects every bidi control in each returned text field", () => {
    for (const control of BIDI_CONTROLS) {
      const base = result();
      const answer = base.answers[0];
      expect(questionResultSchema.safeParse({ ...base, answers: [{ ...answer, question: `Which${control} scope should we use?` }] }).success).toBe(false);
      expect(questionResultSchema.safeParse({ ...base, answers: [{ ...answer, selections: [{ optionId: "small", optionLabel: `Small${control} change` }] }] }).success).toBe(false);
      expect(questionResultSchema.safeParse({ ...base, answers: [{ ...answer, customAnswer: `Keep${control} focused.` }] }).success).toBe(false);
      expect(questionResultSchema.safeParse({ ...base, guidance: `Prefer${control} the smallest change.` }).success).toBe(false);
    }
  });

  it("accepts ordinary RTL, combining marks, and ZWJ emoji", () => {
    const requestInput = request();
    const current = requestInput.questions[0];
    expect(questionRequestSchema.safeParse({
      ...requestInput,
      questions: [{
        ...current,
        header: SAFE_RTL_TEXT,
        question: `${SAFE_RTL_TEXT}?`,
        options: [
          { id: "small", label: SAFE_RTL_TEXT, description: SAFE_RTL_TEXT },
          { id: "full", label: "Full change", description: "Include the related work." }
        ]
      }]
    }).success).toBe(true);
    expect(questionResultSchema.safeParse({
      outcome: "answered",
      answers: [{
        questionId: "scope",
        question: `${SAFE_RTL_TEXT}?`,
        selections: [{ optionId: "small", optionLabel: SAFE_RTL_TEXT }],
        customAnswer: SAFE_RTL_TEXT
      }],
      guidance: SAFE_RTL_TEXT
    }).success).toBe(true);
  });

  it("publishes the terminal-safe pattern for model request text", () => {
    const properties = questionRequestJsonSchema.properties.questions.items.properties;
    for (const field of [properties.header, properties.question, properties.options.items.properties.label, properties.options.items.properties.description]) {
      expect(field.pattern).toContain("202A");
      expect(field.pattern).toContain("2066");
    }
  });
});
