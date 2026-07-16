import type { NormalizedUsage } from "../agents/preflight/metadata";
import { ledgerBreadthFirst } from "./session-ledger-lineage";
import { immutableClone } from "./session-ledger-immutability";
import { LedgerProjectionError } from "./session-ledger-errors";
import type { SessionLedgerProjection } from "./session-ledger-projection";

const TOKEN_BUCKETS = [
  "inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"
] as const satisfies readonly (keyof NormalizedUsage)[];
type TokenBucket = (typeof TOKEN_BUCKETS)[number];
type TokenTotal = Readonly<{ known: number; complete: boolean }>;

function checkedTokenSum(total: number, value: number): number {
  const next = total + value;
  if (!Number.isSafeInteger(next)) {
    throw new LedgerProjectionError("semantic-conflict", "Token total exceeds Number.MAX_SAFE_INTEGER");
  }
  return next;
}

export type InclusiveAccounting = Readonly<{
  attemptIds: readonly string[];
  tokens: Readonly<Record<TokenBucket, TokenTotal>>;
  knownCurrencySubtotals: Readonly<Record<string, number>>;
  unknownCurrencyAmounts: readonly number[];
  inclusiveCost?: Readonly<{ amount: number; currency: string }>;
}>;

export function projectInclusiveAccounting(
  projection: SessionLedgerProjection,
  rootAttemptId: string
): InclusiveAccounting {
  const attempts = ledgerBreadthFirst(projection, rootAttemptId);
  const accountable = attempts.filter(attempt => attempt.started || attempt.usage !== undefined);
  const totalFor = (bucket: TokenBucket): TokenTotal => {
    let known = 0;
    let complete = true;
    for (const attempt of accountable) {
      const value = attempt.usage?.usage?.[bucket];
      if (value === undefined) complete = false;
      else known = checkedTokenSum(known, value);
    }
    return { known, complete };
  };
  const knownCurrencySubtotals: Record<string, number> = {};
  const unknownCurrencyAmounts: number[] = [];
  let everyStartedHasCost = true;
  for (const attempt of attempts) {
    const cost = attempt.usage?.cost;
    if (attempt.started && cost === undefined) everyStartedHasCost = false;
    if (cost === undefined) continue;
    if (cost.currency === undefined) unknownCurrencyAmounts.push(cost.amount);
    else {
      const next = (knownCurrencySubtotals[cost.currency] ?? 0) + cost.amount;
      if (!Number.isFinite(next)) throw new LedgerProjectionError("semantic-conflict", "Cost total is not finite");
      knownCurrencySubtotals[cost.currency] = next;
    }
  }
  const currencies = Object.keys(knownCurrencySubtotals).sort();
  const inclusiveCost = everyStartedHasCost && unknownCurrencyAmounts.length === 0 && currencies.length === 1
    ? { amount: knownCurrencySubtotals[currencies[0] ?? ""] ?? 0, currency: currencies[0] ?? "" }
    : undefined;
  return immutableClone({
    attemptIds: attempts.map(attempt => attempt.attemptId),
    tokens: {
      inputTokens: totalFor("inputTokens"),
      outputTokens: totalFor("outputTokens"),
      reasoningTokens: totalFor("reasoningTokens"),
      cacheReadTokens: totalFor("cacheReadTokens"),
      cacheWriteTokens: totalFor("cacheWriteTokens"),
      totalTokens: totalFor("totalTokens")
    },
    knownCurrencySubtotals: Object.fromEntries(currencies.map(currency => [currency, knownCurrencySubtotals[currency]])),
    unknownCurrencyAmounts,
    ...(inclusiveCost === undefined ? {} : { inclusiveCost })
  });
}
