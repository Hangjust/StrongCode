import type { ChildFactoryInput } from "../runtime/child-factory";
import type { RuntimeContext } from "../runtime/context";
import { StrongCodeError } from "../core/errors";
import { err, ok, type Result } from "../core/result";
import type { AdmissionQueue, AdmissionTicket, TaskPersistence } from "./admission";
import {
  BackgroundJobRegistry,
  type BackgroundSpawnProfile,
  type BackgroundTaskHandle,
  type TaskOwner
} from "./background-jobs";
import {
  backgroundTerminalStatus,
  persistBackgroundTerminal,
  startBackgroundLifecycle
} from "./background-terminal";
import type { ForegroundTaskResult } from "./execution";
import type { TaskAccess } from "./task-access";
import type { PreparedTask } from "./task-manager-types";
import type { TaskRuntime, TaskRuntimeProfile } from "./task-runtime";
import type { TaskRecord } from "./types";

type Deferred<T> = { readonly promise: Promise<T>; readonly resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>(resolve => { settle = resolve; });
  if (!settle) throw new StrongCodeError("TASK_ERROR", "Task promise was not initialized");
  return { promise, resolve: settle };
}

function ownerOf(record: TaskRecord): TaskOwner {
  return Object.freeze({ parentSessionId: record.parentSessionId, rootSessionId: record.rootSessionId });
}

type LauncherDependencies = {
  readonly context: RuntimeContext;
  readonly tasks: TaskPersistence;
  readonly admission: AdmissionQueue;
  readonly jobs: BackgroundJobRegistry;
  readonly runtime: TaskRuntime;
  readonly access: TaskAccess;
};

type ExecutionInput = {
  readonly handle: BackgroundTaskHandle;
  readonly ready: (result: Result<BackgroundTaskHandle>) => void;
  readonly record: TaskRecord;
  readonly writePaths: readonly string[];
  readonly timeoutMs: number;
  readonly prompt: string;
  readonly persistPreRuntime: boolean;
  readonly execute: (ticket: AdmissionTicket, prompt: string) => Promise<Result<ForegroundTaskResult>>;
};

type ExistingStartInput = {
  readonly handle: BackgroundTaskHandle;
  readonly owner: TaskOwner;
  readonly profile: Promise<Result<BackgroundSpawnProfile>>;
  readonly record: TaskRecord;
  readonly prompt: string;
  readonly deadlineAt: number;
  readonly parentSignal?: AbortSignal;
};

export class BackgroundLauncher {
  constructor(private readonly dependencies: LauncherDependencies) {}

  startPrepared(prepared: PreparedTask, parentSignal?: AbortSignal): Promise<Result<BackgroundTaskHandle>> {
    const profile = deferred<Result<BackgroundSpawnProfile>>();
    let profileSettled = false;
    const settleProfile = (result: Result<TaskRuntimeProfile>): void => {
      if (profileSettled) return;
      profileSettled = true;
      profile.resolve(result.ok
        ? ok(Object.freeze({ target: prepared.target, child: result.value.child, writePaths: prepared.writePaths }))
        : result);
    };
    const handle = Object.freeze({ taskId: prepared.queuedRecord.id, childSessionId: prepared.queuedRecord.childSessionId });
    const deadlineAt = Date.now() + prepared.timeoutMs;
    return startBackgroundLifecycle({ tasks: this.dependencies.tasks, jobs: this.dependencies.jobs }, {
      handle,
      owner: ownerOf(prepared.queuedRecord),
      profile: profile.promise,
      source: prepared.queuedRecord,
      deadlineAt,
      ...(parentSignal === undefined ? {} : { parentSignal }),
      operation: async (controller, ready) => {
        const result = await this.registerAndExecute({
          handle,
          ready,
          record: prepared.queuedRecord,
          writePaths: prepared.writePaths,
          timeoutMs: Math.max(0, deadlineAt - Date.now()),
          prompt: prepared.childInput.taskUserContent,
          persistPreRuntime: false,
          execute: (ticket, prompt) => this.executeTicket({ ticket, controller, prompt, createChild: prepared.childInput, settleProfile, persistPreRuntime: false })
        }, controller);
        if (!profileSettled) settleProfile(result.ok
          ? err(new StrongCodeError("TASK_ERROR", "Task ended before its spawn profile was created"))
          : result);
        return result;
      },
      onFailure: result => settleProfile(result)
    });
  }

  startExisting(input: ExistingStartInput): Promise<Result<BackgroundTaskHandle>> {
    return startBackgroundLifecycle({ tasks: this.dependencies.tasks, jobs: this.dependencies.jobs }, {
      handle: input.handle,
      owner: input.owner,
      profile: input.profile,
      source: input.record,
      blockedRecord: input.record,
      deadlineAt: input.deadlineAt,
      ...(input.parentSignal === undefined ? {} : { parentSignal: input.parentSignal }),
      operation: async (controller, ready) => {
        const profile = await input.profile;
        if (!profile.ok) return persistBackgroundTerminal({
          tasks: this.dependencies.tasks,
          record: input.record,
          status: "failed",
          error: profile.error
        });
        const updatedAt = new Date().toISOString();
        const queued: TaskRecord = {
          ...input.record,
          status: "queued",
          model: profile.value.child.agent.modelResolution?.modelId ?? profile.value.child.agent.config.model,
          timestamps: { ...input.record.timestamps, updatedAt }
        };
        const transitioned = await this.dependencies.tasks.write(queued);
        if (!transitioned.ok) return persistBackgroundTerminal({
          tasks: this.dependencies.tasks,
          record: input.record,
          status: "failed",
          error: transitioned.error
        });
        const runtimeProfile = Object.freeze({ child: profile.value.child, writePaths: profile.value.writePaths });
        return this.registerAndExecute({
          handle: input.handle,
          ready,
          record: queued,
          writePaths: profile.value.writePaths,
          timeoutMs: Math.max(0, input.deadlineAt - Date.now()),
          prompt: input.prompt,
          persistPreRuntime: true,
          execute: (ticket, prompt) => this.executeTicket({ ticket, controller, prompt, profile: runtimeProfile, persistPreRuntime: true })
        }, controller);
      }
    });
  }

  private async registerAndExecute(input: ExecutionInput, controller: AbortController): Promise<Result<ForegroundTaskResult>> {
    const registered = await this.dependencies.admission.register({
      context: this.dependencies.context,
      queuedRecord: input.record,
      writePaths: input.writePaths,
      timeoutMs: input.timeoutMs,
      signal: controller.signal
    });
    if (!registered.ok) return input.persistPreRuntime
      ? persistBackgroundTerminal({ tasks: this.dependencies.tasks, record: input.record, status: backgroundTerminalStatus(registered.error, controller), error: registered.error })
      : registered;
    input.ready(ok(input.handle));
    return input.execute(registered.value, input.prompt);
  }

  private async executeTicket(input: Readonly<{
    ticket: AdmissionTicket;
    controller: AbortController;
    prompt: string;
    createChild?: ChildFactoryInput;
    profile?: TaskRuntimeProfile;
    settleProfile?: (result: Result<TaskRuntimeProfile>) => void;
    persistPreRuntime: boolean;
  }>): Promise<Result<ForegroundTaskResult>> {
    const admitted = await input.ticket.admission;
    if (!admitted.ok) {
      input.settleProfile?.(admitted);
      const terminal = await this.dependencies.access.terminalResultById(input.ticket.queuedRecord.id);
      if (!terminal.ok) return terminal;
      if (terminal.value) return ok(terminal.value);
      return input.persistPreRuntime
        ? persistBackgroundTerminal({ tasks: this.dependencies.tasks, record: input.ticket.queuedRecord, status: backgroundTerminalStatus(admitted.error, input.controller), error: admitted.error })
        : admitted;
    }
    return this.dependencies.runtime.execute({
      lease: admitted.value,
      controller: input.controller,
      prompt: input.prompt,
      ...(input.createChild === undefined ? {} : { createChild: input.createChild }),
      ...(input.profile === undefined ? {} : { profile: input.profile }),
      ...(input.settleProfile === undefined ? {} : { onProfile: input.settleProfile })
    });
  }
}
