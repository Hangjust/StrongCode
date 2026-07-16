import { z } from "zod";
import { StrongCodeError } from "../core/errors";
import type { ToolCall } from "../core/types";
import type { ModelResponse } from "./provider";
import { parseProviderCost, parseProviderRequestId, parseProviderResponseId, parseProviderUsage } from "./provider-usage";

const responseSchema = z.object({
  id: z.unknown().optional(),
  usage: z.unknown().optional(),
  choices: z.array(z.object({ message: z.unknown().optional() }).passthrough()).min(1)
}).passthrough();
const messageSchema = z.object({
  content: z.union([z.string(), z.null()]),
  tool_calls: z.unknown().optional(),
  reasoning_content: z.unknown().optional(),
  reasoning: z.unknown().optional(),
  reasoning_details: z.unknown().optional()
}).passthrough();
const reasoningTextSchema = z.string();
const reasoningDetailSchema = z.union([
  z.object({ type: z.literal("reasoning.text"), text: z.string() }).transform(detail => detail.text),
  z.object({ type: z.literal("reasoning.summary"), summary: z.string() }).transform(detail => detail.summary)
]);
const toolCallsSchema = z.array(z.object({
  id: z.string().min(1).refine(id => id.trim().length > 0),
  function: z.object({ name: z.string().min(1), arguments: z.string() }).passthrough()
}).passthrough());
const errorSchema = z.object({
  error: z.object({
    type: z.unknown().optional(),
    message: z.unknown().optional(),
    param: z.unknown().optional(),
    code: z.unknown().optional()
  }).passthrough().optional()
}).passthrough();

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function parseToolCalls(value: unknown): ToolCall[] {
  if (value === undefined) return [];
  const parsed = toolCallsSchema.safeParse(value);
  if (!parsed.success) {
    throw new StrongCodeError("MODEL_ERROR", "Model completion returned a malformed tool call or missing call ID");
  }
  const calls: ToolCall[] = [];
  const callIds = new Set<string>();
  for (const item of parsed.data) {
    if (callIds.has(item.id)) {
      throw new StrongCodeError("MODEL_ERROR", `Model completion returned duplicate tool call ID '${item.id}'`);
    }
    callIds.add(item.id);
    try {
      calls.push({ callId: item.id, name: item.function.name, input: JSON.parse(item.function.arguments) });
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new StrongCodeError("MODEL_ERROR", `Model completion returned invalid arguments for tool '${item.function.name}'`);
      }
      throw error;
    }
  }
  return calls;
}

function parseReasoning(reasoningContent: unknown, reasoning: unknown, reasoningDetails: unknown): string | undefined {
  for (const value of [reasoningContent, reasoning]) {
    const parsed = reasoningTextSchema.safeParse(value);
    if (!parsed.success) continue;
    const text = parsed.data.trim();
    if (text.length > 0) return text;
  }
  if (!Array.isArray(reasoningDetails)) return undefined;
  const parts: string[] = [];
  for (const entry of reasoningDetails) {
    const parsed = reasoningDetailSchema.safeParse(entry);
    if (!parsed.success) continue;
    const text = parsed.data.trim();
    if (text.length > 0) parts.push(text);
  }
  const text = parts.join("\n");
  return text.length > 0 ? text : undefined;
}

export function parseOpenAICompatibleResponse(responseText: string, headerRequestId?: string): ModelResponse {
  const payload = responseSchema.safeParse(parseJson(responseText));
  if (!payload.success) {
    throw new StrongCodeError("MODEL_ERROR", "Model completion response must include choices[0].message");
  }
  const firstChoice = payload.data.choices[0];
  const message = messageSchema.safeParse(firstChoice?.message);
  if (!message.success) {
    throw new StrongCodeError("MODEL_ERROR", "Model completion response must include choices[0].message.content");
  }
  const usage = parseProviderUsage(payload.data.usage);
  const providerCost = parseProviderCost(payload.data.usage);
  const providerRequestId = parseProviderRequestId(headerRequestId);
  const providerResponseId = parseProviderResponseId(payload.data.id);
  const reasoning = parseReasoning(message.data.reasoning_content, message.data.reasoning, message.data.reasoning_details);
  return {
    message: message.data.content ?? "",
    toolCalls: parseToolCalls(message.data.tool_calls),
    ...(reasoning ? { reasoning } : {}),
    ...(usage ? { usage } : {}),
    ...(providerCost ? { providerCost } : {}),
    ...(providerRequestId ? { providerRequestId } : {}),
    ...(providerResponseId ? { providerResponseId } : {})
  };
}

export function parseOpenAICompatibleErrorDetails(responseText: string): readonly string[] {
  const payload = errorSchema.safeParse(parseJson(responseText));
  if (!payload.success || !payload.data.error) return [];
  return [
    payload.data.error.type,
    payload.data.error.message,
    payload.data.error.param,
    payload.data.error.code
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}
