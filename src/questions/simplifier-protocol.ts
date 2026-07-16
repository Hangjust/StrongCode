import { z } from "zod";
import { StrongCodeError } from "../core/errors";
import {
  parseQuestionRequest,
  questionHeaderSchema,
  questionOptionDescriptionSchema,
  questionOptionLabelSchema,
  questionTextSchema,
  type QuestionRequest
} from "./schema";

const MAX_RESPONSE_STRING_LENGTH = 64 * 1024;
const MAX_TOKENS = 4096;
const SYSTEM_MESSAGE = "Rewrite the supplied display text in very easy English without answering any question. Preserve exact technical names, ordering, array lengths, and optional descriptions. Return only one JSON object matching the supplied shape and no extra fields.";

const rewriteOptionSchema = z.object({
  label: questionOptionLabelSchema,
  description: questionOptionDescriptionSchema.optional()
}).strict();

const rewriteQuestionSchema = z.object({
  header: questionHeaderSchema,
  question: questionTextSchema,
  options: z.array(rewriteOptionSchema).min(2).max(6)
}).strict();

const rewriteSchema = z.object({
  questions: z.array(rewriteQuestionSchema).min(1).max(6)
}).strict();

const tokenUsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  prompt_cache_hit_tokens: z.number().int().nonnegative().optional(),
  prompt_cache_miss_tokens: z.number().int().nonnegative().optional()
}).strict();

const completionSchema = z.object({
  id: z.string().min(1).max(256).optional(),
  object: z.literal("chat.completion").optional(),
  created: z.number().int().nonnegative().optional(),
  model: z.string().min(1).max(256).optional(),
  system_fingerprint: z.string().max(256).nullable().optional(),
  choices: z.array(z.object({
    index: z.number().int().nonnegative().optional(),
    message: z.object({
      role: z.literal("assistant").optional(),
      content: z.string().min(1).max(MAX_RESPONSE_STRING_LENGTH),
      reasoning_content: z.string().max(MAX_RESPONSE_STRING_LENGTH).nullable().optional()
    }).strict(),
    logprobs: z.null().optional(),
    finish_reason: z.string().max(64).nullable().optional()
  }).strict()).length(1),
  usage: tokenUsageSchema.optional()
}).strict();

function parseJson(text: string, context: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new StrongCodeError("MODEL_ERROR", `DeepSeek returned invalid ${context} JSON`);
    }
    throw error;
  }
}

function userProjection(original: QuestionRequest): string {
  return JSON.stringify({
    questions: original.questions.map(question => ({
      header: question.header,
      question: question.question,
      options: question.options.map(option => option.description === undefined
        ? { label: option.label }
        : { label: option.label, description: option.description })
    }))
  });
}

function reconstruct(original: QuestionRequest, content: string): QuestionRequest {
  const rewriteResult = rewriteSchema.safeParse(parseJson(content, "simplification"));
  if (!rewriteResult.success) {
    throw new StrongCodeError("MODEL_ERROR", "DeepSeek returned invalid question display text");
  }
  if (rewriteResult.data.questions.length !== original.questions.length) {
    throw new StrongCodeError("MODEL_ERROR", "DeepSeek changed the number of questions");
  }

  const questions = original.questions.map((question, questionIndex) => {
    const rewrite = rewriteResult.data.questions[questionIndex];
    if (!rewrite || rewrite.options.length !== question.options.length) {
      throw new StrongCodeError("MODEL_ERROR", "DeepSeek changed the number of question options");
    }
    return {
      id: question.id,
      header: rewrite.header,
      question: rewrite.question,
      multiple: question.multiple,
      allowCustom: question.allowCustom,
      options: question.options.map((option, optionIndex) => {
        const display = rewrite.options[optionIndex];
        if (!display) {
          throw new StrongCodeError("MODEL_ERROR", "DeepSeek changed the number of question options");
        }
        return display.description === undefined
          ? { id: option.id, label: display.label }
          : { id: option.id, label: display.label, description: display.description };
      })
    };
  });
  const parsed = parseQuestionRequest({ questions });
  if (!parsed.ok) {
    throw new StrongCodeError("MODEL_ERROR", "DeepSeek returned a question rewrite that failed display validation");
  }
  return parsed.value;
}

export function buildDeepSeekSimplificationBody(original: QuestionRequest): string {
  return JSON.stringify({
    model: "deepseek-v4-flash",
    thinking: { type: "disabled" },
    temperature: 0,
    stream: false,
    response_format: { type: "json_object" },
    max_tokens: MAX_TOKENS,
    messages: [
      { role: "system", content: SYSTEM_MESSAGE },
      { role: "user", content: userProjection(original) }
    ]
  });
}

export function parseDeepSeekSimplificationResponse(
  original: QuestionRequest,
  responseText: string
): QuestionRequest {
  const completionResult = completionSchema.safeParse(parseJson(responseText, "response"));
  if (!completionResult.success) {
    throw new StrongCodeError("MODEL_ERROR", "DeepSeek returned an invalid completion response");
  }
  return reconstruct(original, completionResult.data.choices[0].message.content);
}
