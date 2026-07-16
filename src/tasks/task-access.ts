import { StrongCodeError } from "../core/errors";
import { err, ok, type Result } from "../core/result";
import type { TaskPersistence } from "./admission";
import { BackgroundJobRegistry, type TaskOwner } from "./background-jobs";
import { taskResultFromRecord, type ForegroundTaskResult } from "./execution";
import { NONTERMINAL_TASK_STATUSES, type TaskRecord } from "./types";

const NONTERMINAL_STATUSES = new Set<string>(NONTERMINAL_TASK_STATUSES);

function owns(owner: TaskOwner, record: TaskRecord): boolean {
  return record.parentSessionId === owner.parentSessionId && record.rootSessionId === owner.rootSessionId;
}

function unavailable(): StrongCodeError {
  return new StrongCodeError("PERMISSION_DENIED", "Task is unavailable to this parent and root");
}

export class TaskAccess {
  private initialized = false;

  constructor(
    private readonly tasks: TaskPersistence,
    private readonly jobs: BackgroundJobRegistry
  ) {}

  async initialize(): Promise<Result<readonly TaskRecord[]>> {
    if (this.initialized) return ok([]);
    if (!this.jobs.isAccepting()) return err(new StrongCodeError("TASK_ERROR", "Task manager is shutting down"));
    const listed = await this.tasks.list();
    if (!listed.ok) return listed;
    const reconciled: TaskRecord[] = [];
    for (const record of listed.value) {
      if (!NONTERMINAL_STATUSES.has(record.status)) continue;
      const completedAt = new Date().toISOString();
      const interrupted: TaskRecord = {
        ...record,
        status: "interrupted",
        timestamps: { ...record.timestamps, updatedAt: completedAt, completedAt },
        error: { code: "TASK_INTERRUPTED", message: "Task was interrupted by process restart" }
      };
      const written = await this.tasks.write(interrupted);
      if (!written.ok) return written;
      reconciled.push(interrupted);
    }
    this.initialized = true;
    return ok(Object.freeze(reconciled));
  }

  async list(owner: TaskOwner): Promise<Result<readonly TaskRecord[]>> {
    const listed = await this.tasks.list();
    return listed.ok ? ok(Object.freeze(listed.value.filter(record => owns(owner, record)))) : listed;
  }

  async ownedRecord(owner: TaskOwner, taskId?: string, childSessionId?: string): Promise<Result<TaskRecord>> {
    const listed = await this.tasks.list();
    if (!listed.ok) return listed;
    const record = listed.value.find(candidate => (
      owns(owner, candidate)
      && (taskId === undefined || candidate.id === taskId)
      && (childSessionId === undefined || candidate.childSessionId === childSessionId)
    ));
    return record ? ok(record) : err(unavailable());
  }

  async recordById(taskId: string): Promise<Result<TaskRecord>> {
    const listed = await this.tasks.list();
    if (!listed.ok) return listed;
    const record = listed.value.find(candidate => candidate.id === taskId);
    return record ? ok(record) : err(new StrongCodeError("TASK_ERROR", `Task record not found: ${taskId}`));
  }

  async terminalResultById(taskId: string): Promise<Result<ForegroundTaskResult | undefined>> {
    const record = await this.recordById(taskId);
    if (!record.ok) return record;
    return NONTERMINAL_STATUSES.has(record.value.status)
      ? ok(undefined)
      : ok(taskResultFromRecord(record.value));
  }

  async result(owner: TaskOwner, taskId: string): Promise<Result<ForegroundTaskResult>> {
    const terminalFailure = this.jobs.terminalFailure(owner, taskId);
    if (!terminalFailure.ok) return terminalFailure;
    if (terminalFailure.value) return err(terminalFailure.value);
    const record = await this.ownedRecord(owner, taskId);
    if (!record.ok) return record;
    if (NONTERMINAL_STATUSES.has(record.value.status)) {
      return err(new StrongCodeError("TASK_ERROR", `Task '${taskId}' is not terminal`));
    }
    return ok(taskResultFromRecord(record.value));
  }

  async wait(owner: TaskOwner, taskIds: readonly string[]): Promise<Result<readonly ForegroundTaskResult[]>> {
    if (new Set(taskIds).size !== taskIds.length) {
      return err(new StrongCodeError("VALIDATION_ERROR", "Task wait ids must be unique"));
    }
    const terminalFailures: (StrongCodeError | undefined)[] = [];
    for (const taskId of taskIds) {
      const terminalFailure = this.jobs.terminalFailure(owner, taskId);
      if (!terminalFailure.ok) return terminalFailure;
      terminalFailures.push(terminalFailure.value);
    }
    const localJobs = taskIds.map(taskId => this.jobs.owned(owner, taskId));
    const listed = await this.tasks.list();
    if (!listed.ok) return listed;
    const records = taskIds.map(taskId => listed.value.find(record => record.id === taskId && owns(owner, record)));
    if (records.some((record, index) => (
      record === undefined && !localJobs[index]?.ok && terminalFailures[index] === undefined
    ))) return err(unavailable());
    const results = await Promise.all(taskIds.map(async (taskId, index) => {
      const terminalFailure = terminalFailures[index];
      if (terminalFailure) return err(terminalFailure);
      const local = localJobs[index];
      if (local.ok) return local.value.terminal;
      if (!records[index]) return err(unavailable());
      const terminal = await this.terminalResultById(taskId);
      if (!terminal.ok) return terminal;
      return terminal.value
        ? ok(terminal.value)
        : err(new StrongCodeError("TASK_ERROR", `Task '${taskId}' is not terminal`));
    }));
    const failed = results.find(result => !result.ok);
    return failed && !failed.ok ? failed : ok(Object.freeze(results.flatMap(result => result.ok ? [result.value] : [])));
  }
}
