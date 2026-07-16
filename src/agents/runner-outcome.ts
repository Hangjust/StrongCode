import { StrongCodeError, type StrongCodeErrorCode } from "../core/errors";

type RunnerInterruption = {
  readonly ok: false;
  readonly error: StrongCodeError;
};

type RunnerCommitState =
  | { readonly kind: "pending" }
  | { readonly kind: "committing" }
  | { readonly kind: "succeeded" }
  | { readonly kind: "cancelled"; readonly error: StrongCodeError }
  | { readonly kind: "failed"; readonly error: StrongCodeError };

export class RunnerCommitProtocol {
  private state: RunnerCommitState = { kind: "pending" };

  begin(signal: AbortSignal | undefined, closed: boolean): boolean {
    if (this.state.kind !== "pending") return false;
    if (signal?.aborted) {
      this.state = { kind: "cancelled", error: cancelledError() };
      return false;
    }
    if (closed) {
      this.state = { kind: "failed", error: new StrongCodeError("MODEL_ERROR", "Agent runner is closed") };
      return false;
    }
    this.state = { kind: "committing" };
    return true;
  }

  committed(): RunnerInterruption | undefined {
    switch (this.state.kind) {
      case "committing":
        this.state = { kind: "succeeded" };
        return undefined;
      case "succeeded":
        return undefined;
      case "cancelled":
      case "failed":
        return { ok: false, error: this.state.error };
      case "pending":
        return this.fail(new StrongCodeError("MODEL_ERROR", "Runner commit completed before it began"));
      default: {
        const exhaustiveState: never = this.state;
        return exhaustiveState;
      }
    }
  }

  rejected(): RunnerInterruption {
    switch (this.state.kind) {
      case "cancelled":
      case "failed":
        return { ok: false, error: this.state.error };
      case "pending":
      case "committing":
      case "succeeded":
        return this.fail(new StrongCodeError("MODEL_ERROR", "Runner commit guard rejected without an interruption"));
      default: {
        const exhaustiveState: never = this.state;
        return exhaustiveState;
      }
    }
  }

  fail(error: StrongCodeError): RunnerInterruption {
    switch (this.state.kind) {
      case "pending":
      case "committing":
        this.state = { kind: "failed", error };
        return { ok: false, error };
      case "cancelled":
      case "failed":
        return { ok: false, error: this.state.error };
      case "succeeded":
        return { ok: false, error: new StrongCodeError("MODEL_ERROR", "Runner commit failed after success") };
      default: {
        const exhaustiveState: never = this.state;
        return exhaustiveState;
      }
    }
  }
}

export function cancelledError(): StrongCodeError {
  return new StrongCodeError("CANCELLED", "Agent run was cancelled");
}

export function runnerInterruption(signal: AbortSignal | undefined, closed: boolean): RunnerInterruption | undefined {
  if (signal?.aborted) return { ok: false, error: cancelledError() };
  return closed
    ? { ok: false, error: new StrongCodeError("MODEL_ERROR", "Agent runner is closed") }
    : undefined;
}

export function isTerminalToolFailure(code: StrongCodeErrorCode): boolean {
  switch (code) {
    case "PERMISSION_DENIED":
    case "NESTED_SPAWN_DENIED":
    case "SESSION_ERROR":
    case "MODEL_ERROR":
    case "CANCELLED":
    case "MODEL_STEP_LIMIT":
    case "TOOL_STEP_LIMIT":
    case "TOOL_TOTAL_LIMIT":
    case "TOOL_LOOP_DETECTED":
      return true;
    case "CONFIG_ERROR":
    case "TOOL_NOT_FOUND":
    case "TOOL_ERROR":
    case "TASK_ERROR":
    case "HELPER_DISABLED":
    case "HELPER_BACKSTAGE":
    case "CATEGORY_POLICY_DENIED":
    case "PATH_OUTSIDE_WORKSPACE":
    case "VALIDATION_ERROR":
      return false;
    default: {
      const exhaustiveCode: never = code;
      return exhaustiveCode;
    }
  }
}

export function recoverableToolFailureContent(error: StrongCodeError): string {
  return `Tool failed [${error.code}]: ${error.message}`;
}
