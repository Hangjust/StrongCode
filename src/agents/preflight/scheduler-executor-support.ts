import type { ModelResponse } from "../../models/provider";
import { decideRuntimeToolAccess, isToolAllowedByAgentPolicy } from "../../tools/capability-policy";
import { assertToolAllowed } from "../../tools/permissions";
import type { Tool } from "../../tools/tool";
import type { PreflightExecutionInput } from "./scheduler-execution-types";
import type { PreflightFailureCode } from "./scheduler-types";
import { assertNever } from "./scheduler-code-maps";

const UTF8 = new TextEncoder();
const TRUNCATED = "[truncated]";
export class ExecutionAbortedError extends Error {}

export function preflightToolAllowed(tool: Tool, input: PreflightExecutionInput): boolean {
  if (!isToolAllowedByAgentPolicy(input.agent.toolPolicy, tool)) return false;
  if (input.agent.runtimeRole !== input.role) return false;
  const named = decideRuntimeToolAccess(input.role, tool.name);
  const roleAllowed = named.kind === "allow" && named.effect === tool.effect;
  return roleAllowed && assertToolAllowed(
    input.context.config,
    tool.name,
    input.effectivePermissions
  ).ok;
}

export function advertisedTools(input: PreflightExecutionInput): readonly Tool[] {
  if (input.mode === "finalizer") return [];
  return input.toolRegistry.resolve(input.agent.config.tools)
    .filter(tool => preflightToolAllowed(tool, input));
}

export type RunnerLimitCode = "MODEL_STEP_LIMIT" | "TOOL_STEP_LIMIT" | "TOOL_TOTAL_LIMIT" | "TOOL_LOOP_DETECTED";

export function failureCode(code: RunnerLimitCode): PreflightFailureCode {
  switch (code) {
    case "MODEL_STEP_LIMIT": return "model_step_limit";
    case "TOOL_STEP_LIMIT": return "tool_step_limit";
    case "TOOL_TOTAL_LIMIT": return "tool_total_limit";
    case "TOOL_LOOP_DETECTED": return "tool_loop_detected";
    default: return assertNever(code);
  }
}

export function utf8Bytes(value: string): number {
  return UTF8.encode(value).byteLength;
}

export function truncateResult(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value;
  const markerBytes = utf8Bytes(TRUNCATED);
  if (maxBytes <= markerBytes) return TRUNCATED.slice(0, maxBytes);
  let result = "";
  let used = 0;
  const available = maxBytes - markerBytes;
  for (const character of value) {
    const size = utf8Bytes(character);
    if (used + size > available) break;
    result += character;
    used += size;
  }
  return `${result}${TRUNCATED}`;
}

export function operationWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ExecutionAbortedError("Preflight execution aborted"));
  return new Promise((resolve, reject) => {
    let aborted = false;
    const abort = (): void => {
      aborted = true;
      reject(new ExecutionAbortedError("Preflight execution aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      value => {
        signal.removeEventListener("abort", abort);
        if (!aborted) resolve(value);
      },
      error => {
        signal.removeEventListener("abort", abort);
        if (!aborted) reject(error);
      }
    );
  });
}

export function completeWithAbort(
  completion: Promise<ModelResponse>,
  signal: AbortSignal,
  onLateSettlement: () => void
): Promise<ModelResponse> {
  if (signal.aborted) return Promise.reject(new ExecutionAbortedError("Preflight execution aborted"));
  return new Promise((resolve, reject) => {
    let aborted = false;
    const abort = (): void => {
      aborted = true;
      onLateSettlement();
      reject(new ExecutionAbortedError("Preflight execution aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    completion.then(
      response => {
        signal.removeEventListener("abort", abort);
        if (!aborted) resolve(response);
      },
      error => {
        signal.removeEventListener("abort", abort);
        if (!aborted) reject(error);
      }
    );
  });
}
