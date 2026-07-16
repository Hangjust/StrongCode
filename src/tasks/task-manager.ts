import { delegationDefaults, type DelegationConfig } from "../config/runtime-config";
import { StrongCodeError } from "../core/errors";
import { err, type Result } from "../core/result";
import { createChildAgent } from "../runtime/child-factory";
import type { ToolInvocationContext } from "../runtime/context";
import { AdmissionQueue, type TaskPersistence } from "./admission";
import { BackgroundJobRegistry, type BackgroundTaskHandle, type TaskOwner } from "./background-jobs";
import { BackgroundLauncher } from "./background-launcher";
import type { ForegroundTaskResult } from "./execution";
import { WriteOwnershipRegistry } from "./ownership";
import { TaskAccess } from "./task-access";
import {
  linkedController,
  prepareTask
} from "./task-preparation";
import { TaskRuntime } from "./task-runtime";
import { TaskStore } from "./task-store";
import { TaskSupervisor } from "./task-supervisor";
import type { TaskRecord } from "./types";
import type {
  ChildRunner,
  ContinuationTaskRequest,
  ForegroundTaskRequest,
  TaskManagerOptions
} from "./task-manager-types";

export type {
  ChildRunner,
  ContinuationTaskRequest,
  ForegroundTaskRequest,
  TaskManagerOptions
} from "./task-manager-types";

export class TaskManager {
  static readonly defaultChildFactory = createChildAgent;

  private readonly tasks: TaskPersistence;
  private readonly limits: DelegationConfig;
  private readonly admission: AdmissionQueue;
  private readonly access: TaskAccess;
  private readonly supervisor: TaskSupervisor;
  private readonly runtime: TaskRuntime;

  constructor(private readonly options: TaskManagerOptions) {
    this.tasks = options.taskStore ?? new TaskStore(options.context.dataDir);
    const configured = options.limits ?? options.context.config.delegation ?? delegationDefaults;
    this.limits = {
      ...configured,
      maxActive: Math.min(configured.maxActive, delegationDefaults.maxActive),
      maxChildrenPerRoot: Math.min(configured.maxChildrenPerRoot, delegationDefaults.maxChildrenPerRoot)
    };
    const jobs = new BackgroundJobRegistry();
    this.admission = new AdmissionQueue(
      { maxActive: this.limits.maxActive, maxChildrenPerRoot: this.limits.maxChildrenPerRoot },
      this.tasks,
      options.ownership ?? new WriteOwnershipRegistry()
    );
    this.access = new TaskAccess(this.tasks, jobs);
    this.runtime = new TaskRuntime({
      context: options.context,
      tasks: this.tasks,
      limits: this.limits,
      childFactory: options.childFactory ?? TaskManager.defaultChildFactory,
      createRunner: options.createRunner ?? this.defaultRunner(options)
    });
    const launcher = new BackgroundLauncher({
      context: options.context,
      tasks: this.tasks,
      admission: this.admission,
      jobs,
      runtime: this.runtime,
      access: this.access
    });
    this.supervisor = new TaskSupervisor({ jobs, access: this.access, launcher, limits: this.limits });
  }

  initialize(): Promise<Result<readonly TaskRecord[]>> {
    return this.access.initialize();
  }

  async runForeground(request: ForegroundTaskRequest): Promise<Result<ForegroundTaskResult>> {
    const prepared = prepareTask({ options: this.options, limits: this.limits, request, mode: "foreground" });
    if (!prepared.ok) return prepared;
    const linked = linkedController(request.signal);
    try {
      const admitted = await this.admission.acquire({
        context: this.options.context,
        queuedRecord: prepared.value.queuedRecord,
        writePaths: prepared.value.writePaths,
        timeoutMs: prepared.value.timeoutMs,
        signal: linked.controller.signal
      });
      if (!admitted.ok) return admitted;
      return await this.runtime.execute({
        lease: admitted.value,
        controller: linked.controller,
        prompt: request.taskUserContent,
        createChild: prepared.value.childInput
      });
    } finally {
      linked.cleanup();
    }
  }

  startBackground(request: ForegroundTaskRequest): Promise<Result<BackgroundTaskHandle>> {
    const prepared = prepareTask({ options: this.options, limits: this.limits, request, mode: "background" });
    return prepared.ok ? this.supervisor.start(prepared.value, request.signal) : Promise.resolve(prepared);
  }

  continueBackground(request: ContinuationTaskRequest): Promise<Result<BackgroundTaskHandle>> {
    return this.supervisor.continue(request);
  }

  listTasks(owner: TaskOwner): Promise<Result<readonly TaskRecord[]>> {
    return this.access.list(owner);
  }

  getTaskStatus(owner: TaskOwner, taskId: string): Promise<Result<TaskRecord>> {
    return this.access.ownedRecord(owner, taskId);
  }

  getTaskResult(owner: TaskOwner, taskId: string): Promise<Result<ForegroundTaskResult>> {
    return this.access.result(owner, taskId);
  }

  waitForTasks(owner: TaskOwner, taskIds: readonly string[]): Promise<Result<readonly ForegroundTaskResult[]>> {
    return this.access.wait(owner, taskIds);
  }

  cancelTask(
    owner: TaskOwner,
    taskId: string,
    reason: unknown = new StrongCodeError("CANCELLED", "Task was cancelled")
  ): Promise<Result<ForegroundTaskResult>> {
    return this.supervisor.cancel(owner, taskId, reason);
  }

  cancelRoot(
    rootSessionId: string,
    reason: unknown = new StrongCodeError("CANCELLED", "Root was cancelled")
  ): Promise<Result<readonly ForegroundTaskResult[]>> {
    return this.supervisor.cancelRoot(rootSessionId, reason);
  }

  shutdown(): Promise<Result<void>> {
    return this.supervisor.shutdown();
  }

  private defaultRunner(options: TaskManagerOptions): (context: ToolInvocationContext) => ChildRunner {
    return context => ({
      run: async (agent, prompt, sessionId) => {
        if (!options.sessions || !options.tools) {
          return err(new StrongCodeError("TASK_ERROR", "Task manager requires sessions and tools for default execution"));
        }
        const { AgentRunner } = await import("../agents/runner");
        return new AgentRunner(context, options.sessions, options.tools).run(agent, prompt, sessionId);
      }
    });
  }
}
