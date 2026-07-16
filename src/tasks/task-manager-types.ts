import type { Agent } from "../agents/agent";
import type { SpawnOrigin, SpawnTarget } from "../agents/spawn-targets";
import type { RuntimeCatalog } from "../config/runtime-catalog";
import type { DelegationConfig } from "../config/runtime-config";
import type { Result } from "../core/result";
import type { AgentRunResult } from "../core/types";
import type { ChildFactoryInput, ChildFactoryOutput, ChildProviderOptions } from "../runtime/child-factory";
import type { RuntimeContext, ToolInvocationContext } from "../runtime/context";
import type { SessionStore } from "../sessions/session-store";
import type { ResolvedSkills } from "../skills/resolver";
import type { ChildExecutionPolicy } from "../tools/child-policy";
import type { ToolRegistry } from "../tools/registry";
import type { TaskPersistence } from "./admission";
import type { TaskOwner } from "./background-jobs";
import type { WriteOwnershipRegistry } from "./ownership";
import type { TaskRecord } from "./types";

export interface ChildRunner {
  run(agent: Agent, prompt: string, sessionId: string): Promise<Result<AgentRunResult>>;
}

export type TaskManagerOptions = {
  readonly context: RuntimeContext;
  readonly catalog: RuntimeCatalog;
  readonly trustedInstructions: readonly string[];
  readonly sessions?: SessionStore;
  readonly tools?: ToolRegistry;
  readonly taskStore?: TaskPersistence;
  readonly ownership?: WriteOwnershipRegistry;
  readonly limits?: DelegationConfig;
  readonly providerOptions?: ChildProviderOptions;
  readonly childFactory?: (input: ChildFactoryInput) => ChildFactoryOutput;
  readonly createRunner?: (context: ToolInvocationContext) => ChildRunner;
};

export type ForegroundTaskRequest = {
  readonly origin: SpawnOrigin;
  readonly target: unknown;
  readonly parentSessionId: string;
  readonly rootSessionId: string;
  readonly taskUserContent: string;
  readonly skills: ResolvedSkills;
  readonly policy: ChildExecutionPolicy;
  readonly writePaths: readonly string[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
};

export type ContinuationTaskRequest = TaskOwner & {
  readonly childSessionId: string;
  readonly taskUserContent: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
};

export type PreparedTask = {
  readonly target: SpawnTarget;
  readonly queuedRecord: TaskRecord;
  readonly childInput: ChildFactoryInput;
  readonly writePaths: readonly string[];
  readonly timeoutMs: number;
};
