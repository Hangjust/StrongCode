import { z } from "zod";
import { normalizedUsageSchema } from "../agents/preflight/metadata";
import type { ModelUsage, ProviderReportedCost } from "./provider";

const recordSchema = z.record(z.unknown());
const tokenSchema = z.number().int().nonnegative().safe();
const costSchema = z.number().finite().nonnegative();
const currencySchema = z.string().regex(/^[A-Z]{3}$/);
const requestIdSchema = z.string().min(1).max(512).regex(/^[\x20-\x7e]+$/);

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  const parsed = recordSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function token(...values: readonly unknown[]): number | undefined {
  for (const value of values) {
    const parsed = tokenSchema.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

function greatest(current: number | undefined, next: number | undefined): number | undefined {
  if (current === undefined) return next;
  if (next === undefined) return current;
  return Math.max(current, next);
}

export function parseProviderUsage(value: unknown): ModelUsage | undefined {
  const usage = record(value);
  if (!usage) return undefined;
  const inputDetails = record(usage.input_tokens_details) ?? record(usage.prompt_tokens_details);
  const outputDetails = record(usage.output_tokens_details) ?? record(usage.completion_tokens_details);
  const inputTokens = token(usage.input_tokens, usage.prompt_tokens);
  const outputTokens = token(usage.output_tokens, usage.completion_tokens);
  const reasoningTokens = token(outputDetails?.reasoning_tokens);
  const cacheReadTokens = token(inputDetails?.cached_tokens, usage.prompt_cache_hit_tokens);
  const cacheWriteTokens = token(usage.cache_write_tokens);
  const totalTokens = token(usage.total_tokens);
  const candidate = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {})
  };
  const parsed = normalizedUsageSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

export function mergeCumulativeUsage(current: ModelUsage | undefined, next: ModelUsage | undefined): ModelUsage | undefined {
  if (!current) return next;
  if (!next) return current;
  const inputTokens = greatest(current.inputTokens, next.inputTokens);
  const outputTokens = greatest(current.outputTokens, next.outputTokens);
  const reasoningTokens = greatest(current.reasoningTokens, next.reasoningTokens);
  const cacheReadTokens = greatest(current.cacheReadTokens, next.cacheReadTokens);
  const cacheWriteTokens = greatest(current.cacheWriteTokens, next.cacheWriteTokens);
  const totalTokens = greatest(current.totalTokens, next.totalTokens);
  return normalizedUsageSchema.parse({
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {})
  });
}

export function parseProviderCost(value: unknown): ProviderReportedCost | undefined {
  const usage = record(value);
  if (!usage) return undefined;
  const amount = costSchema.safeParse(usage.cost);
  if (!amount.success) return undefined;
  const currency = currencySchema.safeParse(usage.currency);
  return currency.success ? { amount: amount.data, currency: currency.data } : { amount: amount.data };
}

export function parseProviderRequestId(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    const parsed = requestIdSchema.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

export function parseProviderResponseId(value: unknown): string | undefined {
  const parsed = requestIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function parseExternalRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return record(value);
}
