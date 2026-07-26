import { StrongCodeError, toStrongCodeError } from "../core/errors";
import { err, ok, type Result } from "../core/result";
import type {
  ConversationItem,
  ConversationToolCallItem,
  ConversationToolResultItem,
  ToolExecution
} from "../core/types";
import { createRuntimeEvent, type RuntimeEventSink } from "../runtime/events";
import type { ToolInvocationContext } from "../runtime/context";
import { conversationItemEvent } from "../sessions/session";
import type { SessionStore } from "../sessions/session-store";
import type { ToolResult } from "../tools/tool";
import type { AdmittedToolCall } from "./runner-tool-batch";
import { cancelledError, isTerminalToolFailure, recoverableToolFailureContent } from "./runner-outcome";

export type ToolSettlementInput = {
  readonly sessions: SessionStore;
  readonly sessionId: string;
  readonly agentId: string;
  readonly transcript: ConversationItem[];
  readonly onSettlementAttempt: (callId: ConversationToolCallItem["callId"]) => void;
};

type ToolExecutionBatchInput = ToolSettlementInput & {
  readonly calls: readonly AdmittedToolCall<ConversationToolCallItem>[];
  readonly context: ToolInvocationContext;
  readonly emit: RuntimeEventSink;
  readonly isClosed: () => boolean;
};

type ToolSettlement = {
  readonly callId: ConversationToolCallItem["callId"];
  readonly content: string;
  readonly isError: boolean;
};

type ToolInterruption = {
  readonly code: "CANCELLED" | "MODEL_ERROR";
  readonly error: StrongCodeError;
};

async function settleToolCall(input: ToolSettlementInput, settlement: ToolSettlement): Promise<Result<void>> {
  const resultItem: ConversationToolResultItem = Object.freeze({
    type: "tool_result",
    role: "tool",
    callId: settlement.callId,
    content: settlement.content,
    isError: settlement.isError
  });
  input.onSettlementAttempt(settlement.callId);
  const appended = await input.sessions.append(
    input.sessionId,
    conversationItemEvent(resultItem, input.agentId)
  );
  if (!appended.ok) return appended;
  input.transcript.push(resultItem);
  return ok(undefined);
}

function toolInterruption(input: ToolExecutionBatchInput): ToolInterruption | undefined {
  if (input.context.signal?.aborted) return { code: "CANCELLED", error: cancelledError() };
  return input.isClosed()
    ? { code: "MODEL_ERROR", error: new StrongCodeError("MODEL_ERROR", "Agent runner is closed") }
    : undefined;
}

export async function settleSkippedToolCalls(
  input: ToolSettlementInput,
  calls: readonly AdmittedToolCall<ConversationToolCallItem>[],
  code: StrongCodeError["code"]
): Promise<Result<void>> {
  for (const skipped of calls) {
    const settled = await settleToolCall(input, {
      callId: skipped.call.callId,
      content: `Tool skipped [${code}]: the batch stopped after a terminal failure; this tool did not run.`,
      isError: true
    });
    if (!settled.ok) return settled;
  }
  return ok(undefined);
}

export async function executeToolBatch(input: ToolExecutionBatchInput): Promise<Result<readonly ToolExecution[]>> {
  const executions: ToolExecution[] = [];
  for (const [index, admitted] of input.calls.entries()) {
    const interruptedBeforeExecution = toolInterruption(input);
    if (interruptedBeforeExecution) {
      const settled = await settleSkippedToolCalls(input, input.calls.slice(index), interruptedBeforeExecution.code);
      return settled.ok ? err(interruptedBeforeExecution.error) : settled;
    }
    input.emit(createRuntimeEvent("tool_started", `Running ${admitted.tool.name}`));

    let result: Result<ToolResult>;
    try {
      result = await admitted.tool.execute(admitted.call.input, input.context);
    } catch (error) {
      result = err(toStrongCodeError(error instanceof Error ? error : String(error), "TOOL_ERROR"));
    }
    const interruptedAfterExecution = toolInterruption(input);
    if (interruptedAfterExecution) {
      const interrupted = await settleToolCall(input, {
        callId: admitted.call.callId,
        content: `Tool interrupted [${interruptedAfterExecution.code}]: execution may have completed, but no reliable result was recorded; StrongCode will not retry it automatically.`,
        isError: true
      });
      if (!interrupted.ok) return interrupted;
      const skipped = await settleSkippedToolCalls(
        input,
        input.calls.slice(index + 1),
        interruptedAfterExecution.code
      );
      return skipped.ok ? err(interruptedAfterExecution.error) : skipped;
    }
    if (!result.ok && isTerminalToolFailure(result.error.code)) {
      const terminalError = result.error;
      const failed = await settleToolCall(input, {
        callId: admitted.call.callId,
        content: recoverableToolFailureContent(terminalError),
        isError: true
      });
      if (!failed.ok) return failed;
      const skipped = await settleSkippedToolCalls(input, input.calls.slice(index + 1), terminalError.code);
      if (!skipped.ok) return skipped;
      return result;
    }

    const content = result.ok ? result.value.content : recoverableToolFailureContent(result.error);
    const execution: ToolExecution = {
      tool: admitted.tool.name,
      input: admitted.call.input,
      output: content
    };
    const settled = await settleToolCall(input, {
      callId: admitted.call.callId,
      content,
      isError: !result.ok
    });
    if (!settled.ok) return settled;
    executions.push(execution);
    input.emit(createRuntimeEvent("tool_finished", `Finished ${admitted.tool.name}`));
    const interruptedAfterSettlement = toolInterruption(input);
    if (interruptedAfterSettlement) {
      const skipped = await settleSkippedToolCalls(
        input,
        input.calls.slice(index + 1),
        interruptedAfterSettlement.code
      );
      return skipped.ok ? err(interruptedAfterSettlement.error) : skipped;
    }
  }
  return ok(Object.freeze(executions));
}
