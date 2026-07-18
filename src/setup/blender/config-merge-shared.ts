import { StrongCodeError } from "../../core/errors";

export const MAX_BLENDER_CONFIG_BYTES = 1024 * 1024;

export type SourceMergePlan = { readonly changed: boolean; readonly content: string };

export function blenderConfigConflict(message: string): StrongCodeError {
  return new StrongCodeError("CONFIG_ERROR", message);
}

export function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}
