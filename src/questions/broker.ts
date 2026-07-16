import { randomUUID } from "node:crypto";
import { z } from "zod";
import { StrongCodeError } from "../core/errors";
import { err, ok, type Result } from "../core/result";
import {
  parseQuestionResult,
  type QuestionAnswer,
  type QuestionRequest,
  type QuestionResult,
  type QuestionSelection
} from "./schema";

const MAX_SETTLED_TOKENS = 256;
const DISMISSED_RESULT: QuestionResult = { outcome: "dismissed" };
const questionRequestTokenSchema = z.string().uuid().brand("QuestionRequestToken");

export type QuestionRequestToken = z.infer<typeof questionRequestTokenSchema>;

export interface PendingQuestion {
  readonly token: QuestionRequestToken;
  readonly request: QuestionRequest;
}

export type QuestionObserver = (pending: PendingQuestion | undefined) => void;
export type QuestionUnsubscribe = () => void;

interface PendingCall {
  readonly pending: PendingQuestion;
  readonly resolve: (result: QuestionResult) => void;
}

function invalidHostResult(message: string): Result<never> {
  return err(new StrongCodeError("VALIDATION_ERROR", `Invalid question result: ${message}`));
}

function normalizeResult(request: QuestionRequest, result: QuestionResult): Result<QuestionResult> {
  switch (result.outcome) {
    case "dismissed":
      return ok(DISMISSED_RESULT);
    case "answered": {
      if (result.answers.length !== request.questions.length) {
        return invalidHostResult("answer every requested question exactly once");
      }

      const answers: QuestionAnswer[] = [];
      for (let index = 0; index < request.questions.length; index += 1) {
        const question = request.questions[index];
        const answer = result.answers[index];
        if (question === undefined || answer === undefined || answer.questionId !== question.id) {
          return invalidHostResult("answers must use the requested question IDs in order");
        }
        if (!question.multiple && answer.selections.length > 1) {
          return invalidHostResult(`question '${question.id}' accepts one selection`);
        }
        if (!question.allowCustom && answer.customAnswer !== undefined) {
          return invalidHostResult(`question '${question.id}' does not accept a custom answer`);
        }

        const selections: QuestionSelection[] = [];
        for (const selection of answer.selections) {
          const option = question.options.find(candidate => candidate.id === selection.optionId);
          if (option === undefined) {
            return invalidHostResult(`unknown option '${selection.optionId}' for question '${question.id}'`);
          }
          selections.push({ optionId: option.id, optionLabel: option.label });
        }
        answers.push(answer.customAnswer === undefined
          ? { questionId: question.id, question: question.question, selections }
          : { questionId: question.id, question: question.question, selections, customAnswer: answer.customAnswer });
      }

      return ok(result.guidance === undefined
        ? { outcome: "answered", answers }
        : { outcome: "answered", answers, guidance: result.guidance });
    }
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

export class QuestionBroker {
  private readonly observers = new Set<QuestionObserver>();
  private readonly settledTokens = new Set<QuestionRequestToken>();
  private readonly queue: PendingCall[] = [];
  private active: PendingCall | undefined;
  private closed = false;

  ask(request: QuestionRequest): Promise<QuestionResult> {
    if (this.closed) return Promise.resolve(DISMISSED_RESULT);

    return new Promise(resolve => {
      this.queue.push({
        pending: { token: questionRequestTokenSchema.parse(randomUUID()), request },
        resolve
      });
      this.advance();
    });
  }

  subscribe(observer: QuestionObserver): QuestionUnsubscribe {
    if (this.closed) {
      observer(undefined);
      return () => undefined;
    }
    this.observers.add(observer);
    observer(this.active?.pending);
    return () => { this.observers.delete(observer); };
  }

  answer(tokenInput: unknown, resultInput: unknown): Result<void> {
    const token = questionRequestTokenSchema.safeParse(tokenInput);
    if (!token.success) return err(new StrongCodeError("SESSION_ERROR", "Unknown or stale question request token"));
    if (this.settledTokens.has(token.data)) {
      return err(new StrongCodeError("SESSION_ERROR", `Question request already settled: ${token.data}`));
    }
    if (this.active?.pending.token !== token.data) {
      return err(new StrongCodeError("SESSION_ERROR", `Unknown or stale question request: ${token.data}`));
    }

    const parsed = parseQuestionResult(resultInput);
    if (!parsed.ok) return err(parsed.error);
    const normalized = normalizeResult(this.active.pending.request, parsed.value);
    if (!normalized.ok) return normalized;

    const settled = this.active;
    this.active = undefined;
    this.rememberSettled(settled.pending.token);
    settled.resolve(normalized.value);
    this.advance();
    return ok(undefined);
  }

  dismiss(token: unknown): Result<void> {
    return this.answer(token, DISMISSED_RESULT);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const pending = this.active === undefined ? [...this.queue] : [this.active, ...this.queue];
    this.active = undefined;
    this.queue.length = 0;
    for (const call of pending) {
      this.rememberSettled(call.pending.token);
      call.resolve(DISMISSED_RESULT);
    }
    this.publish(undefined);
    this.observers.clear();
  }

  private advance(): void {
    if (this.closed || this.active !== undefined) return;
    const next = this.queue.shift();
    if (next === undefined) {
      this.publish(undefined);
      return;
    }
    this.active = next;
    this.publish(next.pending);
  }

  private publish(pending: PendingQuestion | undefined): void {
    for (const observer of this.observers) observer(pending);
  }

  private rememberSettled(token: QuestionRequestToken): void {
    this.settledTokens.add(token);
    if (this.settledTokens.size <= MAX_SETTLED_TOKENS) return;
    const oldest = this.settledTokens.values().next();
    if (!oldest.done) this.settledTokens.delete(oldest.value);
  }
}
