import type { AgentRunResult, ConversationItem } from "../core/types";
import { StrongCodeError, toStrongCodeError } from "../core/errors";
import { err, ok, type Result } from "../core/result";
import { createRuntimeEvent, type RuntimeEventSink } from "../runtime/events";
import type { SessionStore } from "../sessions/session-store";
import { eventsToModelConversationItems, messageEvent } from "../sessions/session";
import type { ToolRegistry } from "../tools/registry";
import type { Agent } from "./agent";
import type { ToolInvocationContext } from "../runtime/context";
import { filterToolsForAgentPolicy, filterToolsForRuntimeRole } from "../tools/capability-policy";
import { PlanHandoffStore, type ApprovedPlan, type PlanGeneration, type PlanReceipt } from "./plan-handoff";
import { compactSession, type AgentCompactionResult } from "./compactor";
import { runModelToolLoop, type RunnerLoopCompletion } from "./runner-loop";
import { resolveRunnerLoopLimits, type RunnerLoopLimitOptions, type RunnerLoopLimits } from "./runner-loop-limits";
import { runnerInterruption } from "./runner-outcome";
import { createModelToolSnapshot } from "./runner-tool-batch";
import { SessionOperationCoordinator } from "./session-operation-coordinator";
import {
  computerUseEnabled,
  deriveComputerUseTurnContext,
  isOpenComputerUseTool
} from "../tools/computer-use-policy";
import {
  runPrimaryPreflight,
  type PrimaryPreflightScheduler
} from "./preflight/runner-gate";
import type { UntrustedPreflightAdvice } from "./preflight/advice";

export interface AgentRunnerOptions extends RunnerLoopLimitOptions {
  readonly emit?: RuntimeEventSink;
  readonly preflight?: PrimaryPreflightScheduler;
}

interface RunExecution {
  readonly agent: Agent;
  readonly prompt: string;
  readonly sessionId: string;
  readonly operationKey: string;
  readonly approvedItems?: readonly ConversationItem[];
  readonly planGeneration?: PlanGeneration;
}

export class AgentRunner {
  private readonly limits: RunnerLoopLimits;
  private readonly emit: RuntimeEventSink;
  private readonly operations = new SessionOperationCoordinator();
  private readonly planHandoffs = new PlanHandoffStore();
  private readonly preflight: PrimaryPreflightScheduler | undefined;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly context: ToolInvocationContext,
    private readonly sessions: SessionStore,
    private readonly tools: ToolRegistry,
    options: AgentRunnerOptions = {}
  ) {
    this.limits = resolveRunnerLoopLimits(options);
    this.emit = options.emit ?? context.emit;
    this.preflight = options.preflight;
  }

  async run(agent: Agent, prompt: string, sessionId: string): Promise<Result<AgentRunResult>> {
    if (this.closed) {
      const error = new StrongCodeError("MODEL_ERROR", "Agent runner is closed");
      this.emitRunFailure(error);
      return err(error);
    }
    const operationKey = this.sessions.operationKey(sessionId);
    if (!operationKey.ok) {
      this.emitRunFailure(operationKey.error);
      return err(operationKey.error);
    }
    const planGeneration = agent.name === "jbp" ? this.planHandoffs.begin(operationKey.value) : undefined;
    const queued = this.operations.enqueue(operationKey.value, () => this.executeRun({
      agent,
      prompt,
      sessionId,
      operationKey: operationKey.value,
      planGeneration
    }));
    return planGeneration === undefined
      ? queued
      : queued.finally(() => this.planHandoffs.retire(operationKey.value, planGeneration));
  }

  async compact(agent: Agent, sessionId: string): Promise<Result<AgentCompactionResult>> {
    if (this.closed) return this.closedResult();
    const operationKey = this.sessions.operationKey(sessionId);
    if (!operationKey.ok) return err(operationKey.error);
    return this.operations.enqueue(operationKey.value, () => {
      if (this.closed) return Promise.resolve(this.closedResult());
      return compactSession({
        agent,
        sessionId,
        sessions: this.sessions,
        isClosed: () => this.closed,
        ...(this.context.signal === undefined ? {} : { signal: this.context.signal })
      });
    });
  }

  consumePlanReceipt(sessionId: string, receipt: PlanReceipt): Result<ApprovedPlan> {
    const operationKey = this.sessions.operationKey(sessionId);
    if (!operationKey.ok) return err(operationKey.error);
    const approved = this.planHandoffs.consume(operationKey.value, receipt);
    return approved
      ? ok(approved)
      : err(new StrongCodeError("PERMISSION_DENIED", "The JBP plan receipt is invalid, stale, already used, or belongs to another session"));
  }

  async runApprovedPlan(agent: Agent, prompt: string, sessionId: string, approved: ApprovedPlan): Promise<Result<AgentRunResult>> {
    const operationKey = this.sessions.operationKey(sessionId);
    if (!operationKey.ok) return err(operationKey.error);
    const priorItems = this.planHandoffs.take(operationKey.value, approved);
    if (!priorItems) {
      return err(new StrongCodeError("PERMISSION_DENIED", "The approved JBP plan snapshot is invalid, already used, or belongs to another session"));
    }
    if (agent.name !== "bob-the-builder") {
      return err(new StrongCodeError("PERMISSION_DENIED", "Approved JBP plan snapshots may only be executed by Bob The Builder"));
    }
    if (this.closed) return this.closedResult();
    return this.operations.enqueue(operationKey.value, () => this.executeRun({
      agent,
      prompt,
      sessionId,
      operationKey: operationKey.value,
      approvedItems: priorItems
    }));
  }

  discardApprovedPlan(approved: ApprovedPlan): void {
    this.planHandoffs.discard(approved);
  }

  private async executeRun(execution: RunExecution): Promise<Result<AgentRunResult>> {
    if (this.closed) {
      const error = new StrongCodeError("MODEL_ERROR", "Agent runner is closed");
      this.emitRunFailure(error);
      return err(error);
    }
    const { sessionId, operationKey, planGeneration } = execution;
    this.emit(createRuntimeEvent("run_started", `Starting session ${sessionId}`));

    const completed = await this.executeRunBody(execution);
    if (!completed.ok) {
      this.emitRunFailure(completed.error);
      return completed;
    }
    const planReceipt = planGeneration && completed.value.assistantText.length > 0
      ? this.planHandoffs.issue(operationKey, planGeneration, completed.value.transcript)
      : undefined;
    this.emit(createRuntimeEvent("run_finished", `Finished session ${sessionId}`));
    return ok({
      sessionId,
      response: completed.value.assistantText,
      ...(completed.value.reasoning === undefined ? {} : { reasoning: completed.value.reasoning }),
      toolExecutions: [...completed.value.toolExecutions],
      ...(planReceipt ? { planReceipt } : {})
    });
  }

  private emitRunFailure(error: StrongCodeError): void {
    const eventType = error.code === "CANCELLED" ? "run_cancelled" : "run_failed";
    this.emit(createRuntimeEvent(eventType, `${error.code}: ${error.message}`));
  }

  private async executeRunBody(execution: RunExecution): Promise<Result<RunnerLoopCompletion>> {
    const interruptedAtStart = runnerInterruption(this.context.signal, this.closed);
    if (interruptedAtStart) return interruptedAtStart;
    const { agent, prompt, sessionId, approvedItems } = execution;
    const runtimeRole = agent.runtimeRole ?? "primary";
    const turnContext = deriveComputerUseTurnContext(this.context, runtimeRole, prompt);

    let priorItems = approvedItems;
    let untrustedPreflightAdvice: UntrustedPreflightAdvice | undefined;
    if (!priorItems) {
      const beforeSession = await this.sessions.readOrEmpty(sessionId);
      if (!beforeSession.ok) return beforeSession;
      try {
        priorItems = eventsToModelConversationItems(beforeSession.value.events);
      } catch (error) {
        return err(toStrongCodeError(error instanceof Error ? error : String(error), "VALIDATION_ERROR"));
      }
      if (this.preflight !== undefined) {
        try {
          const preflight = await runPrimaryPreflight({
            scheduler: this.preflight,
            agent,
            prompt,
            sessionId,
            events: beforeSession.value.events,
            context: turnContext,
            tools: this.tools
          });
          if (!preflight.ok) return preflight;
          untrustedPreflightAdvice = preflight.value;
        } catch (error) {
          return err(toStrongCodeError(error instanceof Error ? error : String(error), "VALIDATION_ERROR"));
        }
      }
    }
    const interruptedAfterRead = runnerInterruption(this.context.signal, this.closed);
    if (interruptedAfterRead) return interruptedAfterRead;

    const userEvent = messageEvent("user", prompt, agent.name);
    const appendedUser = await this.sessions.append(sessionId, userEvent);
    if (!appendedUser.ok) return appendedUser;
    const interruptedAfterUser = runnerInterruption(this.context.signal, this.closed);
    if (interruptedAfterUser) return interruptedAfterUser;

    const resolvedTools = this.tools.resolve(agent.config.tools);
    const policyTools = filterToolsForAgentPolicy(agent.toolPolicy, resolvedTools);
    const runtimeTools = filterToolsForRuntimeRole(runtimeRole, policyTools).filter(tool => (
      computerUseEnabled(turnContext) || !isOpenComputerUseTool(tool.name)
    ));
    const toolSnapshot = createModelToolSnapshot(runtimeTools, turnContext);
    return runModelToolLoop({
      agent,
      prompt,
      sessionId,
      context: turnContext,
      sessions: this.sessions,
      emit: this.emit,
      limits: this.limits,
      transcript: [...priorItems, { type: "text", role: "user", content: prompt }],
      enabledToolNames: toolSnapshot.enabledToolNames,
      toolDefinitions: toolSnapshot.toolDefinitions,
      toolsByName: toolSnapshot.toolsByName,
      isClosed: () => this.closed,
      ...(untrustedPreflightAdvice === undefined ? {} : { untrustedPreflightAdvice })
    });
  }

  private closedResult<T>(): Result<T> {
    return err(new StrongCodeError("MODEL_ERROR", "Agent runner is closed"));
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    const pendingOperations = this.operations.snapshotPendingOperations();
    const draining = Promise.allSettled(pendingOperations);
    let preflightFailure: { readonly reason: unknown } | undefined;
    const closingPreflight = this.preflight === undefined
      ? Promise.resolve()
      : this.preflight.close(new StrongCodeError("CANCELLED", "Agent runner is closed")).catch((reason: unknown) => {
          preflightFailure = { reason };
        });
    let toolFailure: { readonly reason: unknown } | undefined;
    const closingTools = Promise.resolve()
      .then(() => this.tools.close())
      .catch((reason: unknown) => {
        toolFailure = { reason };
      });
    this.closePromise = (async () => {
      await Promise.all([closingPreflight, closingTools, draining]);
      if (preflightFailure !== undefined) throw preflightFailure.reason;
      if (toolFailure !== undefined) throw toolFailure.reason;
    })();
    return this.closePromise;
  }
}
