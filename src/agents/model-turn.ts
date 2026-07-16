import { isDeepStrictEqual } from "node:util";
import { StrongCodeError } from "../core/errors";
import type { ConversationItem, ConversationToolCallItem } from "../core/types";
import { modelResponseItems, type ModelResponse } from "../models/provider";
import { immutableConversationItems } from "./conversation-snapshot";

export type ModelTurn = {
  readonly assistantText: string;
  readonly calls: readonly ConversationToolCallItem[];
  readonly reasoning?: string;
  readonly items: readonly ConversationItem[];
};

function contradiction(detail: string): StrongCodeError {
  return new StrongCodeError("MODEL_ERROR", `Model response compatibility fields contradict items: ${detail}`);
}

export function modelTurn(response: ModelResponse): ModelTurn {
  const responseItems = modelResponseItems(response);
  const textParts: string[] = [];
  const calls: ConversationToolCallItem[] = [];

  for (const item of responseItems) {
    switch (item.type) {
      case "text":
        if (item.role !== "assistant") throw contradiction(`response text has role '${item.role}'`);
        textParts.push(item.content);
        break;
      case "tool_call":
        calls.push(item);
        break;
      case "tool_result":
        throw contradiction("responses may not contain tool_result items");
      default: {
        const exhaustiveItem: never = item;
        return exhaustiveItem;
      }
    }
  }

  if (response.items !== undefined) {
    if (textParts.join("") !== response.message) throw contradiction("message text differs");
    if (calls.length !== response.toolCalls.length) throw contradiction("tool call count differs");
    for (let index = 0; index < calls.length; index += 1) {
      const item = calls[index];
      const legacy = response.toolCalls[index];
      if (!item || !legacy) throw contradiction("tool call order differs");
      if (legacy.callId !== item.callId) throw contradiction(`tool call ${index + 1} ID differs`);
      if (legacy.name !== item.name) throw contradiction(`tool call ${index + 1} name differs`);
      if (!isDeepStrictEqual(legacy.input, item.input)) throw contradiction(`tool call ${index + 1} input differs`);
    }
  }

  const assistantText = textParts.join("").trim();
  const reasoning = response.reasoning?.trim() ?? "";
  const normalizedReasoning = reasoning.length > 0 ? reasoning : undefined;
  const normalized: ConversationItem[] = [
    ...(assistantText.length > 0 ? [{ type: "text" as const, role: "assistant" as const, content: assistantText }] : []),
    ...calls
  ];
  const items = immutableConversationItems(normalized);
  const immutableCalls: ConversationToolCallItem[] = [];
  for (const item of items) {
    if (item.type === "tool_call") immutableCalls.push(item);
  }
  const result: Omit<ModelTurn, "reasoning"> = {
    assistantText,
    calls: Object.freeze(immutableCalls),
    items
  };
  return normalizedReasoning === undefined
    ? result
    : { ...result, reasoning: normalizedReasoning };
}
