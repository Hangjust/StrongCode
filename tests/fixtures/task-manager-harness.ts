import type { AgentRunResult } from "../../src/core/types";
import { ok, type Result } from "../../src/core/result";
import { loadRuntimeCatalog } from "../../src/config/runtime-catalog";
import type { RuntimeContext, ToolInvocationContext } from "../../src/runtime/context";
import type { ResolvedSkills } from "../../src/skills/resolver";
import type { TaskPersistence } from "../../src/tasks/admission";
import { WriteOwnershipRegistry, type WriteOwnershipRequest } from "../../src/tasks/ownership";
import { TaskStore } from "../../src/tasks/task-store";
import { parseTaskRecord, type TaskRecord } from "../../src/tasks/types";
import { TaskManager, type ChildRunner, type TaskManagerOptions } from "../../src/tasks/task-manager";
import type { ChildExecutionPolicy } from "../../src/tools/child-policy";
import { tempWorkspace } from "../helpers";

export const EMPTY_SKILLS: ResolvedSkills = Object.freeze({
  content: "",
  skills: Object.freeze([]),
  receipts: Object.freeze([])
});

export const READ_ONLY_POLICY: ChildExecutionPolicy = Object.freeze({
  permissions: Object.freeze({ read_file: "allow" as const }),
  tools: Object.freeze(["read_file"])
});

export type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
};

export function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>(resolve => {
    resolvePromise = resolve;
  });
  if (!resolvePromise) throw new Error("Deferred resolver was not initialized");
  return { promise, resolve: resolvePromise };
}

export class ControlledRuns {
  readonly starts: string[] = [];
  readonly contexts: ToolInvocationContext[] = [];
  private readonly completions: Deferred<Result<AgentRunResult>>[] = [];
  active = 0;
  maximumActive = 0;

  createRunner = (context: ToolInvocationContext): ChildRunner => ({
    run: async (_agent, prompt, sessionId) => {
      this.contexts.push(context);
      this.starts.push(prompt);
      this.active += 1;
      this.maximumActive = Math.max(this.maximumActive, this.active);
      const completion = deferred<Result<AgentRunResult>>();
      this.completions.push(completion);
      const result = await completion.promise;
      this.active -= 1;
      return result.ok
        ? ok({ ...result.value, sessionId })
        : result;
    }
  });

  complete(index: number, response = `result-${index}`): void {
    const completion = this.completions[index];
    if (!completion) throw new Error(`Missing controlled run ${index}`);
    completion.resolve(ok({ sessionId: "replaced-by-runner", response, toolExecutions: [] }));
  }
}

export class MemoryTaskPersistence implements TaskPersistence {
  protected readonly records = new Map<string, TaskRecord>();

  async write(record: unknown): Promise<Result<void>> {
    const parsed = parseTaskRecord(record);
    this.records.set(parsed.id, parsed);
    return ok(undefined);
  }

  async list(): Promise<Result<TaskRecord[]>> {
    return ok([...this.records.values()]);
  }

  snapshot(): readonly TaskRecord[] {
    return [...this.records.values()];
  }
}

export class GatedTaskPersistence extends MemoryTaskPersistence {
  private listGate: { readonly entered: Deferred<void>; readonly release: Deferred<void> } | undefined;
  private queuedWriteGate: { readonly entered: Deferred<void>; readonly release: Deferred<void> } | undefined;

  blockNextList(): { readonly entered: Promise<void>; readonly release: () => void } {
    const entered = deferred<void>();
    const release = deferred<void>();
    this.listGate = { entered, release };
    return { entered: entered.promise, release: () => release.resolve(undefined) };
  }

  blockNextQueuedWrite(): { readonly entered: Promise<void>; readonly release: () => void } {
    const entered = deferred<void>();
    const release = deferred<void>();
    this.queuedWriteGate = { entered, release };
    return { entered: entered.promise, release: () => release.resolve(undefined) };
  }

  override async list(): Promise<Result<TaskRecord[]>> {
    const gate = this.listGate;
    this.listGate = undefined;
    if (gate) {
      gate.entered.resolve(undefined);
      await gate.release.promise;
    }
    return super.list();
  }

  override async write(record: unknown): Promise<Result<void>> {
    const parsed = parseTaskRecord(record);
    const gate = parsed.status === "queued" ? this.queuedWriteGate : undefined;
    if (gate) {
      this.queuedWriteGate = undefined;
      gate.entered.resolve(undefined);
      await gate.release.promise;
    }
    return super.write(parsed);
  }
}

export class GatedOwnershipRegistry extends WriteOwnershipRegistry {
  private gate: { readonly entered: Deferred<void>; readonly release: Deferred<void> } | undefined;

  blockNextReserve(): { readonly entered: Promise<void>; readonly release: () => void } {
    const entered = deferred<void>();
    const release = deferred<void>();
    this.gate = { entered, release };
    return { entered: entered.promise, release: () => release.resolve(undefined) };
  }

  override async reserve(requestValue: WriteOwnershipRequest) {
    const gate = this.gate;
    this.gate = undefined;
    if (gate) {
      gate.entered.resolve(undefined);
      await gate.release.promise;
    }
    return super.reserve(requestValue);
  }
}

export type ManagerHarness = {
  readonly context: RuntimeContext;
  readonly manager: TaskManager;
  readonly taskStore: TaskStore;
};

export async function managerHarness(overrides: Partial<TaskManagerOptions> = {}): Promise<ManagerHarness> {
  const workspace = await tempWorkspace();
  const taskStore = overrides.taskStore instanceof TaskStore
    ? overrides.taskStore
    : new TaskStore(workspace.context.dataDir);
  const options: TaskManagerOptions = {
    context: workspace.context,
    catalog: await loadRuntimeCatalog(workspace.config, {
      directory: workspace.root,
      trustedAdjacentMetadata: false
    }),
    trustedInstructions: [],
    createRunner: () => ({
      run: async (_agent, _prompt, sessionId) => ok({ sessionId, response: "ok", toolExecutions: [] })
    }),
    taskStore,
    ...overrides
  };
  return { context: workspace.context, manager: new TaskManager(options), taskStore };
}

export function request(
  rootSessionId: string,
  taskUserContent: string,
  overrides: Partial<Parameters<TaskManager["runForeground"]>[0]> = {}
): Parameters<TaskManager["runForeground"]>[0] {
  return {
    origin: { kind: "primary-root", agentId: "tesla" },
    target: { kind: "helper", id: "explore" },
    parentSessionId: rootSessionId,
    rootSessionId,
    taskUserContent,
    skills: EMPTY_SKILLS,
    policy: READ_ONLY_POLICY,
    writePaths: [],
    ...overrides
  };
}
