import { StrongCodeError, toStrongCodeError } from "../core/errors";
import { boundTaskText, TASK_ERROR_MESSAGE_MAX_UNITS } from "./text-bounds";
import type { TaskRecord } from "./types";

export const MAX_INLINE_TASK_RESULT_CHARS = 12_000;

export type ForegroundTaskStatus = "succeeded" | "failed" | "cancelled" | "timed_out" | "interrupted";

export type ForegroundTaskResult = {
  readonly taskId: string;
  readonly childSessionId: string;
  readonly target: Readonly<{ readonly kind: "helper" | "specialist"; readonly id: string }>;
  readonly model: string;
  readonly status: ForegroundTaskStatus;
  readonly text: string;
  readonly outputChars: number;
  readonly truncated: boolean;
  readonly fullResultPointer: string;
  readonly error?: Readonly<{ readonly code: string; readonly message: string }>;
  readonly timestamps: Readonly<{
    readonly createdAt: string;
    readonly startedAt: string;
    readonly completedAt: string;
  }>;
  readonly durationMs: number;
};

export class TaskExecutionTimeoutError extends StrongCodeError {
  readonly name = "TaskExecutionTimeoutError";

  constructor(taskId: string) {
    super("TASK_ERROR", `Task '${taskId}' timed out during foreground execution`);
  }
}

export type TerminalExecution = {
  readonly baseRecord: TaskRecord;
  readonly model: string;
  readonly status: ForegroundTaskStatus;
  readonly output: string;
  readonly completedAt: string;
  readonly inlineLimit: number;
  readonly error?: StrongCodeError;
};

function boundedOutput(output: string, limit: number): {
  readonly text: string;
  readonly outputChars: number;
  readonly truncated: boolean;
} {
  let outputChars = 0;
  let text = "";
  let bounded = false;
  for (const character of output) {
    if (!bounded && outputChars < limit && text.length + character.length <= limit) text += character;
    else bounded = true;
    outputChars += 1;
  }
  return { text, outputChars, truncated: bounded || outputChars > limit };
}

function boundedError(error: StrongCodeError | undefined): StrongCodeError | undefined {
  if (!error) return undefined;
  const message = boundTaskText(error.message, TASK_ERROR_MESSAGE_MAX_UNITS) || error.code;
  return new StrongCodeError(error.code, message);
}

export function executionFailure(error: unknown): StrongCodeError {
  return toStrongCodeError(error, "MODEL_ERROR");
}

export function finalizeExecution(execution: TerminalExecution): {
  readonly record: TaskRecord;
  readonly result: ForegroundTaskResult;
} {
  const inlineLimit = Math.min(execution.inlineLimit, MAX_INLINE_TASK_RESULT_CHARS);
  const output = boundedOutput(execution.output, inlineLimit);
  const error = boundedError(execution.error);
  const pointer = `sessions/${execution.baseRecord.childSessionId}.jsonl`;
  const startedAt = execution.baseRecord.timestamps.startedAt ?? execution.baseRecord.timestamps.createdAt;
  const timestamps = Object.freeze({
    createdAt: execution.baseRecord.timestamps.createdAt,
    startedAt,
    completedAt: execution.completedAt
  });
  const target = Object.freeze({
    kind: execution.baseRecord.target.class,
    id: execution.baseRecord.target.id
  });
  const errorMetadata = error ? Object.freeze({ code: error.code, message: error.message }) : undefined;
  const record: TaskRecord = {
    ...execution.baseRecord,
    model: execution.model,
    status: execution.status,
    timestamps: {
      ...execution.baseRecord.timestamps,
      updatedAt: execution.completedAt,
      completedAt: execution.completedAt
    },
    resultMetadata: {
      summary: output.text,
      outputChars: output.outputChars,
      truncated: output.truncated
    },
    artifactPointer: pointer,
    ...(errorMetadata === undefined ? {} : { error: errorMetadata })
  };
  const result = Object.freeze({
    taskId: execution.baseRecord.id,
    childSessionId: execution.baseRecord.childSessionId,
    target,
    model: execution.model,
    status: execution.status,
    text: output.text,
    outputChars: output.outputChars,
    truncated: output.truncated,
    fullResultPointer: pointer,
    ...(errorMetadata === undefined ? {} : { error: errorMetadata }),
    timestamps,
    durationMs: Math.max(0, Date.parse(execution.completedAt) - Date.parse(startedAt))
  });
  return { record, result };
}

export function taskResultFromRecord(record: TaskRecord): ForegroundTaskResult {
  const completedAt = record.timestamps.completedAt ?? record.timestamps.updatedAt;
  const startedAt = record.timestamps.startedAt ?? record.timestamps.createdAt;
  const pointer = record.artifactPointer ?? `sessions/${record.childSessionId}.jsonl`;
  const target = Object.freeze({ kind: record.target.class, id: record.target.id });
  const timestamps = Object.freeze({ createdAt: record.timestamps.createdAt, startedAt, completedAt });
  const metadata = record.resultMetadata ?? { summary: "", outputChars: 0, truncated: false };
  const error = record.error ? Object.freeze({ ...record.error }) : undefined;
  return Object.freeze({
    taskId: record.id,
    childSessionId: record.childSessionId,
    target,
    model: record.model ?? "unselected",
    status: record.status === "queued" || record.status === "running" || record.status === "blocked"
      ? "interrupted"
      : record.status,
    text: metadata.summary,
    outputChars: metadata.outputChars,
    truncated: metadata.truncated,
    fullResultPointer: pointer,
    ...(error === undefined ? {} : { error }),
    timestamps,
    durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt))
  });
}
