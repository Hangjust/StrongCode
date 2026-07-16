import { StrongCodeError } from "../core/errors";
import { err, ok, type Result } from "../core/result";
import { TaskAdmissionTimeoutError, type TaskPersistence } from "./admission";
import {
  BackgroundJobRegistry,
  type BackgroundJob,
  type BackgroundSpawnProfile,
  type BackgroundTaskHandle,
  type BackgroundTurn,
  type TaskOwner
} from "./background-jobs";
import { taskResultFromRecord, type ForegroundTaskResult } from "./execution";
import { linkedController, taskError } from "./task-preparation";
import { boundTaskText, TASK_ERROR_MESSAGE_MAX_UNITS } from "./text-bounds";
import type { TaskRecord } from "./types";

export type PreRuntimeTerminalStatus = "failed" | "cancelled" | "timed_out";

type Deferred<T> = { readonly promise: Promise<T>; readonly resolve: (value: T) => void };

export type BackgroundLifecycleInput = {
  readonly handle: BackgroundTaskHandle;
  readonly owner: TaskOwner;
  readonly profile: Promise<Result<BackgroundSpawnProfile>>;
  readonly source: TaskRecord;
  readonly deadlineAt: number;
  readonly blockedRecord?: TaskRecord;
  readonly parentSignal?: AbortSignal;
  readonly operation: (controller: AbortController, ready: (result: Result<BackgroundTaskHandle>) => void) => Promise<Result<ForegroundTaskResult>>;
  readonly onFailure?: (result: Result<never>) => void;
};

function deferred<T>(): Deferred<T> {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>(resolve => { settle = resolve; });
  if (!settle) throw new StrongCodeError("TASK_ERROR", "Task promise was not initialized");
  return { promise, resolve: settle };
}

export function backgroundCancellationError(reason: unknown): StrongCodeError {
  if (reason instanceof StrongCodeError) return reason;
  const message = reason instanceof Error ? reason.message : reason === undefined ? "Task was cancelled" : String(reason);
  return new StrongCodeError("CANCELLED", message);
}

export function backgroundTerminalStatus(
  error: StrongCodeError,
  controller: AbortController
): PreRuntimeTerminalStatus {
  if (error instanceof TaskAdmissionTimeoutError || controller.signal.reason instanceof TaskAdmissionTimeoutError) return "timed_out";
  if (controller.signal.aborted || error.code === "CANCELLED") return "cancelled";
  return "failed";
}

export async function persistBackgroundTerminal(input: Readonly<{
  tasks: TaskPersistence;
  record: TaskRecord;
  status: PreRuntimeTerminalStatus;
  error: StrongCodeError;
}>): Promise<Result<ForegroundTaskResult>> {
  const completedAt = new Date().toISOString();
  const terminal: TaskRecord = {
    ...input.record,
    status: input.status,
    timestamps: { ...input.record.timestamps, updatedAt: completedAt, completedAt },
    error: {
      code: input.error.code,
      message: boundTaskText(input.error.message, TASK_ERROR_MESSAGE_MAX_UNITS) || input.error.code
    }
  };
  const written = await input.tasks.write(terminal);
  return written.ok ? ok(taskResultFromRecord(terminal)) : err(written.error);
}

export function startBackgroundLifecycle(
  dependencies: Readonly<{ tasks: TaskPersistence; jobs: BackgroundJobRegistry }>,
  input: BackgroundLifecycleInput
): Promise<Result<BackgroundTaskHandle>> {
  const linked = linkedController(input.parentSignal);
  const ready = deferred<Result<BackgroundTaskHandle>>();
  const terminal = deferred<Result<ForegroundTaskResult>>();
  const publication = deferred<Result<void>>();
  const blockedRecord = input.blockedRecord;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let readySettled = false;
  let handlePublished = false;
  let terminalSettled = false;
  let entered = false;
  let queuedTerminal: Promise<Result<ForegroundTaskResult>> | undefined;
  const settleReady = (result: Result<BackgroundTaskHandle>): void => {
    if (readySettled) return;
    readySettled = true;
    if (result.ok) handlePublished = true;
    ready.resolve(result);
  };
  let job: BackgroundJob;
  const settleTerminal = (result: Result<ForegroundTaskResult>): void => {
    if (terminalSettled) return;
    terminalSettled = true;
    if (!readySettled) settleReady(result.ok
      ? err(new StrongCodeError("TASK_ERROR", "Task ended before background registration completed"))
      : result);
    if (!result.ok) input.onFailure?.(result);
    if (timer) clearTimeout(timer);
    linked.cleanup();
    if (!result.ok && handlePublished) dependencies.jobs.retainTerminalFailure(job, result.error);
    dependencies.jobs.complete(job);
    terminal.resolve(result);
  };
  job = Object.freeze({ handle: input.handle, owner: input.owner, controller: linked.controller, terminal: terminal.promise });
  const added = dependencies.jobs.register(job, input.profile, input.source);
  if (!added.ok) {
    linked.cleanup();
    input.onFailure?.(added);
    return Promise.resolve(added);
  }
  const timeoutError = new TaskAdmissionTimeoutError(input.handle.taskId);
  const preRuntime = (status: PreRuntimeTerminalStatus, error: StrongCodeError): Promise<Result<ForegroundTaskResult>> => (
    blockedRecord
      ? publication.promise.then(published => published.ok
        ? persistBackgroundTerminal({ tasks: dependencies.tasks, record: blockedRecord, status, error })
        : err(published.error))
      : Promise.resolve(err(error))
  );
  let turn: BackgroundTurn<Result<ForegroundTaskResult>>;
  const removeQueued = (status: PreRuntimeTerminalStatus, error: StrongCodeError): void => {
    if (entered || queuedTerminal) return;
    queuedTerminal = preRuntime(status, error);
    turn.remove(err(error));
  };
  let cancelQueued = (): void => undefined;
  turn = dependencies.jobs.enqueueTurn(input.handle.childSessionId, async () => {
    entered = true;
    linked.controller.signal.removeEventListener("abort", cancelQueued);
    if (timer) clearTimeout(timer);
    const published = await publication.promise;
    if (!published.ok) return err(published.error);
    if (linked.controller.signal.aborted) {
      const error = backgroundCancellationError(linked.controller.signal.reason);
      return blockedRecord
        ? persistBackgroundTerminal({ tasks: dependencies.tasks, record: blockedRecord, status: backgroundTerminalStatus(error, linked.controller), error })
        : err(error);
    }
    if (Date.now() >= input.deadlineAt) {
      return blockedRecord
        ? persistBackgroundTerminal({ tasks: dependencies.tasks, record: blockedRecord, status: "timed_out", error: timeoutError })
        : err(timeoutError);
    }
    return input.operation(linked.controller, settleReady);
  });
  cancelQueued = (): void => {
    const error = backgroundCancellationError(linked.controller.signal.reason);
    removeQueued(backgroundTerminalStatus(error, linked.controller), error);
  };
  linked.controller.signal.addEventListener("abort", cancelQueued, { once: true });
  if (linked.controller.signal.aborted) cancelQueued();
  const remainingMs = Math.max(0, input.deadlineAt - Date.now());
  const timeoutQueued = (): void => {
    removeQueued("timed_out", timeoutError);
    linked.controller.abort(timeoutError);
  };
  if (!terminalSettled && remainingMs === 0) timeoutQueued();
  else if (!terminalSettled) timer = setTimeout(timeoutQueued, remainingMs);
  turn.promise.then(
    result => (queuedTerminal ?? Promise.resolve(result)).then(settleTerminal, error => settleTerminal(err(taskError(error)))),
    error => settleTerminal(err(taskError(error)))
  );
  if (blockedRecord) {
    dependencies.tasks.write(blockedRecord).then(
      result => {
        publication.resolve(result);
        if (result.ok) settleReady(ok(input.handle));
        else turn.remove(err(result.error));
      },
      error => {
        const failure = taskError(error);
        publication.resolve(err(failure));
        turn.remove(err(failure));
      }
    );
  } else publication.resolve(ok(undefined));
  return ready.promise;
}
