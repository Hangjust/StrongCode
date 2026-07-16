import { StrongCodeError } from "../core/errors";
import { validateConversationItems, type ConversationItem, type Message, type ToolCall } from "../core/types";
import type { NormalizedUsage } from "../agents/preflight/metadata";
import {
  preflightAdviceConversationItem,
  type UntrustedPreflightAdvice
} from "../agents/preflight/advice";

export interface ModelToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  prompt: string;
  systemPrompt?: string;
  sessionId: string;
  messages: Message[];
  items?: readonly ConversationItem[];
  tools: string[];
  toolDefinitions?: ModelToolDefinition[];
  signal?: AbortSignal;
  readonly untrustedPreflightAdvice?: UntrustedPreflightAdvice;
}

export interface ModelResponse {
  message: string;
  toolCalls: ToolCall[];
  readonly reasoning?: string;
  items?: readonly ConversationItem[];
  readonly usage?: ModelUsage;
  readonly providerCost?: ProviderReportedCost;
  readonly providerRequestId?: string;
  readonly providerResponseId?: string;
  readonly providerUsage?: readonly ProviderUsageMetric[];
  readonly directAttempts?: readonly DirectModelAttempt[];
}

export type ModelUsage = NormalizedUsage;

export interface ProviderReportedCost {
  readonly amount: number;
  readonly currency?: string;
}

export type ProviderUsageCategory = "input" | "output" | "reasoning" | "cache-read" | "cache-write" | "total" | "provider-specific";

export type ProviderUsageSemantics =
  | "exclusive"
  | "input-includes-cache"
  | "input-overlap"
  | "output-includes-reasoning"
  | "output-subset"
  | "reported-total"
  | "gemini-tool-use-prompt"
  | "vertex-tool-execution-result-input";

export interface ProviderUsageMetric {
  readonly source: "provider-reported";
  readonly provider: string;
  readonly field: string;
  readonly category: ProviderUsageCategory;
  readonly tokens: number;
  readonly semantics: ProviderUsageSemantics;
}

export interface DirectModelAttempt {
  readonly attemptId: string;
  readonly provider: string;
  readonly model: string;
  readonly scope: "exclusive";
  readonly usage?: ModelUsage;
  readonly providerUsage?: readonly ProviderUsageMetric[];
  readonly providerCost?: ProviderReportedCost;
  readonly providerRequestId?: string;
  readonly providerResponseId?: string;
}

export interface ModelProvider {
  name: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export function modelRequestItems(request: ModelRequest): readonly ConversationItem[] {
  const items = request.items ?? request.messages.map(message => ({
    type: "text",
    role: message.role,
    content: message.content
  }));
  const advisoryItems = request.untrustedPreflightAdvice === undefined
    ? []
    : [preflightAdviceConversationItem(request.untrustedPreflightAdvice)];
  return validateConversationItems([...advisoryItems, ...items]);
}

export function modelResponseItems(response: ModelResponse): readonly ConversationItem[] {
  if (response.items !== undefined) {
    return validateConversationItems(response.items);
  }

  const items: ConversationItem[] = response.message.length > 0
    ? [{ type: "text", role: "assistant", content: response.message }]
    : [];
  for (const toolCall of response.toolCalls) {
    if (toolCall.callId === undefined || toolCall.callId.trim().length === 0) {
      throw new StrongCodeError("VALIDATION_ERROR", `Tool call '${toolCall.name}' is missing a call ID`);
    }
    items.push({
      type: "tool_call",
      role: "assistant",
      callId: toolCall.callId,
      name: toolCall.name,
      input: toolCall.input
    });
  }
  return validateConversationItems(items);
}
