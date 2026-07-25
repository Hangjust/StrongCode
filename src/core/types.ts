import { z } from "zod";
import { StrongCodeError } from "./errors";
import type { PlanReceipt } from "../agents/plan-handoff";

export type Role = "user" | "assistant" | "tool";

export type CallId = string;

export type ConversationTextItem = {
  readonly type: "text";
  readonly role: Role;
  readonly content: string;
};

export type ConversationToolCallItem = {
  readonly type: "tool_call";
  readonly role: "assistant";
  readonly callId: CallId;
  readonly name: string;
  readonly input: unknown;
};

export type ConversationToolResultItem = {
  readonly type: "tool_result";
  readonly role: "tool";
  readonly callId: CallId;
  readonly content: string;
  readonly isError: boolean;
};

export type ConversationItem = ConversationTextItem | ConversationToolCallItem | ConversationToolResultItem;

const INTERRUPTED_TOOL_RESULT_CONTENT = "Tool execution was interrupted before a result was recorded; its outcome is unknown and StrongCode will not retry it automatically.";

export type ReservedAttachmentItem = {
  readonly type: "attachment";
};

const callIdSchema = z.string().min(1).refine(callId => callId.trim().length > 0, "Call ID must not be empty");

const conversationItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    role: z.enum(["user", "assistant", "tool"]),
    content: z.string()
  }).strict(),
  z.object({
    type: z.literal("tool_call"),
    role: z.literal("assistant"),
    callId: callIdSchema,
    name: z.string().min(1),
    input: z.unknown()
  }).strict(),
  z.object({
    type: z.literal("tool_result"),
    role: z.literal("tool"),
    callId: callIdSchema,
    content: z.string(),
    isError: z.boolean()
  }).strict()
]);

export function parseConversationItem(source: unknown): ConversationItem {
  const attachment = z.object({ type: z.literal("attachment") }).passthrough().safeParse(source);
  if (attachment.success) {
    throw new StrongCodeError("VALIDATION_ERROR", "attachment conversation items are not supported in this release");
  }

  const parsed = conversationItemSchema.safeParse(source);
  if (!parsed.success) {
    throw new StrongCodeError("VALIDATION_ERROR", parsed.error.message);
  }
  switch (parsed.data.type) {
    case "text":
      return parsed.data;
    case "tool_call":
      if (!("input" in parsed.data)) {
        throw new StrongCodeError("VALIDATION_ERROR", "Tool call input is required");
      }
      return {
        type: parsed.data.type,
        role: parsed.data.role,
        callId: parsed.data.callId,
        name: parsed.data.name,
        input: parsed.data.input
      };
    case "tool_result":
      return parsed.data;
  }
}

export function validateConversationItems(sources: readonly unknown[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  const callIds = new Set<string>();
  const resultIds = new Set<string>();

  for (const source of sources) {
    const item = parseConversationItem(source);
    if (item.type === "tool_call") {
      if (callIds.has(item.callId)) {
        throw new StrongCodeError("VALIDATION_ERROR", `Duplicate tool call ID '${item.callId}'`);
      }
      callIds.add(item.callId);
    } else if (item.type === "tool_result") {
      if (!callIds.has(item.callId)) {
        throw new StrongCodeError("VALIDATION_ERROR", `Tool result '${item.callId}' has no preceding call`);
      }
      if (resultIds.has(item.callId)) {
        throw new StrongCodeError("VALIDATION_ERROR", `Duplicate tool result ID '${item.callId}'`);
      }
      resultIds.add(item.callId);
    }
    items.push(item);
  }
  return items;
}

export function normalizeConversationItemsForPrompt(sources: readonly unknown[]): readonly ConversationItem[] {
  const items = validateConversationItems(sources);
  const unresolvedCallIds = new Set<CallId>();

  for (const item of items) {
    switch (item.type) {
      case "text":
        break;
      case "tool_call":
        unresolvedCallIds.add(item.callId);
        break;
      case "tool_result":
        unresolvedCallIds.delete(item.callId);
        break;
      default: {
        const exhaustiveItem: never = item;
        return exhaustiveItem;
      }
    }
  }

  if (unresolvedCallIds.size === 0) return items;

  const normalizedItems: ConversationItem[] = [];
  const missingGroupCallIds: CallId[] = [];
  const appendMissingGroupResults = (): void => {
    for (const callId of missingGroupCallIds) {
      normalizedItems.push({
        type: "tool_result",
        role: "tool",
        callId,
        content: INTERRUPTED_TOOL_RESULT_CONTENT,
        isError: true
      });
    }
    missingGroupCallIds.length = 0;
  };

  for (const item of items) {
    switch (item.type) {
      case "text":
        appendMissingGroupResults();
        normalizedItems.push(item);
        break;
      case "tool_call":
        normalizedItems.push(item);
        if (unresolvedCallIds.has(item.callId)) missingGroupCallIds.push(item.callId);
        break;
      case "tool_result":
        normalizedItems.push(item);
        break;
      default: {
        const exhaustiveItem: never = item;
        return exhaustiveItem;
      }
    }
  }
  appendMissingGroupResults();
  return normalizedItems;
}

export function validateCompleteConversationItems(sources: readonly unknown[]): ConversationItem[] {
  const items = validateConversationItems(sources);
  const unresolvedCallIds = new Set<CallId>();

  for (const item of items) {
    switch (item.type) {
      case "text":
        break;
      case "tool_call":
        unresolvedCallIds.add(item.callId);
        break;
      case "tool_result":
        unresolvedCallIds.delete(item.callId);
        break;
      default: {
        const exhaustiveItem: never = item;
        return exhaustiveItem;
      }
    }
  }

  const danglingCall = unresolvedCallIds.values().next();
  if (!danglingCall.done) {
    throw new StrongCodeError("VALIDATION_ERROR", `Tool call '${danglingCall.value}' has no later result`);
  }
  return items;
}

export interface Message {
  role: Role;
  content: string;
}

export interface ToolCall {
  callId?: CallId;
  name: string;
  input: unknown;
}

export interface ToolExecution {
  tool: string;
  input: unknown;
  output: string;
}

export interface AgentRunResult {
  sessionId: string;
  response: string;
  readonly reasoning?: string;
  toolExecutions: ToolExecution[];
  readonly planReceipt?: PlanReceipt;
}
