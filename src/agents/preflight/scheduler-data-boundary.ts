import type { ConversationToolCallItem } from "../../core/types";
import type { ToolInvocationContext } from "../../runtime/context";
import type { Tool } from "../../tools/tool";
import { admitToolBatch, type AdmittedToolCall } from "../runner-tool-batch";
import { preflightToolAllowed } from "./scheduler-executor-support";
import type { PreflightExecutionInput } from "./scheduler-execution-types";
import type { PreflightFailureCode } from "./scheduler-types";

export type PreflightToolAdmission =
  | Readonly<{ ok: true; calls: readonly AdmittedToolCall<ConversationToolCallItem>[]; workspaceEvidenceObserved: boolean }>
  | Readonly<{ ok: false; code: PreflightFailureCode }>;

export function admitPreflightToolBatch(
  calls: readonly ConversationToolCallItem[],
  input: PreflightExecutionInput,
  advertised: ReadonlyMap<string, Tool>,
  invocation: ToolInvocationContext,
  workspaceEvidenceObserved: boolean
): PreflightToolAdmission {
  let localDataRequested = false;
  let outboundWebRequested = false;
  for (const call of calls) {
    const tool = input.toolRegistry.get(call.name);
    if (tool === undefined || !advertised.has(call.name) || !preflightToolAllowed(tool, input)) {
      return { ok: false, code: "tool_permission_denied" };
    }
    localDataRequested ||= tool.effect === "read" || tool.effect === "search";
    outboundWebRequested ||= tool.effect === "read-only-web";
  }
  if ((localDataRequested && outboundWebRequested) || (workspaceEvidenceObserved && outboundWebRequested)) {
    return { ok: false, code: "tool_data_boundary_denied" };
  }
  const admitted = admitToolBatch(calls, { agent: input.agent, invocation, toolsByName: advertised });
  return admitted.ok
    ? { ok: true, calls: admitted.value, workspaceEvidenceObserved: workspaceEvidenceObserved || localDataRequested }
    : { ok: false, code: "tool_permission_denied" };
}
