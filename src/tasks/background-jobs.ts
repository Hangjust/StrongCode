import type { SpawnTarget } from "../agents/spawn-targets";
import { StrongCodeError } from "../core/errors";
import { err, ok, type Result } from "../core/result";
import type { ChildFactoryOutput } from "../runtime/child-factory";
import type { ForegroundTaskResult } from "./execution";
import type { TaskRecord } from "./types";

export type TaskOwner = {
  readonly parentSessionId: string;
  readonly rootSessionId: string;
};

export type BackgroundTaskHandle = Readonly<{
  readonly taskId: string;
  readonly childSessionId: string;
}>;

export type BackgroundSpawnProfile = Readonly<{
  readonly target: SpawnTarget;
  readonly child: ChildFactoryOutput;
  readonly writePaths: readonly string[];
}>;

export type BackgroundJob = Readonly<{
  readonly handle: BackgroundTaskHandle;
  readonly owner: TaskOwner;
  readonly controller: AbortController;
  readonly terminal: Promise<Result<ForegroundTaskResult>>;
}>;

type BackgroundTerminalFailure = Readonly<{
  readonly taskId: string;
  readonly owner: TaskOwner;
  readonly error: StrongCodeError;
}>;

export type BackgroundContinuationClaim = Readonly<{
  readonly profile: Promise<Result<BackgroundSpawnProfile>>;
  readonly source: TaskRecord;
  readonly attempt: number;
}>;

export type BackgroundTurn<T> = Readonly<{
  readonly promise: Promise<T>;
  remove(result: T): boolean;
}>;

type BackgroundProfile = {
  readonly owner: TaskOwner;
  readonly value: Promise<Result<BackgroundSpawnProfile>>;
  readonly source: TaskRecord;
  nextAttempt: number;
};

type TurnEntry = {
  readonly token: symbol;
  active: boolean;
  start(): void;
};

function unavailable(): StrongCodeError {
  return new StrongCodeError("PERMISSION_DENIED", "Task is unavailable to this parent and root");
}

export class BackgroundJobRegistry {
  private readonly jobs = new Map<string, BackgroundJob>();
  private readonly profiles = new Map<string, BackgroundProfile>();
  private readonly turns = new Map<string, TurnEntry[]>();
  // The first entry revokes its root; only already-registered, admission-bounded jobs can add more.
  // Root cancellation and shutdown drain all entries in their scope.
  private readonly terminalFailures = new Map<string, BackgroundTerminalFailure>();
  private readonly revokedRoots = new Set<string>();
  private accepting = true;

  canStart(rootSessionId: string): Result<void> {
    if (!this.accepting) return err(new StrongCodeError("TASK_ERROR", "Task manager is shutting down"));
    if (this.revokedRoots.has(rootSessionId)) return err(new StrongCodeError("PERMISSION_DENIED", "Task root has been cancelled"));
    return ok(undefined);
  }

  register(
    job: BackgroundJob,
    profile: Promise<Result<BackgroundSpawnProfile>>,
    source: TaskRecord
  ): Result<void> {
    const allowed = this.canStart(job.owner.rootSessionId);
    if (!allowed.ok) return allowed;
    if (this.jobs.has(job.handle.taskId) || this.terminalFailures.has(job.handle.taskId)) {
      return err(new StrongCodeError("TASK_ERROR", "Background task id is already registered"));
    }
    const retained = this.profiles.get(job.handle.childSessionId);
    if (retained && (retained.owner.parentSessionId !== job.owner.parentSessionId
      || retained.owner.rootSessionId !== job.owner.rootSessionId)) return err(unavailable());
    if (!retained) this.retainProfile(job, profile, source);
    this.jobs.set(job.handle.taskId, Object.freeze(job));
    return ok(undefined);
  }

  claimContinuation(owner: TaskOwner, childSessionId: string): Result<BackgroundContinuationClaim> {
    const allowed = this.canStart(owner.rootSessionId);
    if (!allowed.ok) return allowed;
    const profile = this.profiles.get(childSessionId);
    if (!profile || profile.owner.parentSessionId !== owner.parentSessionId
      || profile.owner.rootSessionId !== owner.rootSessionId) return err(unavailable());
    const attempt = profile.nextAttempt;
    profile.nextAttempt += 1;
    return ok(Object.freeze({ profile: profile.value, source: profile.source, attempt }));
  }

  complete(job: BackgroundJob): void {
    if (this.jobs.get(job.handle.taskId) === job) this.jobs.delete(job.handle.taskId);
  }

  retainTerminalFailure(job: BackgroundJob, error: StrongCodeError): void {
    const owner = Object.freeze({
      parentSessionId: job.owner.parentSessionId,
      rootSessionId: job.owner.rootSessionId
    });
    this.revokedRoots.add(owner.rootSessionId);
    this.terminalFailures.set(job.handle.taskId, Object.freeze({ taskId: job.handle.taskId, owner, error }));
    for (const [childSessionId, profile] of this.profiles) {
      if (profile.owner.rootSessionId === owner.rootSessionId) this.profiles.delete(childSessionId);
    }
  }

  terminalFailure(owner: TaskOwner, taskId: string): Result<StrongCodeError | undefined> {
    const failure = this.terminalFailures.get(taskId);
    if (!failure) return ok(undefined);
    return failure.owner.parentSessionId === owner.parentSessionId && failure.owner.rootSessionId === owner.rootSessionId
      ? ok(failure.error)
      : err(unavailable());
  }

  takeRootTerminalFailures(rootSessionId: string): readonly StrongCodeError[] {
    const errors: StrongCodeError[] = [];
    for (const [taskId, failure] of this.terminalFailures) {
      if (failure.owner.rootSessionId !== rootSessionId) continue;
      errors.push(failure.error);
      this.terminalFailures.delete(taskId);
    }
    return Object.freeze(errors);
  }

  takeAllTerminalFailures(): readonly StrongCodeError[] {
    const errors = Object.freeze([...this.terminalFailures.values()].map(failure => failure.error));
    this.terminalFailures.clear();
    return errors;
  }

  owned(owner: TaskOwner, taskId: string): Result<BackgroundJob> {
    const job = this.jobs.get(taskId);
    if (!job || job.owner.parentSessionId !== owner.parentSessionId || job.owner.rootSessionId !== owner.rootSessionId) {
      return err(unavailable());
    }
    return ok(job);
  }

  rootJobs(rootSessionId: string): readonly BackgroundJob[] {
    return [...this.jobs.values()].filter(job => job.owner.rootSessionId === rootSessionId);
  }

  allJobs(): readonly BackgroundJob[] {
    return [...this.jobs.values()];
  }

  revokeRoot(rootSessionId: string): readonly BackgroundJob[] {
    this.revokedRoots.add(rootSessionId);
    for (const [childSessionId, profile] of this.profiles) {
      if (profile.owner.rootSessionId === rootSessionId) this.profiles.delete(childSessionId);
    }
    return this.rootJobs(rootSessionId);
  }

  enqueueTurn<T>(childSessionId: string, operation: () => Promise<T>): BackgroundTurn<T> {
    let resolvePromise: ((value: T) => void) | undefined;
    let rejectPromise: ((reason: unknown) => void) | undefined;
    const promise = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    if (!resolvePromise || !rejectPromise) throw new StrongCodeError("TASK_ERROR", "Turn promise was not initialized");
    const resolveTurn = resolvePromise;
    const rejectTurn = rejectPromise;
    let operationReference: (() => Promise<T>) | undefined = operation;
    const token = Symbol(childSessionId);
    const finish = (): void => this.finishTurn(childSessionId, token);
    const entry: TurnEntry = {
      token,
      active: false,
      start: () => {
        entry.active = true;
        const current = operationReference;
        operationReference = undefined;
        if (!current) return;
        current().then(
          value => { resolveTurn(value); finish(); },
          reason => { rejectTurn(reason); finish(); }
        );
      }
    };
    const queue = this.turns.get(childSessionId) ?? [];
    queue.push(entry);
    this.turns.set(childSessionId, queue);
    this.drainTurn(childSessionId);
    return Object.freeze({
      promise,
      remove: (result: T): boolean => {
        if (entry.active) return false;
        const index = queue.findIndex(candidate => candidate.token === token);
        if (index < 0) return false;
        operationReference = undefined;
        queue.splice(index, 1);
        resolveTurn(result);
        if (queue.length === 0) this.turns.delete(childSessionId);
        this.drainTurn(childSessionId);
        return true;
      }
    });
  }

  stopAccepting(): void {
    this.accepting = false;
  }

  isAccepting(): boolean {
    return this.accepting;
  }

  clear(): void {
    this.jobs.clear();
    this.profiles.clear();
    this.turns.clear();
    this.terminalFailures.clear();
  }

  private retainProfile(
    job: BackgroundJob,
    value: Promise<Result<BackgroundSpawnProfile>>,
    source: TaskRecord
  ): void {
    const profile: BackgroundProfile = { owner: job.owner, value, source, nextAttempt: source.attempt + 1 };
    this.profiles.set(job.handle.childSessionId, profile);
    value.then(
      result => { if (!result.ok && this.profiles.get(job.handle.childSessionId) === profile) this.profiles.delete(job.handle.childSessionId); },
      () => { if (this.profiles.get(job.handle.childSessionId) === profile) this.profiles.delete(job.handle.childSessionId); }
    );
  }

  private finishTurn(childSessionId: string, token: symbol): void {
    const queue = this.turns.get(childSessionId);
    if (!queue) return;
    const index = queue.findIndex(entry => entry.token === token);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) this.turns.delete(childSessionId);
    this.drainTurn(childSessionId);
  }

  private drainTurn(childSessionId: string): void {
    const first = this.turns.get(childSessionId)?.[0];
    if (first && !first.active) first.start();
  }
}
