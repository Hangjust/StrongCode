import { isDeepStrictEqual } from "node:util";
import { StrongCodeError } from "../core/errors";
import { err, ok, type Result } from "../core/result";
import type { ToolCall } from "../core/types";

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_MAX_TOOL_CALLS = 500;

export type RunnerLoopLimitOptions = {
  readonly maxSteps?: number;
  readonly maxToolCallsPerStep?: number;
  readonly maxTotalToolCalls?: number;
  readonly maxToolCalls?: number;
};

export type RunnerLoopLimits = {
  readonly maxSteps: number;
  readonly maxToolCallsPerStep: number;
  readonly maxTotalToolCalls: number;
};

export type RunnerLoopState = {
  readonly completedSteps: number;
  readonly usedToolCalls: number;
  readonly callSets: readonly (readonly ToolCall[])[];
};

export const INITIAL_RUNNER_LOOP_STATE: RunnerLoopState = Object.freeze({
  completedSteps: 0,
  usedToolCalls: 0,
  callSets: Object.freeze([])
});

function nonnegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new StrongCodeError("VALIDATION_ERROR", `${name} must be a nonnegative integer`);
  }
  return resolved;
}

export function resolveRunnerLoopLimits(options: RunnerLoopLimitOptions): RunnerLoopLimits {
  const maxSteps = nonnegativeInteger(options.maxSteps, DEFAULT_MAX_STEPS, "maxSteps");
  if (maxSteps === 0) {
    throw new StrongCodeError("VALIDATION_ERROR", "maxSteps must be a positive integer");
  }
  nonnegativeInteger(options.maxToolCalls, DEFAULT_MAX_TOOL_CALLS, "maxToolCalls");
  return Object.freeze({
    maxSteps,
    maxToolCallsPerStep: nonnegativeInteger(
      options.maxToolCallsPerStep,
      DEFAULT_MAX_TOOL_CALLS,
      "maxToolCallsPerStep"
    ),
    maxTotalToolCalls: nonnegativeInteger(
      options.maxTotalToolCalls,
      options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
      "maxTotalToolCalls"
    )
  });
}

export function beginModelStep(state: RunnerLoopState, limits: RunnerLoopLimits): Result<RunnerLoopState> {
  if (state.completedSteps >= limits.maxSteps) {
    return err(new StrongCodeError(
      "MODEL_STEP_LIMIT",
      `Model step limit of ${limits.maxSteps} was reached before a final response`
    ));
  }
  return ok({ ...state, completedSteps: state.completedSteps + 1 });
}

function identicalCallSets(left: readonly ToolCall[], right: readonly ToolCall[]): boolean {
  if (left.length !== right.length) return false;
  const unmatched = [...right];
  for (const call of left) {
    const match = unmatched.findIndex(candidate => (
      candidate.name === call.name && isDeepStrictEqual(candidate.input, call.input)
    ));
    if (match < 0) return false;
    unmatched.splice(match, 1);
  }
  return true;
}

export function admitLoopToolCalls(
  calls: readonly ToolCall[],
  state: RunnerLoopState,
  limits: RunnerLoopLimits
): Result<RunnerLoopState> {
  if (calls.length > limits.maxToolCallsPerStep) {
    return err(new StrongCodeError(
      "TOOL_STEP_LIMIT",
      `Model requested ${calls.length} tools in one step; limit is ${limits.maxToolCallsPerStep}`
    ));
  }
  const nextTotal = state.usedToolCalls + calls.length;
  if (nextTotal > limits.maxTotalToolCalls) {
    return err(new StrongCodeError(
      "TOOL_TOTAL_LIMIT",
      `Model requested ${nextTotal} total tools; limit is ${limits.maxTotalToolCalls}`
    ));
  }
  if (calls.length > 0 && state.callSets.some(previous => identicalCallSets(previous, calls))) {
    return err(new StrongCodeError("TOOL_LOOP_DETECTED", "Model repeated an identical tool-call set"));
  }
  return ok({
    ...state,
    usedToolCalls: nextTotal,
    callSets: calls.length === 0 ? state.callSets : Object.freeze([...state.callSets, Object.freeze([...calls])])
  });
}
