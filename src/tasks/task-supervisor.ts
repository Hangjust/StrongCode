import { randomUUID } from "node:crypto";
import { StrongCodeError } from "../core/errors";
import { err, ok, type Result } from "../core/result";
import type { DelegationConfig } from "../config/runtime-config";
import {
  BackgroundJobRegistry,
  type BackgroundTaskHandle,
  type TaskOwner
} from "./background-jobs";
import type { ForegroundTaskResult } from "./execution";
import type { BackgroundLauncher } from "./background-launcher";
import type { TaskAccess } from "./task-access";
import type { ContinuationTaskRequest, PreparedTask } from "./task-manager-types";
import type { TaskRecord } from "./types";

type SupervisorDependencies = {
  readonly jobs: BackgroundJobRegistry;
  readonly access: TaskAccess;
  readonly launcher: BackgroundLauncher;
  readonly limits: DelegationConfig;
};

export class TaskSupervisor {
  private shutdownPromise: Promise<Result<void>> | undefined;

  constructor(private readonly dependencies: SupervisorDependencies) {}

  start(prepared: PreparedTask, parentSignal?: AbortSignal): Promise<Result<BackgroundTaskHandle>> {
    const allowed = this.dependencies.jobs.canStart(prepared.queuedRecord.rootSessionId);
    if (!allowed.ok) return Promise.resolve(allowed);
    return this.dependencies.launcher.startPrepared(prepared, parentSignal);
  }

  continue(request: ContinuationTaskRequest): Promise<Result<BackgroundTaskHandle>> {
    const continuation = Object.freeze({
      parentSessionId: request.parentSessionId,
      rootSessionId: request.rootSessionId,
      childSessionId: request.childSessionId,
      taskUserContent: request.taskUserContent,
      timeoutMs: request.timeoutMs,
      signal: request.signal
    });
    const claim = this.dependencies.jobs.claimContinuation(continuation, continuation.childSessionId);
    if (!claim.ok) return Promise.resolve(claim);
    const handle = Object.freeze({ taskId: `task-${randomUUID()}`, childSessionId: continuation.childSessionId });
    const deadlineAt = Date.now() + (continuation.timeoutMs ?? this.dependencies.limits.defaultTimeoutMs);
    const createdAt = new Date().toISOString();
    const record: TaskRecord = {
      ...claim.value.source,
      id: handle.taskId,
      childSessionId: continuation.childSessionId,
      parentSessionId: continuation.parentSessionId,
      rootSessionId: continuation.rootSessionId,
      attempt: claim.value.attempt,
      mode: "background",
      ownedPaths: [],
      timestamps: { createdAt, updatedAt: createdAt },
      status: "blocked"
    };
    return this.dependencies.launcher.startExisting({
      handle,
      owner: continuation,
      profile: claim.value.profile,
      record,
      prompt: continuation.taskUserContent,
      deadlineAt,
      ...(continuation.signal === undefined ? {} : { parentSignal: continuation.signal })
    });
  }

  async cancel(owner: TaskOwner, taskId: string, reason: unknown): Promise<Result<ForegroundTaskResult>> {
    const job = this.dependencies.jobs.owned(owner, taskId);
    if (!job.ok) return this.dependencies.access.result(owner, taskId);
    if (!job.value.controller.signal.aborted) job.value.controller.abort(reason);
    return job.value.terminal;
  }

  async cancelRoot(rootSessionId: string, reason: unknown): Promise<Result<readonly ForegroundTaskResult[]>> {
    const jobs = this.dependencies.jobs.revokeRoot(rootSessionId);
    for (const job of jobs) if (!job.controller.signal.aborted) job.controller.abort(reason);
    const results = await Promise.all(jobs.map(job => job.terminal));
    const retainedFailures = this.dependencies.jobs.takeRootTerminalFailures(rootSessionId);
    const failed = results.find(result => !result.ok && result.error.code !== "CANCELLED");
    if (failed && !failed.ok) return failed;
    const retainedFailure = retainedFailures[0];
    return retainedFailure
      ? err(retainedFailure)
      : ok(Object.freeze(results.flatMap(result => result.ok ? [result.value] : [])));
  }

  shutdown(): Promise<Result<void>> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.dependencies.jobs.stopAccepting();
    this.shutdownPromise = (async () => {
      const jobs = this.dependencies.jobs.allJobs();
      const reason = new StrongCodeError("CANCELLED", "Task manager shutdown");
      for (const job of jobs) if (!job.controller.signal.aborted) job.controller.abort(reason);
      const results = await Promise.all(jobs.map(job => job.terminal));
      const retainedFailures = this.dependencies.jobs.takeAllTerminalFailures();
      this.dependencies.jobs.clear();
      const failed = results.find(result => !result.ok && result.error.code !== "CANCELLED");
      if (failed && !failed.ok) return failed;
      const retainedFailure = retainedFailures[0];
      return retainedFailure ? err(retainedFailure) : ok(undefined);
    })();
    return this.shutdownPromise;
  }
}
