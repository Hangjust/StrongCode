import { z } from "zod";
import { StrongCodeError } from "../core/errors";
import { err, ok, type Result } from "../core/result";

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const TERMINAL_SAFE_LINE_PATTERN = /^[^\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]+$/u;

function hasUniqueValues(values: readonly string[]): boolean { return new Set(values).size === values.length; }

function hasWordCount(value: string, minimum: number, maximum: number): boolean { const count = value.split(/\s+/u).length; return count >= minimum && count <= maximum; }

function validationError(contract: string, error: z.ZodError): StrongCodeError {
  const details = error.issues
    .map(issue => `${issue.path.join(".") || "value"}: ${issue.message}`)
    .join("; ");
  return new StrongCodeError("VALIDATION_ERROR", `Invalid ${contract}: ${details}`);
}

const terminalLineSchema = z.string()
  .regex(TERMINAL_SAFE_LINE_PATTERN, "Use one terminal-safe line without control characters")
  .trim();

export const questionIdSchema = z.string()
  .min(1)
  .max(64)
  .regex(SAFE_ID_PATTERN, "Use a stable ASCII ID beginning with a letter or digit")
  .brand("QuestionId");

export const questionOptionIdSchema = z.string()
  .min(1)
  .max(64)
  .regex(SAFE_ID_PATTERN, "Use a stable ASCII ID beginning with a letter or digit")
  .brand("QuestionOptionId");

export const questionHeaderSchema = terminalLineSchema
  .min(1)
  .max(48)
  .refine(value => hasWordCount(value, 1, 4), "Use an easy-English header of 1-4 words")
  .describe("Easy-English topic header of 1-4 words. Preserve exact technical names.");

export const questionTextSchema = terminalLineSchema
  .min(2)
  .max(240)
  .endsWith("?", "Phrase this as one short question ending in a question mark")
  .describe("One short easy-English question. Preserve exact technical names.");

export const questionOptionLabelSchema = terminalLineSchema
  .min(1)
  .max(64)
  .refine(value => hasWordCount(value, 1, 6), "Use an easy-English option label of 1-6 words")
  .describe("Easy-English option label of 1-6 words. Preserve exact technical names.");

export const questionOptionDescriptionSchema = terminalLineSchema
  .min(1)
  .max(160)
  .describe("Concise one-line easy-English explanation. Preserve exact technical names.");

export const questionOptionSchema = z.object({
  id: questionOptionIdSchema,
  label: questionOptionLabelSchema,
  description: questionOptionDescriptionSchema.optional()
}).strict().readonly();

export const questionSchema = z.object({
  id: questionIdSchema,
  header: questionHeaderSchema,
  question: questionTextSchema,
  multiple: z.boolean().default(false),
  allowCustom: z.boolean().default(true),
  options: z.array(questionOptionSchema).min(2).max(6).readonly()
}).strict().superRefine((question, context) => {
  if (!hasUniqueValues(question.options.map(option => option.id))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["options"],
      message: "Option IDs must be unique within a question"
    });
  }
}).readonly();

export const questionRequestSchema = z.object({
  questions: z.array(questionSchema).min(1).max(6).readonly()
}).strict().superRefine((request, context) => {
  if (!hasUniqueValues(request.questions.map(question => question.id))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["questions"],
      message: "Question IDs must be unique within a request"
    });
  }
}).readonly();

const optionalAnswerTextSchema = z.string()
  .max(2000)
  .pipe(terminalLineSchema)
  .describe("Optional terminal-safe one-line answer text; blank input is omitted.")
  .optional();

export function isTerminalSafeQuestionDraft(value: string): boolean {
  return value === "" || optionalAnswerTextSchema.safeParse(value).success;
}

export const questionSelectionSchema = z.object({
  optionId: questionOptionIdSchema,
  optionLabel: questionOptionLabelSchema.describe("Original parsed option label, without rewriting.")
}).strict().readonly();

export const questionAnswerSchema = z.object({
  questionId: questionIdSchema,
  question: questionTextSchema.describe("Original parsed question text, without rewriting."),
  selections: z.array(questionSelectionSchema).max(6).readonly(),
  customAnswer: optionalAnswerTextSchema
}).strict().superRefine((answer, context) => {
  if (answer.selections.length === 0 && !answer.customAnswer) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["selections"],
      message: "Select at least one option or provide a custom answer"
    });
  }
  if (!hasUniqueValues(answer.selections.map(selection => selection.optionId))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["selections"],
      message: "Selected option IDs must be unique within an answer"
    });
  }
}).transform(answer => answer.customAnswer
  ? {
      questionId: answer.questionId,
      question: answer.question,
      selections: answer.selections,
      customAnswer: answer.customAnswer
    }
  : {
      questionId: answer.questionId,
      question: answer.question,
      selections: answer.selections
    }).readonly();

const answeredResultSchema = z.object({
  outcome: z.literal("answered"),
  answers: z.array(questionAnswerSchema).min(1).max(6).readonly(),
  guidance: optionalAnswerTextSchema
}).strict();

const dismissedResultSchema = z.object({
  outcome: z.literal("dismissed")
}).strict();

export const questionResultSchema = z.discriminatedUnion("outcome", [
  answeredResultSchema,
  dismissedResultSchema
]).superRefine((result, context) => {
  switch (result.outcome) {
    case "answered":
      if (!hasUniqueValues(result.answers.map(answer => answer.questionId))) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["answers"],
          message: "Question IDs must be unique within a result"
        });
      }
      return;
    case "dismissed":
      return;
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}).transform(result => {
  switch (result.outcome) {
    case "answered":
      return result.guidance
        ? { outcome: result.outcome, answers: result.answers, guidance: result.guidance }
        : { outcome: result.outcome, answers: result.answers };
    case "dismissed":
      return result;
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}).readonly();

export type QuestionId = z.infer<typeof questionIdSchema>;
export type QuestionOptionId = z.infer<typeof questionOptionIdSchema>;
export type QuestionOption = z.infer<typeof questionOptionSchema>;
export type Question = z.infer<typeof questionSchema>;
export type QuestionRequest = z.infer<typeof questionRequestSchema>;
export type QuestionSelection = z.infer<typeof questionSelectionSchema>;
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;
export type QuestionResult = z.infer<typeof questionResultSchema>;
export type QuestionDisplayMode = "compact" | "tabbed";

export function parseQuestionRequest(input: unknown): Result<QuestionRequest> {
  const parsed = questionRequestSchema.safeParse(input);
  return parsed.success
    ? ok(parsed.data)
    : err(validationError("question request", parsed.error));
}

export function parseQuestionResult(input: unknown): Result<QuestionResult> {
  const parsed = questionResultSchema.safeParse(input);
  return parsed.success
    ? ok(parsed.data)
    : err(validationError("question result", parsed.error));
}

export function selectQuestionDisplayMode(questionCount: number): QuestionDisplayMode {
  return questionCount <= 2 ? "compact" : "tabbed";
}

export const questionRequestJsonSchema = {
  type: "object",
  description: "Ask 1-6 ordered questions. Use compact mode for 1-2 questions and tabbed mode with Confirm for 3-6.",
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1, maxLength: 64, pattern: SAFE_ID_PATTERN.source, description: "Unique stable question ID." },
          header: { type: "string", minLength: 1, maxLength: 48, pattern: TERMINAL_SAFE_LINE_PATTERN.source, description: "Easy-English topic header of 1-4 words. Preserve exact technical names." },
          question: { type: "string", minLength: 2, maxLength: 240, pattern: TERMINAL_SAFE_LINE_PATTERN.source, description: "One short easy-English question ending in ?. Preserve exact technical names." },
          multiple: { type: "boolean", default: false },
          allowCustom: { type: "boolean", default: true },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 6,
            items: {
              type: "object",
              properties: {
                id: { type: "string", minLength: 1, maxLength: 64, pattern: SAFE_ID_PATTERN.source, description: "Unique stable option ID within this question." },
                label: { type: "string", minLength: 1, maxLength: 64, pattern: TERMINAL_SAFE_LINE_PATTERN.source, description: "Easy-English label of 1-6 words. Preserve exact technical names." },
                description: { type: "string", minLength: 1, maxLength: 160, pattern: TERMINAL_SAFE_LINE_PATTERN.source, description: "Optional concise one-line explanation." }
              },
              required: ["id", "label"],
              additionalProperties: false
            }
          }
        },
        required: ["id", "header", "question", "options"],
        additionalProperties: false
      }
    }
  },
  required: ["questions"],
  additionalProperties: false
} as const;
