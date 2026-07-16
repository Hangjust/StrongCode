import { createHash } from "node:crypto";
import type { AgentRunResult } from "../core/types";
import { StrongCodeError, toStrongCodeError } from "../core/errors";
import { err, ok, type Result } from "../core/result";
import type { ToolInvocationContext, RuntimeContext } from "../runtime/context";
import type { ChildFactoryInput, ChildFactoryOutput } from "../runtime/child-factory";
import type { DelegationConfig } from "../config/runtime-config";
import type { AdmissionLease, TaskPersistence } from "./admission";
import {
  executionFailure,
  finalizeExecution,
  TaskExecutionTimeoutError,
  type ForegroundTaskResult,
  type ForegroundTaskStatus
} from "./execution";
import { boundTaskText, TASK_ERROR_MESSAGE_MAX_UNITS } from "./text-bounds";
import type { TaskRecord } from "./types";
import type { ChildRunner } from "./task-manager-types";
import type { ChildExecutionPolicy } from "../tools/child-policy";

export type TaskRuntimeProfile = Readonly<{
  readonly child: ChildFactoryOutput;
  readonly writePaths: readonly string[];
}>;

type TaskRuntimeDependencies = {
  readonly context: RuntimeContext;
  readonly tasks: TaskPersistence;
  readonly limits: DelegationConfig;
  readonly childFactory: (input: ChildFactoryInput) => ChildFactoryOutput;
  readonly createRunner: (context: ToolInvocationContext) => ChildRunner;
};

export type TaskRuntimeExecution = {
  readonly lease: AdmissionLease;
  readonly controller: AbortController;
  readonly prompt: string;
  readonly createChild?: ChildFactoryInput;
  readonly profile?: TaskRuntimeProfile;
  readonly onProfile?: (result: Result<TaskRuntimeProfile>) => void;
};

function taskError(error: unknown): StrongCodeError {
  const converted = toStrongCodeError(error, "TASK_ERROR");
  return new StrongCodeError(converted.code, boundTaskText(converted.message, TASK_ERROR_MESSAGE_MAX_UNITS) || converted.code);
}

function cancelledError(reason: unknown): StrongCodeError {
  const detail = reason instanceof Error ? reason.message : reason === undefined ? "Task was cancelled" : String(reason);
  return new StrongCodeError(
    reason instanceof StrongCodeError ? reason.code : "CANCELLED",
    boundTaskText(detail, TASK_ERROR_MESSAGE_MAX_UNITS) || "Task was cancelled"
  );
}

function policyHash(policy: ChildExecutionPolicy): string {
  const permissions = Object.entries(policy.permissions).sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify({ permissions, tools: [...policy.tools].sort() })).digest("hex");
}

export class TaskRuntime {
  constructor(private readonly dependencies: TaskRuntimeDependencies) {}

  async execute(input: TaskRuntimeExecution): Promise<Result<ForegroundTaskResult>> {
    const timeoutError = new TaskExecutionTimeoutError(input.lease.taskId);
    const remainingMs = Math.max(0, input.lease.deadlineAt - Date.now());
    const timer = remainingMs === 0 ? undefined : setTimeout(() => input.controller.abort(timeoutError), remainingMs);
    if (remainingMs === 0) input.controller.abort(timeoutError);
    try {
      if (input.controller.signal.aborted) {
        const failure = input.controller.signal.reason === timeoutError ? timeoutError : cancelledError(input.controller.signal.reason);
        const persisted = await this.persistPreRunFailure(
          input.lease.queuedRecord,
          failure,
          input.controller.signal.reason === timeoutError ? "timed_out" : "cancelled"
        );
        return persisted.ok ? err(failure) : persisted;
      }
      const profile = this.resolveProfile(input);
      if (!profile.ok) {
        const persisted = await this.persistPreRunFailure(input.lease.queuedRecord, profile.error);
        return persisted.ok ? profile : persisted;
      }
      const prepared = this.preparedRecord(input.lease.queuedRecord, profile.value.child);
      const context: ToolInvocationContext = {
        ...this.dependencies.context,
        taskId: input.lease.taskId,
        signal: input.controller.signal,
        effectivePermissions: profile.value.child.policy.permissions,
        ownership: input.lease.ownershipPaths
      };
      let runner: ChildRunner;
      try {
        runner = this.dependencies.createRunner(context);
      } catch (error) {
        const failure = taskError(error instanceof Error ? error : String(error));
        input.controller.abort(failure);
        const persisted = await this.persistPreRunFailure(prepared, failure);
        return persisted.ok ? err(failure) : persisted;
      }
      const startedAt = new Date().toISOString();
      const running: TaskRecord = {
        ...prepared,
        status: "running",
        timestamps: { ...prepared.timestamps, updatedAt: startedAt, startedAt }
      };
      const started = await input.lease.markStarted(running);
      if (!started.ok) {
        const failure = taskError(started.error);
        input.controller.abort(failure);
        const persisted = await this.persistPreRunFailure(prepared, failure);
        return persisted.ok ? err(failure) : persisted;
      }
      const runResult = await this.run({ runner, child: profile.value.child, input, record: running });
      const terminal = this.terminalOutcome(runResult, input.controller, timeoutError);
      const finalized = finalizeExecution({
        baseRecord: running,
        model: running.model ?? profile.value.child.agent.config.model,
        status: terminal.status,
        output: runResult.ok ? runResult.value.response : "",
        completedAt: new Date().toISOString(),
        inlineLimit: this.dependencies.limits.maxInlineResultChars,
        ...(terminal.error === undefined ? {} : { error: terminal.error })
      });
      const persisted = await this.dependencies.tasks.write(finalized.record);
      return persisted.ok ? ok(finalized.result) : persisted;
    } finally {
      if (timer) clearTimeout(timer);
      await input.lease.release();
    }
  }

  private resolveProfile(input: TaskRuntimeExecution): Result<TaskRuntimeProfile> {
    if (input.profile) return ok(input.profile);
    if (!input.createChild) return err(new StrongCodeError("TASK_ERROR", "Task execution profile is unavailable"));
    try {
      const profile = Object.freeze({
        child: this.dependencies.childFactory(input.createChild),
        writePaths: Object.freeze([...input.lease.queuedRecord.ownedPaths])
      });
      input.onProfile?.(ok(profile));
      return ok(profile);
    } catch (error) {
      const failure = taskError(error instanceof Error ? error : String(error));
      input.onProfile?.(err(failure));
      return err(failure);
    }
  }

  private preparedRecord(record: TaskRecord, child: ChildFactoryOutput): TaskRecord {
    return {
      ...record,
      model: child.agent.modelResolution?.modelId ?? child.agent.config.model,
      effectivePolicyHash: policyHash(child.policy),
      skillReceipts: child.skillReceipts.map(receipt => ({ id: receipt.id, path: receipt.path, hash: receipt.sha256 }))
    };
  }

  private async run(execution: {
    readonly runner: ChildRunner;
    readonly child: ChildFactoryOutput;
    readonly input: TaskRuntimeExecution;
    readonly record: TaskRecord;
  }): Promise<Result<AgentRunResult>> {
    const { runner, child, input, record } = execution;
    try {
      if (input.controller.signal.aborted) return err(cancelledError(input.controller.signal.reason));
      return await runner.run(child.agent, input.prompt, record.childSessionId);
    } catch (error) {
      return err(executionFailure(error instanceof Error ? error : String(error)));
    }
  }

  private terminalOutcome(
    result: Result<AgentRunResult>,
    controller: AbortController,
    timeoutError: TaskExecutionTimeoutError
  ): { readonly status: ForegroundTaskStatus; readonly error?: StrongCodeError } {
    if (result.ok) return { status: "succeeded" };
    if (controller.signal.reason === timeoutError) return { status: "timed_out", error: timeoutError };
    if (controller.signal.aborted) return { status: "cancelled", error: cancelledError(controller.signal.reason) };
    return { status: "failed", error: result.error };
  }

  private async persistPreRunFailure(
    record: TaskRecord,
    failure: StrongCodeError,
    status: "failed" | "cancelled" | "timed_out" = "failed"
  ): Promise<Result<void>> {
    const completedAt = new Date().toISOString();
    const persisted = await this.dependencies.tasks.write({
      ...record,
      status,
      timestamps: { ...record.timestamps, updatedAt: completedAt, completedAt },
      error: { code: failure.code, message: boundTaskText(failure.message, TASK_ERROR_MESSAGE_MAX_UNITS) || failure.code }
    });
    return persisted.ok ? persisted : err(taskError(persisted.error));
  }
}
