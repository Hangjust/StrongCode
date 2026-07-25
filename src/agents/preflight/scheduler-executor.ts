import type { ConversationItem } from "../../core/types";
import { validateConversationItems } from "../../core/types";
import type { ModelResponse } from "../../models/provider";
import type { ToolInvocationContext } from "../../runtime/context";
import { admitLoopToolCalls, beginModelStep, INITIAL_RUNNER_LOOP_STATE } from "../runner-loop-limits";
import { projectModelTools } from "../runner-tool-batch";
import { modelTurn } from "../model-turn";
import { admitPreflightToolBatch } from "./scheduler-data-boundary";
import {
  advertisedTools,
  completeWithAbort,
  ExecutionAbortedError,
  failureCode,
  operationWithAbort,
  truncateResult,
  utf8Bytes
} from "./scheduler-executor-support";
import type { PreflightAttemptRecorder } from "./scheduler-ledger";
import type {
  PreflightExecutionCompletion,
  PreflightExecutionInput
} from "./scheduler-execution-types";
import type { PreflightFailureCode } from "./scheduler-types";
import type { PreflightTraceWriter } from "./scheduler-trace";

export type PreflightExecutorDependencies = Readonly<{
  recorder: PreflightAttemptRecorder;
  trace?: PreflightTraceWriter;
}>;

export type PreflightExecutionResult =
  | Readonly<{ ok: true; value: PreflightExecutionCompletion }>
  | Readonly<{ ok: false; code: PreflightFailureCode }>;

export class PreflightModelToolExecutor {
  constructor(private readonly dependencies: PreflightExecutorDependencies) {}

  async execute(
    input: PreflightExecutionInput
  ): Promise<PreflightExecutionResult> {
    if (input.agent.runtimeRole !== input.role) {
      this.dependencies.trace?.emit({
        kind: "tool-decision", stage: input.stage, code: "invoke", decision: "deny"
      });
      this.dependencies.trace?.emit({ kind: "validation", stage: input.stage, code: "tool_permission_denied" });
      return { ok: false, code: "tool_permission_denied" };
    }
    const invocation: ToolInvocationContext = {
      ...input.context,
      signal: input.signal,
      ...(input.effectivePermissions === undefined ? {} : {
        effectivePermissions: input.effectivePermissions
      })
    };
    const tools = advertisedTools(input);
    const modelTools = projectModelTools(tools, invocation);
    this.dependencies.trace?.emit({ kind: "tool-decision", stage: input.stage, code: "advertise" });
    const toolsByName = new Map(modelTools.visibleTools.map(tool => [tool.name, tool]));
    const transcript: ConversationItem[] = [
      { type: "text", role: "user", content: input.prompt },
      ...(input.userContent ?? []).map(content => ({ type: "text" as const, role: "user" as const, content }))
    ];
    const knownCallIds = new Set<string>();
    const maxSteps = input.mode === "finalizer" ? input.limits.maxFinalizerModelSteps : input.limits.maxModelSteps;
    const maxTotalTools = input.mode === "finalizer" ? input.limits.maxFinalizerTools : input.limits.maxTotalToolCalls;
    const loopLimits = {
      maxSteps,
      maxToolCallsPerStep: input.limits.maxToolCallsPerStep,
      maxTotalToolCalls: maxTotalTools
    };
    let loopState = INITIAL_RUNNER_LOOP_STATE;
    let aggregateResultBytes = 0;
    let parentAttemptId: string | undefined;
    let firstAttemptId: string | undefined;
    let workspaceEvidenceObserved = input.outboundWebAllowed === false;

    while (true) {
      if (input.signal.aborted) return this.fail(input, "internal_error");
      const nextStep = beginModelStep(loopState, loopLimits);
      if (!nextStep.ok) return this.fail(input, "model_step_limit");
      loopState = nextStep.value;
      this.dependencies.trace?.emit({ kind: "provider-attempt", stage: input.stage, code: "outbound" });
      let response: ModelResponse;
      try {
        response = await completeWithAbort(input.agent.model.complete({
          prompt: input.prompt,
          systemPrompt: input.agent.systemPrompt,
          sessionId: input.sessionId,
          messages: [],
          items: Object.freeze([...transcript]),
          tools: [...modelTools.names],
          toolDefinitions: [...modelTools.definitions],
          signal: input.signal
        }), input.signal, () => this.dependencies.trace?.emit({
          kind: "provider-attempt",
          stage: input.stage,
          code: "late-dropped"
        }));
      } catch (error) {
        if (error instanceof ExecutionAbortedError) {
          const cancelled = await this.dependencies.recorder.recordCancellation(parentAttemptId, "execution_cancelled");
          return this.fail(input, cancelled.ok ? "internal_error" : cancelled.code);
        }
        await this.dependencies.recorder.recordFailure(
          parentAttemptId,
          input.stage === "finalizer" ? "finalizer_provider_failed" : "root_provider_failed"
        );
        return this.fail(
          input,
          input.stage === "finalizer" ? "finalizer_provider_failed" : "root_provider_failed"
        );
      }
      if (input.signal.aborted) {
        const cancelled = await this.dependencies.recorder.recordCancellation(parentAttemptId, "execution_cancelled");
        return this.fail(input, cancelled.ok ? "internal_error" : cancelled.code);
      }
      const recorded = await this.dependencies.recorder.recordResponse(response, parentAttemptId);
      if (!recorded.ok) return this.fail(input, recorded.code);
      firstAttemptId ??= recorded.value.firstAttemptId;
      parentAttemptId = recorded.value.producingAttemptId;
      this.dependencies.trace?.emit({
        kind: "provider-attempt",
        stage: input.stage,
        code: "settled",
        attemptId: parentAttemptId
      });

      let turn;
      try {
        turn = modelTurn(response);
        validateConversationItems([...transcript, ...turn.items]);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return this.fail(input, this.providerFailureCode(input.stage));
      }
      for (const call of turn.calls) {
        if (knownCallIds.has(call.callId)) return this.fail(input, this.providerFailureCode(input.stage));
        knownCallIds.add(call.callId);
      }
      transcript.push(...turn.items);
      if (turn.calls.length === 0) {
        if (firstAttemptId === undefined || parentAttemptId === undefined) {
          return this.fail(input, "internal_error");
        }
        return {
          ok: true,
          value: {
            finalText: turn.assistantText,
            firstAttemptId,
            producingAttemptId: parentAttemptId,
            workspaceEvidenceObserved
          }
        };
      }
      if (input.mode === "finalizer") return this.fail(input, "finalizer_tool_requested", parentAttemptId);
      const loopAdmission = admitLoopToolCalls(turn.calls, loopState, loopLimits);
      if (!loopAdmission.ok) {
        const code = loopAdmission.error.code;
        if (code === "TOOL_STEP_LIMIT" || code === "TOOL_TOTAL_LIMIT" || code === "TOOL_LOOP_DETECTED") {
          return this.fail(input, failureCode(code), parentAttemptId);
        }
        return this.fail(input, "internal_error", parentAttemptId);
      }
      loopState = loopAdmission.value;
      for (const call of turn.calls) {
        if (utf8Bytes(JSON.stringify(call.input) ?? "null") > input.limits.maxToolInputBytes) {
          return this.fail(input, "tool_input_too_large", parentAttemptId);
        }
      }
      if (input.signal.aborted) return this.fail(input, "internal_error", parentAttemptId);
      const preflightAdmission = admitPreflightToolBatch(
        turn.calls,
        input,
        toolsByName,
        invocation,
        workspaceEvidenceObserved
      );
      if (!preflightAdmission.ok) {
        this.dependencies.trace?.emit({
          kind: "tool-decision", stage: input.stage, code: "invoke", attemptId: parentAttemptId, decision: "deny"
        });
        this.dependencies.trace?.emit({ kind: "validation", stage: input.stage, code: preflightAdmission.code });
        return preflightAdmission;
      }
      workspaceEvidenceObserved = preflightAdmission.workspaceEvidenceObserved;
      this.dependencies.trace?.emit({ kind: "validation", stage: input.stage, code: "accepted" });
      for (const admitted of preflightAdmission.calls) {
        if (input.signal.aborted) return this.fail(input, "internal_error", parentAttemptId);
        this.dependencies.trace?.emit({
          kind: "tool-decision",
          stage: input.stage,
          code: "invoke",
          attemptId: parentAttemptId,
          decision: "allow"
        });
        let content: string;
        let isError: boolean;
        try {
          const result = await operationWithAbort(
            admitted.tool.execute(admitted.call.input, invocation),
            input.signal
          );
          content = truncateResult(
            result.ok ? result.value.content : result.error.message,
            input.limits.maxToolResultBytes
          );
          isError = !result.ok;
        } catch (error) {
          if (error instanceof ExecutionAbortedError) return this.fail(input, "internal_error", parentAttemptId);
          content = truncateResult(
            error instanceof Error ? error.message : String(error),
            input.limits.maxToolResultBytes
          );
          isError = true;
        }
        aggregateResultBytes += utf8Bytes(content);
        transcript.push({
          type: "tool_result",
          role: "tool",
          callId: admitted.call.callId,
          content,
          isError
        });
      }
      if (aggregateResultBytes > input.limits.maxAggregateToolResultBytes) {
        return this.fail(input, "tool_output_budget_exhausted", parentAttemptId);
      }
      if (input.signal.aborted) return this.fail(input, "internal_error", parentAttemptId);
    }
  }

  private fail(
    input: PreflightExecutionInput,
    code: PreflightFailureCode,
    attemptId?: string
  ): Readonly<{ ok: false; code: PreflightFailureCode }> {
    this.dependencies.trace?.emit({
      kind: "validation",
      stage: input.stage,
      code,
      ...(attemptId === undefined ? {} : { attemptId })
    });
    return { ok: false, code };
  }

  private providerFailureCode(stage: PreflightExecutionInput["stage"]): PreflightFailureCode {
    return stage === "finalizer" ? "finalizer_provider_failed" : "root_provider_failed";
  }

}
