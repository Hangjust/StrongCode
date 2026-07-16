import { StrongCodeError } from "../core/errors";
import type { ConversationItem } from "../core/types";

export const COMPACTION_USER_TOKEN_BUDGET = 20_000 as const;
export const COMPACTION_SUMMARY_PREFIX =
  "StrongCode context checkpoint. Continue from this handoff without repeating completed work:" as const;
export const COMPACTION_TRUNCATION_MARKER = "\n[...earlier content truncated...]\n" as const;

type CompactionUserTextItem = {
  readonly type: "text";
  readonly role: "user";
  readonly content: string;
};

export type CompactionReplacement = {
  readonly summary: string;
  readonly replacementHistory: readonly CompactionUserTextItem[];
};

function retainableUserText(item: ConversationItem): CompactionUserTextItem | undefined {
  switch (item.type) {
    case "text":
      if (
        item.role !== "user"
        || item.content.trim().length === 0
        || item.content.startsWith(COMPACTION_SUMMARY_PREFIX)
      ) {
        return undefined;
      }
      return { type: "text", role: "user", content: item.content };
    case "tool_call":
    case "tool_result":
      return undefined;
    default: {
      const exhaustiveItem: never = item;
      return exhaustiveItem;
    }
  }
}

function middleTruncateUtf8(content: string, byteBudget: number): string | undefined {
  const markerBytes = Buffer.byteLength(COMPACTION_TRUNCATION_MARKER, "utf8");
  if (markerBytes > byteBudget) return undefined;

  const codePoints = Array.from(content);
  const contentBudget = byteBudget - markerBytes;
  const prefixBudget = Math.ceil(contentBudget / 2);
  let prefix = "";
  let prefixBytes = 0;
  let prefixEnd = 0;

  while (prefixEnd < codePoints.length) {
    const codePoint = codePoints[prefixEnd];
    const codePointBytes = Buffer.byteLength(codePoint, "utf8");
    if (prefixBytes + codePointBytes > prefixBudget) break;
    prefix += codePoint;
    prefixBytes += codePointBytes;
    prefixEnd += 1;
  }

  const suffixBudget = contentBudget - prefixBytes;
  let suffix = "";
  let suffixBytes = 0;
  let suffixStart = codePoints.length - 1;

  while (suffixStart >= prefixEnd) {
    const codePoint = codePoints[suffixStart];
    const codePointBytes = Buffer.byteLength(codePoint, "utf8");
    if (suffixBytes + codePointBytes > suffixBudget) break;
    suffix = codePoint + suffix;
    suffixBytes += codePointBytes;
    suffixStart -= 1;
  }

  return `${prefix}${COMPACTION_TRUNCATION_MARKER}${suffix}`;
}

export function buildCompactionReplacement(
  activeItems: readonly ConversationItem[],
  summaryBody: string,
  budget: number = COMPACTION_USER_TOKEN_BUDGET
): CompactionReplacement {
  const normalizedSummaryBody = summaryBody.trim();
  if (normalizedSummaryBody.length === 0) {
    throw new StrongCodeError("VALIDATION_ERROR", "Compaction summary body must not be empty");
  }

  const candidates: CompactionUserTextItem[] = [];
  for (const item of activeItems) {
    const candidate = retainableUserText(item);
    if (candidate) candidates.push(candidate);
  }

  const retainedNewestFirst: CompactionUserTextItem[] = [];
  let remainingTokens = budget;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    const estimatedTokens = Math.ceil(Buffer.byteLength(candidate.content, "utf8") / 4);
    if (estimatedTokens <= remainingTokens) {
      retainedNewestFirst.push(Object.freeze({ ...candidate }));
      remainingTokens -= estimatedTokens;
      continue;
    }

    const truncated = middleTruncateUtf8(candidate.content, remainingTokens * 4);
    if (truncated !== undefined) {
      retainedNewestFirst.push(Object.freeze({ type: "text", role: "user", content: truncated }));
    }
    break;
  }

  const summary = `${COMPACTION_SUMMARY_PREFIX}\n${normalizedSummaryBody}`;
  const summaryItem = Object.freeze({ type: "text", role: "user", content: summary } as const);
  const replacementHistory = Object.freeze([...retainedNewestFirst.reverse(), summaryItem]);
  return Object.freeze({ summary, replacementHistory });
}
