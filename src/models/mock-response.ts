import { z } from "zod";
import { normalizedUsageSchema } from "../agents/preflight/metadata";
import { StrongCodeError } from "../core/errors";
import { validateConversationItems, type ToolCall } from "../core/types";
import type { DirectModelAttempt, ModelResponse, ModelUsage, ProviderReportedCost, ProviderUsageMetric } from "./provider";
import { parseProviderRequestId, parseProviderResponseId } from "./provider-usage";

const recordSchema = z.record(z.unknown());
const tokenSchema = z.number().int().nonnegative().safe();
const terminalUnsafeIdentityPattern = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const telemetryIdentitySchema = z.string()
  .min(1)
  .refine(value => value === value.trim())
  .refine(value => !terminalUnsafeIdentityPattern.test(value));
const metricSchema = z.object({
  source: z.literal("provider-reported"),
  provider: telemetryIdentitySchema,
  field: telemetryIdentitySchema,
  category: z.enum(["input", "output", "reasoning", "cache-read", "cache-write", "total", "provider-specific"]),
  tokens: z.number().int().nonnegative().safe(),
  semantics: z.enum([
    "exclusive",
    "input-includes-cache",
    "input-overlap",
    "output-includes-reasoning",
    "output-subset",
    "reported-total",
    "gemini-tool-use-prompt",
    "vertex-tool-execution-result-input"
  ])
}).strict();
const costSchema = z.object({
  amount: z.number().finite().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional()
}).strict();

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  const parsed = recordSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function usage(value: unknown): ModelUsage | undefined {
  const source = record(value);
  if (!source) return undefined;
  const inputTokens = tokenSchema.safeParse(source.inputTokens);
  const outputTokens = tokenSchema.safeParse(source.outputTokens);
  const reasoningTokens = tokenSchema.safeParse(source.reasoningTokens);
  const cacheReadTokens = tokenSchema.safeParse(source.cacheReadTokens);
  const cacheWriteTokens = tokenSchema.safeParse(source.cacheWriteTokens);
  const totalTokens = tokenSchema.safeParse(source.totalTokens);
  const parsed = normalizedUsageSchema.safeParse({
    ...(inputTokens.success ? { inputTokens: inputTokens.data } : {}),
    ...(outputTokens.success ? { outputTokens: outputTokens.data } : {}),
    ...(reasoningTokens.success ? { reasoningTokens: reasoningTokens.data } : {}),
    ...(cacheReadTokens.success ? { cacheReadTokens: cacheReadTokens.data } : {}),
    ...(cacheWriteTokens.success ? { cacheWriteTokens: cacheWriteTokens.data } : {}),
    ...(totalTokens.success ? { totalTokens: totalTokens.data } : {})
  });
  return parsed.success ? { ...parsed.data } : undefined;
}

function metrics(value: unknown): readonly ProviderUsageMetric[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = value.flatMap(entry => {
    const result = metricSchema.safeParse(entry);
    return result.success ? [result.data] : [];
  });
  return parsed.length > 0 ? parsed : undefined;
}

function cost(value: unknown): ProviderReportedCost | undefined {
  const parsed = costSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function attempts(value: unknown): readonly DirectModelAttempt[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = value.flatMap(entry => {
    const source = record(entry);
    if (!source || source.scope !== "exclusive") return [];
    const attemptId = telemetryIdentitySchema.safeParse(source.attemptId);
    const provider = telemetryIdentitySchema.safeParse(source.provider);
    const model = telemetryIdentitySchema.safeParse(source.model);
    if (!attemptId.success || !provider.success || !model.success) return [];
    const parsedUsage = usage(source.usage);
    const providerUsage = metrics(source.providerUsage);
    const providerCost = cost(source.providerCost);
    const providerRequestId = parseProviderRequestId(source.providerRequestId);
    const providerResponseId = parseProviderResponseId(source.providerResponseId);
    return [{
      attemptId: attemptId.data,
      provider: provider.data,
      model: model.data,
      scope: "exclusive" as const,
      ...(parsedUsage ? { usage: parsedUsage } : {}),
      ...(providerUsage ? { providerUsage } : {}),
      ...(providerCost ? { providerCost } : {}),
      ...(providerRequestId ? { providerRequestId } : {}),
      ...(providerResponseId ? { providerResponseId } : {})
    }];
  });
  return parsed.length > 0 ? parsed : undefined;
}

function toolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) throw new StrongCodeError("VALIDATION_ERROR", "Mock response toolCalls must be an array");
  return value.map(entry => {
    const source = record(entry);
    if (!source || typeof source.name !== "string" || source.name.length === 0 || !("input" in source)) {
      throw new StrongCodeError("VALIDATION_ERROR", "Mock response contains an invalid tool call");
    }
    const callId = typeof source.callId === "string" && source.callId.length > 0 ? source.callId : undefined;
    return { ...(callId ? { callId } : {}), name: source.name, input: source.input };
  });
}

export function parseMockModelResponse(value: unknown): ModelResponse {
  const source = record(value);
  if (!source || typeof source.message !== "string") {
    throw new StrongCodeError("VALIDATION_ERROR", "Mock response must contain a message");
  }
  const parsedUsage = usage(source.usage);
  const providerUsage = metrics(source.providerUsage);
  const providerCost = cost(source.providerCost);
  const providerRequestId = parseProviderRequestId(source.providerRequestId);
  const providerResponseId = parseProviderResponseId(source.providerResponseId);
  const directAttempts = attempts(source.directAttempts);
  const items = Array.isArray(source.items) ? validateConversationItems(source.items) : undefined;
  return {
    message: source.message,
    toolCalls: toolCalls(source.toolCalls),
    ...(items ? { items } : {}),
    ...(parsedUsage ? { usage: parsedUsage } : {}),
    ...(providerUsage ? { providerUsage } : {}),
    ...(providerCost ? { providerCost } : {}),
    ...(providerRequestId ? { providerRequestId } : {}),
    ...(providerResponseId ? { providerResponseId } : {}),
    ...(directAttempts ? { directAttempts } : {})
  };
}

export function parseMockScript(value: unknown): readonly ModelResponse[] {
  if (!Array.isArray(value)) throw new StrongCodeError("VALIDATION_ERROR", "Mock script fixture must be an array");
  return value.map(parseMockModelResponse);
}
