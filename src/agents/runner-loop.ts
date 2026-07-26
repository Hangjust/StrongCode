import { randomUUID } from "node:crypto";
import { PublicProviderError, StrongCodeError, toStrongCodeError } from "../core/errors";
import { err, ok, type Result } from "../core/result";
import {
  validateConversationItems,
  type ConversationItem,
  type ConversationToolCallItem,
  type ToolExecution
} from "../core/types";
import type { ModelResponse, ModelToolDefinition } from "../models/provider";
import type { RuntimeEventSink } from "../runtime/events";
import type { ToolInvocationContext } from "../runtime/context";
import { conversationItemEvent, conversationItemsToMessages, messageEvent } from "../sessions/session";
import type { SessionStore } from "../sessions/session-store";
import type { Tool } from "../tools/tool";
import type { Agent } from "./agent";
import { immutableConversationItems } from "./conversation-snapshot";
import { modelTurn, type ModelTurn } from "./model-turn";
import { PreflightAttemptRecorder } from "./preflight/scheduler-ledger";
import type { AttemptRecordResult } from "./preflight/scheduler-ledger";
import type { UntrustedPreflightAdvice } from "./preflight/advice";
import {
  admitLoopToolCalls,
  beginModelStep,
  INITIAL_RUNNER_LOOP_STATE,
  type RunnerLoopLimits,
  type RunnerLoopState
} from "./runner-loop-limits";
import { cancelledError, RunnerCommitProtocol, runnerInterruption } from "./runner-outcome";
import { admitToolBatch, type AdmittedToolCall } from "./runner-tool-batch";
import { executeToolBatch, settleSkippedToolCalls } from "./runner-tool-execution";

export type RunnerLoopCompletion = {
  readonly assistantText: string;
  readonly reasoning?: string;
  readonly toolExecutions: readonly ToolExecution[];
  readonly transcript: readonly ConversationItem[];
};

type RunnerLoopInput = {
  readonly agent: Agent;
  readonly prompt: string;
  readonly sessionId: string;
  readonly context: ToolInvocationContext;
  readonly sessions: SessionStore;
  readonly emit: RuntimeEventSink;
  readonly limits: RunnerLoopLimits;
  readonly transcript: readonly ConversationItem[];
  readonly enabledToolNames: readonly string[];
  readonly toolDefinitions: readonly ModelToolDefinition[];
  readonly toolsByName: ReadonlyMap<string, Tool>;
  readonly isClosed: () => boolean;
  readonly untrustedPreflightAdvice?: UntrustedPreflightAdvice;
};

export async function runModelToolLoop(input: RunnerLoopInput): Promise<Result<RunnerLoopCompletion>> {
  const transcript: ConversationItem[] = [...input.transcript];
  const toolExecutions: ToolExecution[] = [];
  const reasoningParts: string[] = [];
  let completionPrompt = input.prompt;
  let state: RunnerLoopState = INITIAL_RUNNER_LOOP_STATE;
  let producingAttemptId: string | undefined;
  let recording: Promise<AttemptRecordResult> | undefined;
  const configuredModel = input.context.config.models[input.agent.config.model];
  const recorder = configuredModel === undefined ? undefined : new PreflightAttemptRecorder({
    sessions: input.sessions,
    sessionId: input.sessionId,
    logicalOperationId: randomUUID(),
    role: "primary",
    stage: "primary",
    ids: { next: randomUUID },
    resolveModelSnapshot: ({ directAttempt }) => {
      if (directAttempt !== undefined) {
        const configuredDirect = input.context.config.models[directAttempt.model];
        const trustedDirect = configuredDirect?.provider === directAttempt.provider ? configuredDirect : undefined;
        return {
          modelRef: directAttempt.model,
          providerRef: directAttempt.provider,
          displayName: trustedDirect?.displayName ?? directAttempt.model,
          ...(trustedDirect?.contextWindowTokens === undefined ? {} : { contextWindowTokens: trustedDirect.contextWindowTokens }),
          ...(trustedDirect?.pricing === undefined ? {} : { pricing: trustedDirect.pricing })
        };
      }
      const modelKey = input.agent.config.model;
      const model = configuredModel;
      return {
        modelRef: model.model ?? modelKey,
        providerRef: model.provider,
        displayName: model.displayName ?? modelKey,
        ...(model.contextWindowTokens === undefined ? {} : { contextWindowTokens: model.contextWindowTokens }),
        ...(model.pricing === undefined ? {} : { pricing: model.pricing })
      };
    }
  });

  while (true) {
    const interrupted = runnerInterruption(input.context.signal, input.isClosed());
    if (interrupted) return interrupted;
    const begun = beginModelStep(state, input.limits);
    if (!begun.ok) return begun;
    const terminalCompletion = input.limits.maxToolCallsPerStep === 0
      || state.usedToolCalls >= input.limits.maxTotalToolCalls;

    let response: ModelResponse;
    try {
      const requestItems = immutableConversationItems(transcript);
      response = await input.agent.model.complete({
        prompt: completionPrompt,
        systemPrompt: input.agent.systemPrompt,
        sessionId: input.sessionId,
        messages: conversationItemsToMessages(requestItems),
        items: requestItems,
        tools: terminalCompletion ? [] : [...input.enabledToolNames],
        toolDefinitions: terminalCompletion ? [] : [...input.toolDefinitions],
        ...(input.context.signal === undefined ? {} : { signal: input.context.signal }),
        ...(input.untrustedPreflightAdvice === undefined
          ? {}
          : { untrustedPreflightAdvice: input.untrustedPreflightAdvice })
      });
    } catch (error) {
      if (input.context.signal?.aborted) {
        if (recorder !== undefined) await recorder.recordCancellation(producingAttemptId, "provider_cancelled");
        return err(cancelledError());
      }
      if (recorder !== undefined) await recorder.recordFailure(producingAttemptId, "provider_failed");
      const message = error instanceof PublicProviderError ? error.message : "Primary provider failed";
      return err(new StrongCodeError("MODEL_ERROR", message));
    }
    if (recorder !== undefined) recording = Promise.resolve().then(() => recorder.recordResponse(response, producingAttemptId));
    if (input.context.signal?.aborted) return err(cancelledError());
    if (input.isClosed()) return err(new StrongCodeError("MODEL_ERROR", "Agent runner is closed"));

    let turn: ModelTurn;
    try {
      turn = modelTurn(response);
      validateConversationItems([...transcript, ...turn.items]);
    } catch (error) {
      return err(toStrongCodeError(error instanceof Error ? error : String(error), "MODEL_ERROR"));
    }
    if (turn.reasoning !== undefined) reasoningParts.push(turn.reasoning);
    completionPrompt = "";
    const bounded = admitLoopToolCalls(turn.calls, begun.value, input.limits);
    if (!bounded.ok) return bounded;
    const batchContext = { agent: input.agent, invocation: input.context, toolsByName: input.toolsByName } as const;
    const admitted = admitToolBatch(turn.calls, batchContext);
    if (!admitted.ok) return admitted;
    state = bounded.value;

    if (turn.calls.length === 0) {
      const commit = new RunnerCommitProtocol();
      const finalEvent = turn.items.length === 0
        ? undefined
        : messageEvent("assistant", turn.assistantText, input.agent.name);
      const finalized = await input.sessions.commitGuarded(
        input.sessionId,
        finalEvent,
        () => commit.begin(input.context.signal, input.isClosed())
      );
      const recorded = recording === undefined ? undefined : await recording;
      if (recorded !== undefined && !recorded.ok) {
        return err(new StrongCodeError("SESSION_ERROR", "Primary telemetry recording failed"));
      }
      if (recorded?.ok) producingAttemptId = recorded.value.producingAttemptId;
      if (!finalized.ok) return commit.fail(finalized.error);
      if (finalized.value.kind === "rejected") return commit.rejected();
      const commitFailure = commit.committed();
      if (commitFailure) return commitFailure;
      transcript.push(...turn.items);
      const reasoning = reasoningParts.join("\n\n");
      return ok({
        assistantText: turn.assistantText,
        ...(reasoning.length === 0 ? {} : { reasoning }),
        toolExecutions: Object.freeze([...toolExecutions]),
        transcript: Object.freeze([...transcript])
      });
    }

    const persistedCalls: AdmittedToolCall<ConversationToolCallItem>[] = [];
    const settlementAttempts = new Set<ConversationToolCallItem["callId"]>();
    const settlementInput = {
      sessions: input.sessions,
      sessionId: input.sessionId,
      agentId: input.agent.name,
      transcript,
      onSettlementAttempt: (callId: ConversationToolCallItem["callId"]) => {
        settlementAttempts.add(callId);
      }
    };
    const settlePersistedCalls = async (failure: StrongCodeError): Promise<Result<RunnerLoopCompletion>> => {
      const untouchedCalls = persistedCalls.filter(({ call }) => !settlementAttempts.has(call.callId));
      const settled = await settleSkippedToolCalls(settlementInput, untouchedCalls, failure.code);
      return settled.ok ? err(failure) : settled;
    };

    if (recording !== undefined) {
      const recorded = await recording;
      if (!recorded.ok) return err(new StrongCodeError("SESSION_ERROR", "Primary telemetry recording failed"));
      producingAttemptId = recorded.value.producingAttemptId;
    }

    for (const item of turn.items) {
      if (input.context.signal?.aborted) return settlePersistedCalls(cancelledError());
      if (input.isClosed()) {
        return settlePersistedCalls(new StrongCodeError("MODEL_ERROR", "Agent runner is closed"));
      }
      const event = item.type === "text"
        ? messageEvent("assistant", item.content, input.agent.name)
        : conversationItemEvent(item, input.agent.name);
      const appended = await input.sessions.append(input.sessionId, event);
      if (!appended.ok) return settlePersistedCalls(appended.error);
      transcript.push(item);
      if (item.type === "tool_call") {
        persistedCalls.push(...admitted.value.filter(({ call }) => call.callId === item.callId));
      }
    }

    const executed = await executeToolBatch({
      calls: admitted.value,
      context: input.context,
      sessions: input.sessions,
      sessionId: input.sessionId,
      agentId: input.agent.name,
      emit: input.emit,
      transcript,
      onSettlementAttempt: settlementInput.onSettlementAttempt,
      isClosed: input.isClosed
    });
    if (!executed.ok) return settlePersistedCalls(executed.error);
    toolExecutions.push(...executed.value);
  }
}
