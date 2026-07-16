import { z } from "zod";
import { StrongCodeError } from "../core/errors";
import {
  parseConversationItem,
  validateCompleteConversationItems,
  validateConversationItems,
  type ConversationItem,
  type Message,
  type ToolExecution
} from "../core/types";
import {
  validateCompactionCheckpoint,
  type CompactionCheckpointSessionEvent
} from "./compaction-checkpoint";
import {
  parseSessionLedgerEvent,
  sessionLedgerEventSchema,
  type SessionLedgerEvent
} from "./session-ledger-events";

export { compactionCheckpointEvent } from "./compaction-checkpoint";
export type { CompactionCheckpointSessionEvent } from "./compaction-checkpoint";

const sessionEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    timestamp: z.string(),
    role: z.enum(["user", "assistant", "tool"]),
    content: z.string(),
    agentId: z.string().optional()
  }).strict(),
  z.object({
    type: z.literal("tool"),
    timestamp: z.string(),
    tool: z.string(),
    input: z.unknown(),
    output: z.string()
  }).strict(),
  z.object({
    type: z.literal("conversation_item"),
    timestamp: z.string(),
    item: z.unknown(),
    agentId: z.string().optional()
  }).strict(),
  z.object({
    type: z.literal("compaction_checkpoint"),
    timestamp: z.string(),
    agentId: z.string(),
    summary: z.string(),
    replacementHistory: z.array(z.unknown())
  }).strict()
]);

export type MessageSessionEvent = {
  type: "message";
  timestamp: string;
  role: Message["role"];
  content: string;
  agentId?: string;
};

export type ConversationItemSessionEvent = {
  type: "conversation_item";
  timestamp: string;
  item: ConversationItem;
  agentId?: string;
};

export type ConversationSessionEvent =
  | MessageSessionEvent
  | ConversationItemSessionEvent
  | CompactionCheckpointSessionEvent
  | {
      type: "tool";
      timestamp: string;
      tool: string;
      input: unknown;
	      output: string;
	    };

export type SessionEvent = ConversationSessionEvent | SessionLedgerEvent;

export interface Session {
  id: string;
  events: SessionEvent[];
}

export function messageEvent(role: Message["role"], content: string, agentId?: string): MessageSessionEvent {
  return {
    type: "message",
    timestamp: new Date().toISOString(),
    role,
    content,
    ...(agentId === undefined ? {} : { agentId })
  };
}

export { parseConversationItem };

export function conversationItemEvent(item: ConversationItem, agentId?: string): ConversationItemSessionEvent {
  return {
    type: "conversation_item",
    timestamp: new Date().toISOString(),
    item: parseConversationItem(item),
    ...(agentId === undefined ? {} : { agentId })
  };
}

export function parseSessionEvent(source: string): SessionEvent {
  try {
    const event = z.union([sessionEventSchema, sessionLedgerEventSchema]).parse(JSON.parse(source));
    switch (event.type) {
      case "message":
        return {
          type: event.type,
          timestamp: event.timestamp,
          role: event.role,
          content: event.content,
          ...(event.agentId === undefined ? {} : { agentId: event.agentId })
        };
      case "tool":
        return {
          type: event.type,
          timestamp: event.timestamp,
          tool: event.tool,
          input: event.input,
          output: event.output
        };
      case "conversation_item":
        return {
          type: event.type,
          timestamp: event.timestamp,
          item: parseConversationItem(event.item),
          ...(event.agentId === undefined ? {} : { agentId: event.agentId })
        };
      case "compaction_checkpoint": {
        const validated = validateCompactionCheckpoint(event.agentId, event.summary, event.replacementHistory);
        return {
          type: event.type,
          timestamp: event.timestamp,
          agentId: event.agentId,
          summary: validated.summary,
          replacementHistory: validated.replacementHistory
        };
      }
      case "summary_reserved": case "summary_committed": case "summary_failed_open":
      case "summary_cancelled": case "attempt_created": case "attempt_lifecycle":
      case "attempt_usage":
        return parseSessionLedgerEvent(event);
      default: {
        const exhaustiveEvent: never = event;
        return exhaustiveEvent;
      }
    }
  } catch (error) {
    if (error instanceof StrongCodeError) {
      throw error;
    }
    if (error instanceof Error) {
      throw new StrongCodeError("VALIDATION_ERROR", error.message);
    }
    throw new StrongCodeError("VALIDATION_ERROR", String(error));
  }
}

export function parseConversationSessionEvent(input: unknown): ConversationSessionEvent {
  const event = parseSessionEvent(JSON.stringify(input));
  switch (event.type) {
    case "message":
    case "tool":
    case "conversation_item":
    case "compaction_checkpoint":
      return event;
    case "summary_reserved": case "summary_committed": case "summary_failed_open":
    case "summary_cancelled": case "attempt_created": case "attempt_lifecycle":
    case "attempt_usage":
      throw new StrongCodeError("VALIDATION_ERROR", "Ledger events require projection-aware commit");
    default: {
      const exhaustiveEvent: never = event;
      return exhaustiveEvent;
    }
  }
}

export function toolEvent(execution: ToolExecution): ConversationSessionEvent {
  return {
    type: "tool",
    timestamp: new Date().toISOString(),
    tool: execution.tool,
    input: execution.input,
    output: execution.output
  };
}

export function eventsToConversationItems(events: readonly SessionEvent[]): ConversationItem[] {
  let items: ConversationItem[] = [];
  let checkpointApplied = false;

  for (const event of events) {
    switch (event.type) {
      case "message":
        items.push({ type: "text", role: event.role, content: event.content });
        break;
      case "tool":
        items.push({ type: "text", role: "tool", content: event.output });
        break;
      case "conversation_item":
        items.push(parseConversationItem(event.item));
        break;
      case "compaction_checkpoint": {
        const validated = validateCompactionCheckpoint(event.agentId, event.summary, event.replacementHistory);
        items = [...validated.replacementHistory];
        checkpointApplied = true;
        break;
      }
      case "summary_reserved": case "summary_committed": case "summary_failed_open":
      case "summary_cancelled": case "attempt_created": case "attempt_lifecycle":
      case "attempt_usage":
        break;
      default: {
        const exhaustiveEvent: never = event;
        return exhaustiveEvent;
      }
    }
  }
  return checkpointApplied
    ? validateCompleteConversationItems(items)
    : validateConversationItems(items);
}

export function conversationItemsToMessages(items: readonly ConversationItem[]): Message[] {
  const messages: Message[] = [];
  for (const item of items) {
    switch (item.type) {
      case "text":
        messages.push({ role: item.role, content: item.content });
        break;
      case "tool_call":
        break;
      case "tool_result":
        messages.push({ role: "tool", content: item.content });
        break;
      default: {
        const exhaustiveItem: never = item;
        return exhaustiveItem;
      }
    }
  }
  return messages;
}

export function eventsToModelConversationItems(events: readonly SessionEvent[]): ConversationItem[] {
  const providerItems = eventsToConversationItems(events).filter(item => (
    item.type !== "text" || item.role !== "tool"
  ));
  return validateCompleteConversationItems(providerItems);
}

export function eventsToMessages(events: readonly SessionEvent[]): Message[] {
  return conversationItemsToMessages(eventsToConversationItems(events));
}
