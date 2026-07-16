import { StrongCodeError } from "../core/errors";
import { err, ok, type Result } from "../core/result";
import {
  WriteOwnershipRegistry,
  type WriteOwnershipReservation
} from "./ownership";
import { AdmissionAttempt, type AdmissionCancellation } from "./admission-attempt";
import type {
  AdmissionLease,
  AdmissionLimits,
  AdmissionRequest,
  AdmissionTicket,
  TaskPersistence
} from "./admission-types";
import { boundTaskText, TASK_ERROR_MESSAGE_MAX_UNITS } from "./text-bounds";
import type { TaskRecord } from "./types";

export type { AdmissionLease, AdmissionLimits, AdmissionRequest, AdmissionTicket, TaskPersistence } from "./admission-types";

type ActiveLease = {
  readonly token: symbol;
  readonly request: AdmissionRequest;
  readonly queuedRecord: TaskRecord;
  readonly ownership?: WriteOwnershipReservation;
  started: boolean;
};

type Waiter = {
  readonly sequence: number;
  readonly attempt: AdmissionAttempt;
  readonly request: AdmissionRequest;
  readonly queuedRecord: TaskRecord;
  readonly ownership?: WriteOwnershipReservation;
  readonly resolve: (result: Result<AdmissionLease>) => void;
  cancellationScheduled: boolean;
};

type AdmissionSettlers = {
  readonly admission: (result: Result<AdmissionLease>) => void;
  readonly registration: (result: Result<AdmissionTicket>) => void;
};

type EnqueueInput = {
  readonly request: AdmissionRequest;
  readonly attempt: AdmissionAttempt;
  readonly settlers: AdmissionSettlers;
  readonly admission: Promise<Result<AdmissionLease>>;
};

export class TaskAdmissionTimeoutError extends StrongCodeError {
  readonly name = "TaskAdmissionTimeoutError";

  constructor(taskId: string) {
    super("TASK_ERROR", `Task '${taskId}' timed out while waiting for admission`);
  }
}

function cancellationError(reason: unknown): StrongCodeError {
  const detail = reason instanceof Error
    ? reason.message
    : reason === undefined ? "Task admission was cancelled" : String(reason);
  const message = boundTaskText(detail, TASK_ERROR_MESSAGE_MAX_UNITS) || "Task admission was cancelled";
  return new StrongCodeError("CANCELLED", message);
}

export class AdmissionQueue {
  private readonly waiters: Waiter[] = [];
  private readonly active = new Map<symbol, ActiveLease>();
  private readonly pendingRoots = new Map<string, Readonly<{ rootSessionId: string; childSessionId: string }>>();
  private sequence = 0;
  private activeCount = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly limits: AdmissionLimits,
    private readonly tasks: TaskPersistence,
    private readonly ownership = new WriteOwnershipRegistry()
  ) {}

  async acquire(request: AdmissionRequest): Promise<Result<AdmissionLease>> {
    const registered = await this.register(request);
    return registered.ok ? registered.value.admission : registered;
  }

  async register(request: AdmissionRequest): Promise<Result<AdmissionTicket>> {
    const attempt = new AdmissionAttempt({
      timeoutMs: request.timeoutMs,
      timeoutError: new TaskAdmissionTimeoutError(request.queuedRecord.id),
      cancellationError,
      ...(request.signal === undefined ? {} : { signal: request.signal })
    });
    let settleAdmission: ((result: Result<AdmissionLease>) => void) | undefined;
    const admission = new Promise<Result<AdmissionLease>>(resolve => {
      settleAdmission = resolve;
    });
    let settleRegistration: ((result: Result<AdmissionTicket>) => void) | undefined;
    const registration = new Promise<Result<AdmissionTicket>>(resolve => {
      settleRegistration = resolve;
    });
    if (!settleAdmission || !settleRegistration) {
      throw new StrongCodeError("TASK_ERROR", "Admission promises were not initialized");
    }
    const settlers: AdmissionSettlers = {
      admission: settleAdmission,
      registration: settleRegistration
    };
    await this.exclusive(() => this.enqueue({ request, attempt, settlers, admission }));
    return registration;
  }

  private async enqueue(input: EnqueueInput): Promise<void> {
    const { request, attempt, settlers, admission } = input;
    const cancelledBeforeList = attempt.currentCancellation();
    if (cancelledBeforeList) {
      this.finishRegistration(attempt, settlers, err(cancelledBeforeList.error));
      return;
    }
    const listed = await this.tasks.list();
    const cancelledAfterList = attempt.currentCancellation();
    if (cancelledAfterList) {
      this.finishRegistration(attempt, settlers, err(cancelledAfterList.error));
      return;
    }
    if (!listed.ok) {
      this.finishRegistration(attempt, settlers, listed);
      return;
    }
    const acceptedChildren = new Set(listed.value.filter(record => (
      record.rootSessionId === request.queuedRecord.rootSessionId
      && record.timestamps.startedAt !== undefined
    )).map(record => record.childSessionId));
    for (const pending of this.pendingRoots.values()) {
      if (pending.rootSessionId === request.queuedRecord.rootSessionId) acceptedChildren.add(pending.childSessionId);
    }
    if (!acceptedChildren.has(request.queuedRecord.childSessionId)
      && acceptedChildren.size >= this.limits.maxChildrenPerRoot) {
      this.finishRegistration(attempt, settlers, err(new StrongCodeError(
        "TASK_ERROR",
        `Root '${request.queuedRecord.rootSessionId}' reached the ${this.limits.maxChildrenPerRoot}-child limit`
      )));
      return;
    }

    const reserved = request.writePaths.length === 0
      ? ok<WriteOwnershipReservation | undefined>(undefined)
      : await this.ownership.reserve({
        context: request.context,
        ownerId: request.queuedRecord.id,
        writePaths: request.writePaths
      });
    const cancelledAfterOwnership = attempt.currentCancellation();
    if (cancelledAfterOwnership) {
      if (reserved.ok) reserved.value?.release();
      this.finishRegistration(attempt, settlers, err(cancelledAfterOwnership.error));
      return;
    }
    if (!reserved.ok) {
      this.finishRegistration(attempt, settlers, reserved);
      return;
    }
    const queuedRecord: TaskRecord = {
      ...request.queuedRecord,
      ownedPaths: [...(reserved.value?.paths ?? [])]
    };
    this.pendingRoots.set(queuedRecord.id, {
      rootSessionId: queuedRecord.rootSessionId,
      childSessionId: queuedRecord.childSessionId
    });
    const persisted = await this.tasks.write(queuedRecord);
    const cancelledAfterPersistence = attempt.currentCancellation();
    if (cancelledAfterPersistence && !persisted.ok) {
      this.pendingRoots.delete(queuedRecord.id);
      reserved.value?.release();
      this.finishRegistration(attempt, settlers, err(cancelledAfterPersistence.error));
      return;
    }
    if (!persisted.ok) {
      this.pendingRoots.delete(queuedRecord.id);
      reserved.value?.release();
      this.finishRegistration(attempt, settlers, persisted);
      return;
    }

    const waiter: Waiter = {
      sequence: this.sequence,
      attempt,
      request,
      queuedRecord,
      ...(reserved.value === undefined ? {} : { ownership: reserved.value }),
      resolve: settlers.admission,
      cancellationScheduled: false
    };
    attempt.onCancellation(cancellation => this.scheduleCancellation(waiter, cancellation));
    this.sequence += 1;
    this.waiters.push(waiter);
    settlers.registration(ok(Object.freeze({ queuedRecord, admission })));
    const cancellationBeforeDrain = attempt.currentCancellation();
    if (cancellationBeforeDrain) {
      this.scheduleCancellation(waiter, cancellationBeforeDrain);
      return;
    }
    this.drain();
  }

  private scheduleCancellation(waiter: Waiter, cancellation: AdmissionCancellation): void {
    if (waiter.cancellationScheduled) return;
    waiter.cancellationScheduled = true;
    this.tail = this.tail.then(() => this.cancelWaiter(waiter, cancellation));
  }

  private async cancelWaiter(waiter: Waiter, cancellation: AdmissionCancellation): Promise<void> {
    const index = this.waiters.indexOf(waiter);
    if (index < 0) return;
    this.waiters.splice(index, 1);
    this.cleanupWaiter(waiter);
    this.pendingRoots.delete(waiter.queuedRecord.id);
    waiter.ownership?.release();
    const completedAt = new Date().toISOString();
    const persisted = await this.tasks.write({
      ...waiter.queuedRecord,
      status: cancellation.status,
      timestamps: { ...waiter.queuedRecord.timestamps, updatedAt: completedAt, completedAt },
      error: {
        code: cancellation.error.code,
        message: boundTaskText(cancellation.error.message, TASK_ERROR_MESSAGE_MAX_UNITS) || cancellation.error.code
      }
    });
    waiter.resolve(persisted.ok ? err(cancellation.error) : persisted);
    this.drain();
  }

  private drain(): void {
    while (this.activeCount < this.limits.maxActive && this.waiters.length > 0) {
      this.waiters.sort((left, right) => left.sequence - right.sequence);
      const waiter = this.waiters.shift();
      if (!waiter) return;
      this.cleanupWaiter(waiter);
      const token = Symbol(waiter.queuedRecord.id);
      const state: ActiveLease = {
        token,
        request: waiter.request,
        queuedRecord: waiter.queuedRecord,
        ...(waiter.ownership === undefined ? {} : { ownership: waiter.ownership }),
        started: false
      };
      this.active.set(token, state);
      this.activeCount += 1;
      waiter.resolve(ok(Object.freeze({
        taskId: waiter.queuedRecord.id,
        queuedRecord: waiter.queuedRecord,
        ownershipPaths: waiter.ownership?.paths ?? Object.freeze([]),
        deadlineAt: waiter.attempt.deadlineAt,
        markStarted: record => this.exclusive(() => this.markStarted(token, record)),
        release: () => this.exclusive(() => this.release(token))
      })));
    }
  }

  private async markStarted(token: symbol, record: TaskRecord): Promise<Result<void>> {
    const state = this.active.get(token);
    if (!state) return err(new StrongCodeError("TASK_ERROR", "Admission lease is no longer active"));
    const persisted = await this.tasks.write(record);
    if (!persisted.ok) return persisted;
    state.started = true;
    this.pendingRoots.delete(state.queuedRecord.id);
    return ok(undefined);
  }

  private release(token: symbol): void {
    const state = this.active.get(token);
    if (!state) return;
    this.active.delete(token);
    this.activeCount -= 1;
    if (!state.started) this.pendingRoots.delete(state.queuedRecord.id);
    state.ownership?.release();
    this.drain();
  }

  private cleanupWaiter(waiter: Waiter): void {
    this.cleanupAttempt(waiter.attempt);
  }

  private finishRegistration(
    attempt: AdmissionAttempt,
    settlers: AdmissionSettlers,
    result: Result<never>
  ): void {
    this.cleanupAttempt(attempt);
    settlers.admission(result);
    settlers.registration(result);
  }

  private cleanupAttempt(attempt: AdmissionAttempt): void {
    attempt.cleanup();
  }

  private async exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    const current = this.tail.then(operation, operation);
    this.tail = current.then(() => undefined, () => undefined);
    return current;
  }
}
