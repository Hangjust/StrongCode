import { vi } from "vitest";
import type { Agent } from "../../src/agents/agent";
import type { PreflightRole } from "../../src/agents/preflight/metadata";
import { StrongCodeError } from "../../src/core/errors";
import type { Result } from "../../src/core/result";
import type { RuntimeContext, EffectiveToolPermission } from "../../src/runtime/context";
import type { SessionStore } from "../../src/sessions/session-store";
import type { ToolRegistry } from "../../src/tools/registry";

export type PreflightLimitNarrowing = Readonly<Partial<{
  maxTotalChildren: number;
  maxConcurrentChildren: number;
  overallDeadlineMs: number;
  childDeadlineMs: number;
  reservedFinalizerMs: number;
  maxModelSteps: number;
  maxToolCallsPerStep: number;
  maxTotalToolCalls: number;
  maxToolInputBytes: number;
  maxToolResultBytes: number;
  maxAggregateToolResultBytes: number;
  maxFinalTextBytes: number;
  maxQuestionBytes: number;
  maxResearchBytes: number;
  maxFindingBytes: number;
  maxFinalizerEvidenceBytes: number;
}>>;

export type PreflightTerminalOutcome = Readonly<{
  kind: "committed" | "failed-open" | "cancelled";
  reservationId?: string;
  logicalOperationId?: string;
  attemptId?: string;
  result?: Readonly<{ title: string; generalSummary: string; requestedItems: readonly string[] }>;
  reasonCode?: string;
  reasonAvailable?: boolean;
  reason?: unknown;
}>;

export type PreflightOutcome =
  | Readonly<{ kind: "ignored-empty" }>
  | PreflightTerminalOutcome
  | Readonly<{
      kind: "in-progress";
      reservationId: string;
      logicalOperationId: string;
      done: Promise<Result<PreflightTerminalOutcome>>;
    }>
  | Readonly<{ kind: "existing"; reason: string; terminal?: PreflightTerminalOutcome }>;

export type PreflightScheduleInput = Readonly<{
  sessionId: string;
  sourceMessageId: string;
  originalPrompt: string;
  context: RuntimeContext;
  toolRegistry: ToolRegistry;
  signal?: AbortSignal;
  effectivePermissions?: Readonly<Record<string, EffectiveToolPermission>>;
  limits?: PreflightLimitNarrowing;
  parentDepth?: number;
}>;

export type PreflightTraceEvent = Readonly<{
  kind: string;
  sequence?: number;
  code?: string;
  stage?: string;
  sourceIndex?: number;
  attemptId?: string;
  toolName?: string;
  decision?: string;
  [key: string]: unknown;
}>;

export type PreflightClock = Readonly<{
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => unknown;
  clearTimer: (handle: unknown) => void;
}>;

export interface PreflightSchedulerLike {
  run(input: PreflightScheduleInput): Promise<Result<PreflightOutcome>>;
  close(reason?: unknown): Promise<void>;
}

export interface PreflightRegistryLike {
  readonly size?: number;
}

type SchedulerDependencies = Readonly<{
  sessions: SessionStore;
  createAgent: (config: RuntimeContext["config"], role: PreflightRole) => Agent;
  clock: PreflightClock;
  ids: Readonly<{ next: () => string }>;
  resolveModelSnapshot: (input: Readonly<{
    role: PreflightRole;
    directAttempt?: Readonly<{ model?: string; provider?: string }>;
  }>) => Readonly<{ modelRef: string; providerRef: string; displayName: string }>;
  emitTrace: (event: PreflightTraceEvent) => void;
}>; 

type SchedulerConstructor = new (
  dependencies: SchedulerDependencies & Readonly<{ registry: PreflightRegistryLike }>
) => PreflightSchedulerLike;
type RegistryConstructor = new () => PreflightRegistryLike;

function isSchedulerConstructor(value: unknown): value is SchedulerConstructor {
  return typeof value === "function";
}

function isRegistryConstructor(value: unknown): value is RegistryConstructor {
  return typeof value === "function";
}

function moduleExport(moduleValue: unknown, name: string): unknown {
  if (typeof moduleValue !== "object" || moduleValue === null || !(name in moduleValue)) return undefined;
  return Reflect.get(moduleValue, name);
}

function isMissingSchedulerModule(error: unknown): boolean {
  return error instanceof Error && (
    error.message.includes("preflight/scheduler") || error.message.includes("preflight\\scheduler")
  );
}

class MissingPreflightScheduler implements PreflightSchedulerLike {
  async run(_input: PreflightScheduleInput): Promise<Result<PreflightOutcome>> {
    throw new StrongCodeError("MODEL_ERROR", "Todo 7 private scheduler behavior is not implemented");
  }

  async close(_reason?: unknown): Promise<void> {}
}

class MissingPreflightRegistry implements PreflightRegistryLike {
  readonly size = 0;
}

export async function createPreflightScheduler(
  dependencies: SchedulerDependencies
): Promise<Readonly<{ scheduler: PreflightSchedulerLike; registry: PreflightRegistryLike; available: boolean }>> {
  try {
    const schedulerModule = await vi.importActual<unknown>("../../src/agents/preflight/scheduler");
    const registryModule = await vi.importActual<unknown>("../../src/agents/preflight/scheduler-registry");
    const Scheduler = moduleExport(schedulerModule, "PreflightScheduler");
    const Registry = moduleExport(registryModule, "PreflightRunRegistry");
    if (!isSchedulerConstructor(Scheduler) || !isRegistryConstructor(Registry)) {
      throw new StrongCodeError("MODEL_ERROR", "Todo 7 private scheduler exports are incomplete");
    }
    const registry = new Registry();
    return { scheduler: new Scheduler({ ...dependencies, registry }), registry, available: true };
  } catch (error) {
    if (!isMissingSchedulerModule(error)) throw error;
    const registry = new MissingPreflightRegistry();
    return { scheduler: new MissingPreflightScheduler(), registry, available: false };
  }
}
