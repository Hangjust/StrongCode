import { z } from "zod";
import { StrongCodeError } from "../core/errors";
import type { ToolCall } from "../core/types";
import type { ModelResponse, ModelUsage } from "./provider";
import { mergeCumulativeUsage, parseExternalRecord, parseProviderRequestId, parseProviderResponseId, parseProviderUsage } from "./provider-usage";

type CorrelatedToolCall = ToolCall & { readonly callId: string };

const toolCallSchema = z.object({
  type: z.literal("function_call"),
  call_id: z.string().min(1).refine(id => id.trim().length > 0),
  name: z.string().min(1),
  arguments: z.string()
}).passthrough();

const summaryTextSchema = z.object({
  type: z.literal("summary_text"),
  text: z.string()
}).passthrough();

const reasoningSummaryDeltaSchema = z.object({
  type: z.literal("response.reasoning_summary_text.delta"),
  item_id: z.string().min(1).optional(),
  output_index: z.number().int().nonnegative().optional(),
  summary_index: z.number().int().nonnegative().optional(),
  delta: z.string()
}).passthrough();

const reasoningSummaryDoneSchema = z.object({
  type: z.literal("response.reasoning_summary_text.done"),
  item_id: z.string().min(1).optional(),
  output_index: z.number().int().nonnegative().optional(),
  summary_index: z.number().int().nonnegative().optional(),
  text: z.string()
}).passthrough();

type ReasoningSummaryIdentity = {
  readonly item_id?: string;
  readonly output_index?: number;
  readonly summary_index?: number;
};

type ReasoningSummarySlot = { text: string };

function parseToolCall(item: unknown): CorrelatedToolCall | undefined {
  const record = parseExternalRecord(item);
  if (record?.type !== "function_call") return undefined;
  const value = toolCallSchema.safeParse(record);
  if (!value.success) {
    throw new StrongCodeError("MODEL_ERROR", "ChatGPT returned a malformed function call or missing call ID");
  }
  try {
    return { callId: value.data.call_id, name: value.data.name, input: JSON.parse(value.data.arguments) };
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new StrongCodeError("MODEL_ERROR", `ChatGPT returned invalid arguments for tool '${value.data.name}'`);
    }
    throw error;
  }
}

function parseOutputItems(output: unknown): { readonly message: string; readonly reasoning: string; readonly toolCalls: CorrelatedToolCall[] } {
  if (!Array.isArray(output)) return { message: "", reasoning: "", toolCalls: [] };
  const messages: string[] = [];
  const reasoning: string[] = [];
  const toolCalls = new Map<string, CorrelatedToolCall>();
  for (const item of output) {
    const value = parseExternalRecord(item);
    const toolCall = parseToolCall(value);
    if (toolCall) {
      if (toolCalls.has(toolCall.callId)) {
        throw new StrongCodeError("MODEL_ERROR", `ChatGPT returned duplicate function call ID '${toolCall.callId}' in one output`);
      }
      toolCalls.set(toolCall.callId, toolCall);
      continue;
    }
    if (value?.type === "reasoning" && Array.isArray(value.summary)) {
      for (const summary of value.summary) {
        const parsed = summaryTextSchema.safeParse(summary);
        if (parsed.success) reasoning.push(parsed.data.text);
      }
      continue;
    }
    if (value?.type !== "message" || !Array.isArray(value.content)) continue;
    for (const part of value.content) {
      const content = parseExternalRecord(part);
      if (content?.type === "output_text" && typeof content.text === "string") messages.push(content.text);
    }
  }
  return { message: messages.join(""), reasoning: reasoning.join(""), toolCalls: [...toolCalls.values()] };
}

function summaryIdentityKeys(identity: ReasoningSummaryIdentity): string[] {
  const summaryIndex = identity.summary_index ?? 0;
  const keys: string[] = [];
  if (identity.item_id !== undefined) keys.push(`item:${identity.item_id}:${summaryIndex}`);
  if (identity.output_index !== undefined) keys.push(`output:${identity.output_index}:${summaryIndex}`);
  if (keys.length === 0) keys.push(`summary:${summaryIndex}`);
  return keys;
}

function reasoningSummarySlot(
  identity: ReasoningSummaryIdentity,
  slotsByIdentity: Map<string, ReasoningSummarySlot>,
  orderedSlots: ReasoningSummarySlot[]
): ReasoningSummarySlot {
  const keys = summaryIdentityKeys(identity);
  for (const key of keys) {
    const slot = slotsByIdentity.get(key);
    if (slot) {
      for (const alias of keys) slotsByIdentity.set(alias, slot);
      return slot;
    }
  }
  const slot = { text: "" };
  orderedSlots.push(slot);
  for (const key of keys) slotsByIdentity.set(key, slot);
  return slot;
}

function retainToolCall(toolCalls: Map<string, CorrelatedToolCall>, call: CorrelatedToolCall): void {
  const existing = toolCalls.get(call.callId);
  if (existing && (existing.name !== call.name || JSON.stringify(existing.input) !== JSON.stringify(call.input))) {
    throw new StrongCodeError("MODEL_ERROR", `ChatGPT reused function call ID '${call.callId}' with mismatched call data`);
  }
  toolCalls.set(call.callId, call);
}

function eventError(event: Readonly<Record<string, unknown>>): string | undefined {
  const response = parseExternalRecord(event.response);
  const error = parseExternalRecord(event.error) ?? parseExternalRecord(response?.error);
  const message = typeof error?.message === "string" ? error.message : typeof event.message === "string" ? event.message : undefined;
  return message?.replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, 2_000);
}

function parseEventStream(text: string, headerRequestId?: string): ModelResponse {
  let message = "";
  let sawDelta = false;
  let completed: ReturnType<typeof parseOutputItems> | undefined;
  let usage: ModelUsage | undefined;
  let providerRequestId = parseProviderRequestId(headerRequestId);
  let providerResponseId: string | undefined;
  let hasTerminalOutput = false;
  const toolCalls = new Map<string, CorrelatedToolCall>();
  const reasoningSlotsByIdentity = new Map<string, ReasoningSummarySlot>();
  const reasoningSlots: ReasoningSummarySlot[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    let event: Readonly<Record<string, unknown>> | undefined;
    try {
      event = parseExternalRecord(JSON.parse(data));
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    if (!event) continue;
    const response = parseExternalRecord(event.response);
    usage = mergeCumulativeUsage(usage, parseProviderUsage(response?.usage));
    if (event.type === "response.reasoning_summary_text.delta") {
      const parsed = reasoningSummaryDeltaSchema.safeParse(event);
      if (parsed.success) {
        reasoningSummarySlot(parsed.data, reasoningSlotsByIdentity, reasoningSlots).text += parsed.data.delta;
      }
      continue;
    }
    if (event.type === "response.reasoning_summary_text.done") {
      const parsed = reasoningSummaryDoneSchema.safeParse(event);
      if (parsed.success) {
        const slot = reasoningSummarySlot(parsed.data, reasoningSlotsByIdentity, reasoningSlots);
        if (parsed.data.text.trim().length > 0) slot.text = parsed.data.text;
      }
      continue;
    }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      message += event.delta;
      sawDelta = true;
      continue;
    }
    if (event.type === "response.output_text.done" && typeof event.text === "string") {
      if (!sawDelta) message = event.text;
      hasTerminalOutput = message.length > 0;
      continue;
    }
    if (event.type === "response.output_item.done") {
      const call = parseToolCall(event.item);
      if (call) {
        retainToolCall(toolCalls, call);
        hasTerminalOutput = true;
      }
      continue;
    }
    if (event.type === "response.completed") {
      completed = parseOutputItems(response?.output);
      providerResponseId = parseProviderResponseId(response?.id);
      hasTerminalOutput = hasTerminalOutput || message.length > 0 || completed.message.length > 0 || completed.toolCalls.length > 0;
      continue;
    }
    if (event.type === "response.failed" || event.type === "error") {
      throw new StrongCodeError("MODEL_ERROR", `ChatGPT response failed: ${eventError(event) ?? "unknown error"}`);
    }
  }
  if (!message && completed?.message) message = completed.message;
  const streamedReasoning = reasoningSlots.map(slot => slot.text).join("");
  const completedReasoning = completed?.reasoning ?? "";
  const reasoning = completedReasoning.trim().length > 0 ? completedReasoning : streamedReasoning;
  for (const call of completed?.toolCalls ?? []) retainToolCall(toolCalls, call);
  if (!hasTerminalOutput) {
    throw new StrongCodeError("MODEL_ERROR", "ChatGPT event stream contained no terminal output");
  }
  return {
    message,
    toolCalls: [...toolCalls.values()],
    ...(reasoning.trim().length > 0 ? { reasoning } : {}),
    ...(usage ? { usage } : {}),
    ...(providerRequestId ? { providerRequestId } : {}),
    ...(providerResponseId ? { providerResponseId } : {})
  };
}

export function parseChatGptResponse(text: string, contentType: string | null, headerRequestId?: string): ModelResponse {
  if (contentType?.includes("text/event-stream") || /(?:^|\n)event:\s*response\./.test(text)) {
    return parseEventStream(text, headerRequestId);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new StrongCodeError("MODEL_ERROR", "ChatGPT response was neither valid JSON nor an event stream");
    }
    throw error;
  }
  const root = parseExternalRecord(payload);
  const parsed = parseOutputItems(root?.output);
  if (!parsed.message && parsed.toolCalls.length === 0) {
    throw new StrongCodeError("MODEL_ERROR", "ChatGPT response contained no output");
  }
  const usage = parseProviderUsage(root?.usage);
  const providerRequestId = parseProviderRequestId(headerRequestId);
  const providerResponseId = parseProviderResponseId(root?.id);
  return {
    message: parsed.message,
    toolCalls: parsed.toolCalls,
    ...(parsed.reasoning.trim().length > 0 ? { reasoning: parsed.reasoning } : {}),
    ...(usage ? { usage } : {}),
    ...(providerRequestId ? { providerRequestId } : {}),
    ...(providerResponseId ? { providerResponseId } : {})
  };
}
