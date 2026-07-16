import type { ModelConfig, ProviderConfig } from "../config/schema";
import { StrongCodeError } from "../core/errors";
import type { ConversationItem, ToolCall } from "../core/types";
import type { ProviderAuthReader } from "./auth-store";
import { resolveProviderCredentials } from "./credentials";
import {
  formatNativeProviderError,
  globalNativeProviderFetchTransport,
  modelMaxTokens,
  nativeProviderRequestError,
  nativeProviderResponseError,
  NativeProviderFetcher,
  parseJson,
  stringifyNativeProviderBody,
  validateNativeResponseItems
} from "./native-provider-utils";
import { modelRequestItems, type ModelProvider, type ModelRequest, type ModelResponse } from "./provider";
import { parseAnthropicReportedUsage } from "./native-provider-usage";
import { parseExternalRecord, parseProviderRequestId, parseProviderResponseId } from "./provider-usage";
import { buildProviderUrl } from "./provider-url";
import { readBoundedResponseText } from "./response-body";

interface AnthropicProviderOptions {
  providerId: string;
  providerConfig: ProviderConfig;
  modelId: string;
  modelConfig: ModelConfig;
  fetcher?: NativeProviderFetcher;
  authStore?: ProviderAuthReader;
  allowEnvironmentCredentials?: boolean;
}

interface AnthropicMessage {
  readonly role: "user" | "assistant";
  readonly content: string | readonly AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly type: "tool_result"; readonly tool_use_id: string; readonly content: string; readonly is_error: boolean };

function anthropicRole(item: Extract<ConversationItem, { readonly type: "text" }>): "user" | "assistant" {
  return item.role === "assistant" ? "assistant" : "user";
}

function containsUserText(messages: readonly AnthropicMessage[], text: string): boolean {
  return messages.some(message => {
    if (message.role !== "user") return false;
    if (typeof message.content === "string") return message.content === text;
    return message.content.some(block => block.type === "text" && block.text === text);
  });
}

function appendAnthropicBlock(messages: AnthropicMessage[], role: AnthropicMessage["role"], block: AnthropicContentBlock): void {
  const previous = messages[messages.length - 1];
  if (previous?.role !== role) {
    messages.push({ role, content: [block] });
    return;
  }
  const content = typeof previous.content === "string"
    ? [{ type: "text" as const, text: previous.content }, block]
    : [...previous.content, block];
  messages[messages.length - 1] = { role, content };
}

function toAnthropicMessages(request: ModelRequest): AnthropicMessage[] {
  const converted: AnthropicMessage[] = [];
  for (const item of modelRequestItems(request)) {
    switch (item.type) {
      case "text": {
        if (item.role === "tool") {
          throw new StrongCodeError("VALIDATION_ERROR", "Anthropic tool output must use a correlated tool_result item");
        }
        const content = item.content.trim();
        if (content.length > 0) converted.push({ role: anthropicRole(item), content });
        break;
      }
      case "tool_call":
        appendAnthropicBlock(converted, "assistant", {
          type: "tool_use",
          id: item.callId,
          name: item.name,
          input: item.input
        });
        break;
      case "tool_result":
        appendAnthropicBlock(converted, "user", {
          type: "tool_result",
          tool_use_id: item.callId,
          content: item.content,
          is_error: item.isError
        });
        break;
    }
  }
  const current = request.prompt.trim();
  if (current.length > 0 && !containsUserText(converted, current)) converted.push({ role: "user", content: current });
  return converted.length > 0 ? converted : [{ role: "user", content: request.prompt }];
}

function parseAnthropicResponse(text: string, headerRequestId?: string): ModelResponse {
  const payload = parseExternalRecord(parseJson(text));
  const content = payload?.content;
  if (!Array.isArray(content)) {
    throw new StrongCodeError("MODEL_ERROR", "Anthropic completion response must include a content array");
  }

  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  const items: ConversationItem[] = [];
  for (const source of content) {
    const block = parseExternalRecord(source);
    if (!block) continue;
    if (block.type === "thinking" && typeof block.thinking === "string") {
      reasoningParts.push(block.thinking);
    }
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
      items.push({ type: "text", role: "assistant", content: block.text });
    }
    if (block.type === "tool_use") {
      if (typeof block.id !== "string" || block.id.trim().length === 0) {
        throw new StrongCodeError("MODEL_ERROR", "Anthropic tool_use block is missing an ID");
      }
      if (typeof block.name !== "string" || block.name.length === 0) {
        throw new StrongCodeError("MODEL_ERROR", `Anthropic tool_use '${block.id}' is missing a name`);
      }
      const input = "input" in block ? block.input : {};
      toolCalls.push({ callId: block.id, name: block.name, input });
      items.push({ type: "tool_call", role: "assistant", callId: block.id, name: block.name, input });
    }
  }

  const reportedUsage = parseAnthropicReportedUsage(payload?.usage);
  const providerRequestId = parseProviderRequestId(headerRequestId);
  const providerResponseId = parseProviderResponseId(payload?.id);
  const reasoning = reasoningParts.join("");
  return {
    message: textParts.join(""),
    ...(reasoning.trim().length > 0 ? { reasoning } : {}),
    toolCalls,
    items: validateNativeResponseItems("Anthropic", items),
    ...(reportedUsage?.usage ? { usage: reportedUsage.usage } : {}),
    ...(reportedUsage ? { providerUsage: reportedUsage.providerUsage } : {}),
    ...(providerRequestId ? { providerRequestId } : {}),
    ...(providerResponseId ? { providerResponseId } : {})
  };
}

export class AnthropicModelProvider implements ModelProvider {
  readonly name: string;
  private readonly fetcher: NativeProviderFetcher;

  constructor(private readonly options: AnthropicProviderOptions) {
    this.name = options.providerId;
    this.fetcher = options.fetcher ?? globalNativeProviderFetchTransport();
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    request.signal?.throwIfAborted();
    const credentials = await resolveProviderCredentials(this.options.providerId, this.options.providerConfig, {
      authStore: this.options.authStore,
      allowEnvironmentCredentials: this.options.allowEnvironmentCredentials
    });
    if (credentials.type !== "api") {
      throw new StrongCodeError("MODEL_ERROR", `Provider ${this.options.providerId} requires API-key authentication`);
    }
    request.signal?.throwIfAborted();

    const url = buildProviderUrl(this.options.providerConfig.baseUrl, "/messages", "Anthropic messages");
    const body = stringifyNativeProviderBody({
      model: this.options.modelConfig.model ?? this.options.modelId,
      max_tokens: modelMaxTokens(this.options.modelConfig.options),
      messages: toAnthropicMessages(request),
      ...(request.systemPrompt ? { system: request.systemPrompt } : {}),
      ...(request.tools.length > 0 ? {
        tools: (request.toolDefinitions ?? request.tools.map(name => ({
          name,
          description: `StrongCode tool: ${name}`,
          inputSchema: { type: "object", additionalProperties: true }
        }))).map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }))
      } : {})
    }, "Anthropic");

    let response;
    try {
      response = await this.fetcher(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": credentials.apiKey,
          "anthropic-version": "2023-06-01"
        },
        body,
        ...(request.signal ? { signal: request.signal } : {})
      });
      request.signal?.throwIfAborted();
    } catch {
      if (request.signal?.aborted) throw request.signal.reason;
      throw nativeProviderRequestError(this.options.providerId);
    }

    let responseText: string;
    try {
      responseText = await readBoundedResponseText(response);
      request.signal?.throwIfAborted();
    } catch (error) {
      if (request.signal?.aborted) throw request.signal.reason;
      if (error instanceof StrongCodeError) throw nativeProviderResponseError(this.options.providerId, error);
      throw nativeProviderResponseError(this.options.providerId, error);
    }
    if (!response.ok) {
      const detail = formatNativeProviderError(response, responseText, credentials.secret);
      throw new StrongCodeError("MODEL_ERROR", `Provider ${this.options.providerId} completion failed with HTTP ${response.status}: ${detail}`);
    }
    request.signal?.throwIfAborted();
    return parseAnthropicResponse(responseText, response.headers?.get("request-id") ?? undefined);
  }
}
