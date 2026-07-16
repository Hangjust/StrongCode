import { z } from "zod";

const TERMINAL_CONTROL_PATTERN = /[\p{Cc}\p{Cf}]/u;

export const generatedDisplayTextSchema = z.string()
  .refine(value => !TERMINAL_CONTROL_PATTERN.test(value), "Generated text must not contain terminal control characters")
  .transform(value => value.trim())
  .pipe(z.string().min(1).max(10_000));

export const modelReferenceSchema = z.string()
  .min(1)
  .max(512)
  .refine(value => value === value.trim(), "Model references must not have surrounding whitespace")
  .refine(value => !TERMINAL_CONTROL_PATTERN.test(value), "Model references must not contain terminal control characters")
  .brand("ModelReference");

export const preflightIdSchema = z.string()
  .min(1)
  .max(256)
  .refine(value => value === value.trim(), "Identifiers must not have surrounding whitespace")
  .refine(value => !TERMINAL_CONTROL_PATTERN.test(value), "Identifiers must not contain terminal control characters")
  .brand("PreflightId");

export function normalizeSummaryTitle(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}
