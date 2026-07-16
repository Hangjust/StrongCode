import { z } from "zod";
import { normalizedUsageSchema } from "../agents/preflight/metadata";
import type { ModelUsage, ProviderUsageCategory, ProviderUsageMetric, ProviderUsageSemantics } from "./provider";
import { parseExternalRecord } from "./provider-usage";

const tokenSchema = z.number().int().nonnegative().safe();
const googleTokenSchema = tokenSchema.max(2_147_483_647);

type ParsedNativeUsage = {
  readonly usage?: ModelUsage;
  readonly providerUsage: readonly ProviderUsageMetric[];
};

type GoogleUsageProvider = "gemini-developer-api" | "google-vertex-ai";

function token(value: unknown): number | undefined {
  const parsed = tokenSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function googleToken(value: unknown): number | undefined {
  const parsed = googleTokenSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function metric(
  provider: string,
  field: string,
  category: ProviderUsageCategory,
  tokens: number,
  semantics: ProviderUsageSemantics
): ProviderUsageMetric {
  return { source: "provider-reported", provider, field, category, tokens, semantics };
}

function parsedUsage(candidate: Readonly<Record<string, number | undefined>>): ModelUsage | undefined {
  const present = Object.fromEntries(Object.entries(candidate).filter((entry): entry is [string, number] => entry[1] !== undefined));
  const parsed = normalizedUsageSchema.safeParse(present);
  return parsed.success ? parsed.data : undefined;
}

export function parseAnthropicReportedUsage(value: unknown): ParsedNativeUsage | undefined {
  const source = parseExternalRecord(value);
  if (!source) return undefined;
  const inputTokens = token(source.input_tokens);
  const cacheWriteTokens = token(source.cache_creation_input_tokens);
  const cacheReadTokens = token(source.cache_read_input_tokens);
  const outputTokens = token(source.output_tokens);
  const outputDetails = parseExternalRecord(source.output_tokens_details);
  const reportedThinkingTokens = token(outputDetails?.thinking_tokens);
  const reasoningTokens = outputTokens !== undefined
    && reportedThinkingTokens !== undefined
    && reportedThinkingTokens <= outputTokens
    ? reportedThinkingTokens
    : undefined;
  const providerUsage = [
    ...(inputTokens !== undefined ? [metric("anthropic-messages", "usage.input_tokens", "input", inputTokens, "exclusive")] : []),
    ...(cacheWriteTokens !== undefined ? [metric("anthropic-messages", "usage.cache_creation_input_tokens", "cache-write", cacheWriteTokens, "exclusive")] : []),
    ...(cacheReadTokens !== undefined ? [metric("anthropic-messages", "usage.cache_read_input_tokens", "cache-read", cacheReadTokens, "exclusive")] : []),
    ...(outputTokens !== undefined ? [metric("anthropic-messages", "usage.output_tokens", "output", outputTokens, "output-includes-reasoning")] : []),
    ...(reasoningTokens !== undefined ? [metric("anthropic-messages", "usage.output_tokens_details.thinking_tokens", "reasoning", reasoningTokens, "output-subset")] : [])
  ];
  if (providerUsage.length === 0) return undefined;
  return {
    usage: parsedUsage({ inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens }),
    providerUsage
  };
}

export function parseGoogleReportedUsage(value: unknown, provider: GoogleUsageProvider): ParsedNativeUsage | undefined {
  const source = parseExternalRecord(value);
  if (!source) return undefined;
  const inputTokens = googleToken(source.promptTokenCount);
  const outputTokens = googleToken(source.candidatesTokenCount);
  const totalTokens = googleToken(source.totalTokenCount);
  const cacheReadTokens = googleToken(source.cachedContentTokenCount);
  const reasoningTokens = googleToken(source.thoughtsTokenCount);
  const toolTokens = googleToken(source.toolUsePromptTokenCount);
  const toolSemantics = provider === "gemini-developer-api"
    ? "gemini-tool-use-prompt"
    : "vertex-tool-execution-result-input";
  const providerUsage = [
    ...(inputTokens !== undefined ? [metric(provider, "usageMetadata.promptTokenCount", "input", inputTokens, "input-includes-cache")] : []),
    ...(outputTokens !== undefined ? [metric(provider, "usageMetadata.candidatesTokenCount", "output", outputTokens, "exclusive")] : []),
    ...(totalTokens !== undefined ? [metric(provider, "usageMetadata.totalTokenCount", "total", totalTokens, "reported-total")] : []),
    ...(cacheReadTokens !== undefined ? [metric(provider, "usageMetadata.cachedContentTokenCount", "cache-read", cacheReadTokens, "input-overlap")] : []),
    ...(reasoningTokens !== undefined ? [metric(provider, "usageMetadata.thoughtsTokenCount", "reasoning", reasoningTokens, "exclusive")] : []),
    ...(toolTokens !== undefined ? [metric(provider, "usageMetadata.toolUsePromptTokenCount", "provider-specific", toolTokens, toolSemantics)] : [])
  ];
  if (providerUsage.length === 0) return undefined;
  return {
    usage: parsedUsage({ inputTokens, outputTokens, reasoningTokens, cacheReadTokens, totalTokens }),
    providerUsage
  };
}

export function parseCodexCliReportedUsage(value: unknown): ParsedNativeUsage | undefined {
  const source = parseExternalRecord(value);
  if (!source) return undefined;
  const inputTokens = token(source.input_tokens);
  const cacheReadTokens = token(source.cached_input_tokens);
  const outputTokens = token(source.output_tokens);
  const reasoningTokens = token(source.reasoning_output_tokens);
  const providerUsage = [
    ...(inputTokens !== undefined ? [metric("openai-codex-cli", "turn.completed.usage.input_tokens", "input", inputTokens, "input-includes-cache")] : []),
    ...(cacheReadTokens !== undefined ? [metric("openai-codex-cli", "turn.completed.usage.cached_input_tokens", "cache-read", cacheReadTokens, "input-overlap")] : []),
    ...(outputTokens !== undefined ? [metric("openai-codex-cli", "turn.completed.usage.output_tokens", "output", outputTokens, "output-includes-reasoning")] : []),
    ...(reasoningTokens !== undefined ? [metric("openai-codex-cli", "turn.completed.usage.reasoning_output_tokens", "reasoning", reasoningTokens, "output-subset")] : [])
  ];
  if (providerUsage.length === 0) return undefined;
  return {
    usage: parsedUsage({ inputTokens, outputTokens, reasoningTokens, cacheReadTokens }),
    providerUsage
  };
}
