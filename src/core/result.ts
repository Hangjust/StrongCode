import { StrongCodeError } from "./errors";

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: StrongCodeError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T = never>(error: StrongCodeError): Result<T> {
  return { ok: false, error };
}
