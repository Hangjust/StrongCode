export type StrongCodeErrorCode =
  | "CONFIG_ERROR"
  | "PERMISSION_DENIED"
  | "TOOL_NOT_FOUND"
  | "TOOL_ERROR"
  | "MODEL_ERROR"
  | "SESSION_ERROR"
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
