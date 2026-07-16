import type { Result } from "../core/result";
import type { RuntimeContext } from "../runtime/context";
import type { TaskRecord } from "./types";

export type AdmissionLimits = {
  readonly maxActive: number;
  readonly maxChildrenPerRoot: number;
};

export interface TaskPersistence {
  write(record: unknown): Promise<Result<void>>;
  list(): Promise<Result<TaskRecord[]>>;
}

export type AdmissionRequest = {
  readonly context: RuntimeContext;
  readonly queuedRecord: TaskRecord;
  readonly writePaths: readonly string[];
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
};

export type AdmissionLease = {
  readonly taskId: string;
  readonly queuedRecord: TaskRecord;
  readonly ownershipPaths: readonly string[];
  readonly deadlineAt: number;
  markStarted(record: TaskRecord): Promise<Result<void>>;
  release(): Promise<void>;
};

export type AdmissionTicket = {
  readonly queuedRecord: TaskRecord;
  readonly admission: Promise<Result<AdmissionLease>>;
};
