export type StrongCodeErrorCode =
  | "CONFIG_ERROR"
  | "PERMISSION_DENIED"
  | "TOOL_NOT_FOUND"
  | "TOOL_ERROR"
  | "MODEL_ERROR"
  | "MODEL_STEP_LIMIT"
  | "TOOL_STEP_LIMIT"
  | "TOOL_TOTAL_LIMIT"
  | "TOOL_LOOP_DETECTED"
  | "SESSION_ERROR"
  | "TASK_ERROR"
  | "CANCELLED"
  | "NESTED_SPAWN_DENIED"
  | "HELPER_DISABLED"
  | "HELPER_BACKSTAGE"
  | "CATEGORY_POLICY_DENIED"
  | "PATH_OUTSIDE_WORKSPACE"
  | "VALIDATION_ERROR";

export class StrongCodeError extends Error {
  readonly code: StrongCodeErrorCode;

  constructor(code: StrongCodeErrorCode, message: string) {
    super(message);
    this.name = "StrongCodeError";
    this.code = code;
  }
}

export function toStrongCodeError(error: unknown, code: StrongCodeErrorCode): StrongCodeError {
  if (error instanceof StrongCodeError) {
    return error;
  }

  if (error instanceof Error) {
    return new StrongCodeError(code, error.message);
  }

  return new StrongCodeError(code, String(error));
}
