import { toStrongCodeError } from "../core/errors";
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

type ToolExecutionBatchInput = {
  readonly calls: readonly AdmittedToolCall<ConversationToolCallItem>[];
  readonly context: ToolInvocationContext;
  readonly sessions: SessionStore;
  readonly sessionId: string;
  readonly agentId: string;
  readonly emit: RuntimeEventSink;
  readonly transcript: ConversationItem[];
  readonly isClosed: () => boolean;
};

type ToolSettlement = {
  readonly callId: ConversationToolCallItem["callId"];
  readonly content: string;
  readonly isError: boolean;
};

async function settleToolCall(input: ToolExecutionBatchInput, settlement: ToolSettlement): Promise<Result<void>> {
  const resultItem: ConversationToolResultItem = Object.freeze({
    type: "tool_result",
    role: "tool",
    callId: settlement.callId,
    content: settlement.content,
    isError: settlement.isError
  });
  const appended = await input.sessions.append(
    input.sessionId,
    conversationItemEvent(resultItem, input.agentId)
  );
  if (!appended.ok) return appended;
  input.transcript.push(resultItem);
  return ok(undefined);
}

export async function executeToolBatch(input: ToolExecutionBatchInput): Promise<Result<readonly ToolExecution[]>> {
  const executions: ToolExecution[] = [];
  for (const [index, admitted] of input.calls.entries()) {
    if (input.context.signal?.aborted) return err(cancelledError());
    if (input.isClosed()) return err(toStrongCodeError("Agent runner is closed", "MODEL_ERROR"));
    input.emit(createRuntimeEvent("tool_started", `Running ${admitted.tool.name}`));

    let result: Result<ToolResult>;
    try {
      result = await admitted.tool.execute(admitted.call.input, input.context);
    } catch (error) {
      result = err(toStrongCodeError(error instanceof Error ? error : String(error), "TOOL_ERROR"));
    }
    if (input.context.signal?.aborted) return err(cancelledError());
    if (input.isClosed()) return err(toStrongCodeError("Agent runner is closed", "MODEL_ERROR"));
    if (!result.ok && isTerminalToolFailure(result.error.code)) {
      const terminalError = result.error;
      const failed = await settleToolCall(input, {
        callId: admitted.call.callId,
        content: recoverableToolFailureContent(terminalError),
        isError: true
      });
      if (!failed.ok) return failed;
      for (const skipped of input.calls.slice(index + 1)) {
        const settled = await settleToolCall(input, {
          callId: skipped.call.callId,
          content: `Tool skipped [${terminalError.code}]: the batch stopped after a terminal failure; this tool did not run.`,
          isError: true
        });
        if (!settled.ok) return settled;
      }
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
    if (input.context.signal?.aborted) return err(cancelledError());
    if (input.isClosed()) return err(toStrongCodeError("Agent runner is closed", "MODEL_ERROR"));
  }
  return ok(Object.freeze(executions));
}
