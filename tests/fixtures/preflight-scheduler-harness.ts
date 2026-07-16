import { z } from "zod";
import type { Result } from "../../src/core/result";
import { SessionStore } from "../../src/sessions/session-store";
import type { EffectiveToolPermission, RuntimeContext } from "../../src/runtime/context";
import { ToolRegistry } from "../../src/tools/registry";
import type { Tool } from "../../src/tools/tool";
import { tempWorkspace } from "../helpers";
import {
  createPreflightScheduler,
  type PreflightClock,
  type PreflightOutcome,
  type PreflightRegistryLike,
  type PreflightScheduleInput,
  type PreflightSchedulerLike,
  type PreflightTerminalOutcome,
  type PreflightTraceEvent
} from "./preflight-scheduler-contract";
export {
  completeDecision,
  CompletionBarrier,
  deferred,
  finalResult,
  finding,
  modelResponse,
  researchDecision,
  researchRequests,
  responseWithIdentity
} from "./preflight-scripted-model";
import { ScriptedPreflightModels } from "./preflight-scripted-model";

export type SchedulerHarness = {
  readonly context: RuntimeContext;
  readonly models: ScriptedPreflightModels;
  readonly registry: PreflightRegistryLike;
  readonly scheduler: PreflightSchedulerLike;
  readonly schedulerAvailable: boolean;
  readonly sessions: SessionStore;
  readonly tools: ToolRegistry;
  readonly traces: PreflightTraceEvent[];
  readonly invocations: string[];
  readonly clock: ManualPreflightClock;
};

type Timer = Readonly<{ id: number; dueAt: number; callback: () => void }>;

export class ManualPreflightClock implements PreflightClock {
  private currentMs = 1_000;
  private nextId = 0;
  private readonly timers = new Map<number, Timer>();

  now = (): number => this.currentMs;

  setTimer = (callback: () => void, delayMs: number): unknown => {
    const timer = { id: ++this.nextId, dueAt: this.currentMs + delayMs, callback };
    this.timers.set(timer.id, timer);
    return timer.id;
  };

  clearTimer = (handle: unknown): void => {
    if (typeof handle === "number") this.timers.delete(handle);
  };

  advanceBy(milliseconds: number): void {
    this.currentMs += milliseconds;
    const due = [...this.timers.values()]
      .filter(timer => timer.dueAt <= this.currentMs)
      .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id);
    for (const timer of due) {
      this.timers.delete(timer.id);
      timer.callback();
    }
  }

  pendingTimers(): number {
    return this.timers.size;
  }
}

function fixtureTool(
  name: string,
  effect: Tool["effect"],
  invocations: string[],
  toolResults: Readonly<Record<string, string>>
): Tool {
  return {
    name,
    description: `${name} fixture`,
    effect,
    readOnly: effect === "read",
    inputSchema: z.unknown(),
    async execute(input) {
      invocations.push(`${name}:${JSON.stringify(input)}`);
      return { ok: true, value: { content: toolResults[name] ?? `result-${name}` } };
    }
  };
}

export async function schedulerHarness(options: Readonly<{
  emitTrace?: (event: PreflightTraceEvent) => void;
  createSessions?: (dataDir: string) => SessionStore;
  toolResults?: Readonly<Record<string, string>>;
}> = {}): Promise<SchedulerHarness> {
  const workspace = await tempWorkspace();
  const permissions: Record<string, "allow"> = Object.fromEntries([
    "read_file", "ripgrep", "web_search", "write_file", "shell", "question",
    "worker", "task", "spawn", "scheduler", "mcp__unknown__read"
  ].map(name => [name, "allow"]));
  const context = {
    ...workspace.context,
    config: { ...workspace.config, permissions: { tools: permissions } }
  };
  const sessions = options.createSessions?.(context.dataDir) ?? new SessionStore(context.dataDir);
  const tools = new ToolRegistry();
  const invocations: string[] = [];
  const toolResults = options.toolResults ?? {};
  tools.register(fixtureTool("read_file", "read", invocations, toolResults));
  tools.register(fixtureTool("ripgrep", "search", invocations, toolResults));
  tools.register(fixtureTool("web_search", "read-only-web", invocations, toolResults));
  tools.register(fixtureTool("write_file", "mutation", invocations, toolResults));
  tools.register(fixtureTool("shell", "shell", invocations, toolResults));
  tools.register(fixtureTool("question", "interaction", invocations, toolResults));
  tools.register(fixtureTool("worker", "worker", invocations, toolResults));
  tools.register(fixtureTool("task", "worker", invocations, toolResults));
  tools.register(fixtureTool("spawn", "spawn", invocations, toolResults));
  tools.register(fixtureTool("scheduler", "worker", invocations, toolResults));
  tools.register(fixtureTool("mcp__unknown__read", "read-only-web", invocations, toolResults));
  const models = new ScriptedPreflightModels();
  const traces: PreflightTraceEvent[] = [];
  let id = 0;
  const clock = new ManualPreflightClock();
  const loaded = await createPreflightScheduler({
    sessions,
    createAgent: models.factory,
    clock,
    ids: { next: () => `scheduler-id-${++id}` },
    resolveModelSnapshot: ({ role, directAttempt }) => ({
      modelRef: directAttempt?.model ?? `fixture-${role}`,
      providerRef: directAttempt?.provider ?? "fixture-provider",
      displayName: `Fixture ${role}`
    }),
    emitTrace: event => {
      traces.push(event);
      options.emitTrace?.(event);
    }
  });
  return {
    context,
    models,
    registry: loaded.registry,
    scheduler: loaded.scheduler,
    schedulerAvailable: loaded.available,
    sessions,
    tools,
    traces,
    invocations,
    clock
  };
}

export function scheduleInput(
  harness: SchedulerHarness,
  overrides: Partial<PreflightScheduleInput> = {}
): PreflightScheduleInput {
  const effectivePermissions: Readonly<Record<string, EffectiveToolPermission>> = {
    read_file: "allow", ripgrep: "allow", web_search: "allow", write_file: "allow",
    shell: "allow", question: "allow", worker: "allow", task: "allow", spawn: "allow",
    scheduler: "allow", mcp__unknown__read: "allow"
  };
  return {
    sessionId: "preflight-session",
    sourceMessageId: "source-message",
    originalPrompt: "Exact original prompt",
    context: harness.context,
    toolRegistry: harness.tools,
    effectivePermissions,
    ...overrides
  };
}

export async function terminal(result: Result<PreflightOutcome>): Promise<Result<PreflightTerminalOutcome>> {
  if (!result.ok) return result;
  if (result.value.kind === "in-progress") return result.value.done;
  if (result.value.kind === "committed" || result.value.kind === "failed-open" || result.value.kind === "cancelled") {
    return { ok: true, value: result.value };
  }
  throw new Error(`Outcome ${result.value.kind} is not terminal`);
}
