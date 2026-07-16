import { StrongCodeError } from "../core/errors";
import { parseConversationItem, type ConversationItem } from "../core/types";
import { COMPACTION_SUMMARY_PREFIX, type CompactionReplacement } from "./compaction";

export type CompactionCheckpointSessionEvent = {
  readonly type: "compaction_checkpoint";
  readonly timestamp: string;
  readonly agentId: string;
  readonly summary: string;
  readonly replacementHistory: CompactionReplacement["replacementHistory"];
};

export function validateCompactionCheckpoint(
  agentId: string,
  summary: string,
  replacementHistory: readonly unknown[]
): CompactionReplacement {
  if (agentId.trim().length === 0) {
    throw new StrongCodeError("VALIDATION_ERROR", "Compaction checkpoint agent ID must not be empty");
  }
  if (!summary.startsWith(`${COMPACTION_SUMMARY_PREFIX}\n`)) {
    throw new StrongCodeError("VALIDATION_ERROR", "Compaction checkpoint summary must use the required prefix");
  }
  const summaryBody = summary.slice(`${COMPACTION_SUMMARY_PREFIX}\n`.length);
  if (summaryBody.trim().length === 0) {
    throw new StrongCodeError("VALIDATION_ERROR", "Compaction checkpoint summary body must not be empty");
  }
  if (replacementHistory.length === 0) {
    throw new StrongCodeError("VALIDATION_ERROR", "Compaction checkpoint replacement history must not be empty");
  }

  const validatedHistory: Array<CompactionReplacement["replacementHistory"][number]> = [];
  for (let index = 0; index < replacementHistory.length; index += 1) {
    const item = parseConversationItem(replacementHistory[index]);
    switch (item.type) {
      case "text":
        if (item.role !== "user") {
          throw new StrongCodeError("VALIDATION_ERROR", "Compaction checkpoint history must contain only user text");
        }
        if (index < replacementHistory.length - 1 && item.content.startsWith(COMPACTION_SUMMARY_PREFIX)) {
          throw new StrongCodeError("VALIDATION_ERROR", "Compaction checkpoint history must not contain a prior summary");
        }
        validatedHistory.push({ type: "text", role: "user", content: item.content });
        break;
      case "tool_call":
      case "tool_result":
        throw new StrongCodeError("VALIDATION_ERROR", "Compaction checkpoint history must contain only user text");
      default: {
        const exhaustiveItem: never = item;
        return exhaustiveItem;
      }
    }
  }

  const finalItem = validatedHistory.at(-1);
  if (finalItem === undefined || finalItem.content !== summary) {
    throw new StrongCodeError("VALIDATION_ERROR", "Compaction checkpoint summary must be the final history item");
  }
  return { summary, replacementHistory: validatedHistory };
}

export function compactionCheckpointEvent(
  agentId: string,
  summary: string,
  replacementHistory: readonly ConversationItem[]
): CompactionCheckpointSessionEvent {
  const validated = validateCompactionCheckpoint(agentId, summary, replacementHistory);
  return {
    type: "compaction_checkpoint",
    timestamp: new Date().toISOString(),
    agentId,
    summary: validated.summary,
    replacementHistory: validated.replacementHistory
  };
}
