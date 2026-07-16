import type { ModelResponse } from "../../models/provider";

export function estimateConfiguredCost(
  usage: ModelResponse["usage"],
  pricing: Readonly<{
    version: string;
    currency: string;
    inputPerMillion?: number;
    outputPerMillion?: number;
  }> | undefined
): Readonly<{ kind: "estimated"; amount: number; currency: string; pricingVersion: string }> | undefined {
  if (pricing === undefined || usage?.inputTokens === undefined || usage.outputTokens === undefined
    || usage.totalTokens !== usage.inputTokens + usage.outputTokens
    || usage.reasoningTokens !== undefined || usage.cacheReadTokens !== undefined || usage.cacheWriteTokens !== undefined
    || pricing.inputPerMillion === undefined || pricing.outputPerMillion === undefined) {
    return undefined;
  }
  const amount = (usage.inputTokens * pricing.inputPerMillion + usage.outputTokens * pricing.outputPerMillion) / 1_000_000;
  if (!Number.isFinite(amount)) return undefined;
  return {
    kind: "estimated",
    amount,
    currency: pricing.currency,
    pricingVersion: pricing.version
  };
}
