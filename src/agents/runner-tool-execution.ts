import { toStrongCodeError } from "../core/errors";
import { err, ok, type Result } from "../core/result";
import type { ConversationItem, ConversationToolCallItem, ToolExecution } from "../core/types";
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

export async function executeToolBatch(input: ToolExecutionBatchInput): Promise<Result<readonly ToolExecution[]>> {
  const executions: ToolExecution[] = [];
  for (const admitted of input.calls) {
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
    if (!result.ok && isTerminalToolFailure(result.error.code)) return result;

    const content = result.ok ? result.value.content : recoverableToolFailureContent(result.error);
    const execution: ToolExecution = {
      tool: admitted.tool.name,
      input: admitted.call.input,
      output: content
    };
    const resultItem = Object.freeze({
      type: "tool_result" as const,
      role: "tool" as const,
      callId: admitted.call.callId,
      content,
      isError: !result.ok
    });
    const appended = await input.sessions.append(
      input.sessionId,
      conversationItemEvent(resultItem, input.agentId)
    );
    if (!appended.ok) return appended;
    input.transcript.push(resultItem);
    executions.push(execution);
    input.emit(createRuntimeEvent("tool_finished", `Finished ${admitted.tool.name}`));
    if (input.context.signal?.aborted) return err(cancelledError());
    if (input.isClosed()) return err(toStrongCodeError("Agent runner is closed", "MODEL_ERROR"));
  }
  return ok(Object.freeze(executions));
}
