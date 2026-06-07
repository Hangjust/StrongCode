import { ProviderConfig, ModelConfig } from "../config/schema";
import { StrongCodeError } from "../core/errors";
import { Message, Role, ToolCall } from "../core/types";
import { resolveProviderCredentials } from "./credentials";
import type { ProviderAuthReader } from "./auth-store";
import { buildProviderUrl } from "./provider-url";
import { ModelProvider, ModelRequest, ModelResponse } from "./provider";
import { CHATGPT_CODEX_ENDPOINT } from "./chatgpt-oauth";

type ChatRole = "system" | "user" | "assistant";

interface ChatMessage {
  role: ChatRole;
  content: string;
}

interface OpenAICompatibleFetchResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
}

export type OpenAICompatibleFetcher = (url: string, init: {
  method: "POST";
  headers: Record<string, string>;
  body: string;
}) => Promise<OpenAICompatibleFetchResponse>;

interface OpenAIChoiceMessage {
  content?: unknown;
  tool_calls?: unknown;
}

interface OpenAIChoice {
  message?: OpenAIChoiceMessage;
}

interface OpenAIResponseBody {
  choices?: OpenAIChoice[];
}

interface OpenAIErrorBody {
  error?: {
    type?: unknown;
    message?: unknown;
    param?: unknown;
    code?: unknown;
  };
}

export interface OpenAICompatibleProviderOptions {
  providerId: string;
  providerConfig: ProviderConfig;
  modelId: string;
  modelConfig: ModelConfig;
  fetcher?: OpenAICompatibleFetcher;
  authStore?: ProviderAuthReader;
}

function buildChatCompletionsUrl(providerId: string, providerConfig: Pick<ProviderConfig, "baseUrl">): string {
  try {
    return buildProviderUrl(providerConfig.baseUrl, "/chat/completions", "chat completions");
  } catch (error) {
    if (error instanceof StrongCodeError) {
      throw new StrongCodeError(error.code, `Provider ${providerId} ${error.message.replace(/^Provider /, "")}`);
    }
    throw error;
  }
}

function completionUrl(providerId: string, providerConfig: Pick<ProviderConfig, "baseUrl">, credentialType: "api" | "oauth"): string {
  if (providerId === "openai" && credentialType === "oauth") return CHATGPT_CODEX_ENDPOINT;
  return buildChatCompletionsUrl(providerId, providerConfig);
}

function globalOpenAICompatibleFetchTransport(): OpenAICompatibleFetcher {
  return async (url, init) => {
    if (typeof fetch !== "function") {
      throw new StrongCodeError("MODEL_ERROR", "Global fetch is not available for chat completions");
    }

    const response = await fetch(url, init);
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      text: () => response.text()
    };
  };
}

function roleToChatRole(role: Role): ChatRole {
  if (role === "assistant") {
    return "assistant";
  }

  return "user";
}

function toChatMessages(messages: Message[], prompt: string): ChatMessage[] {
  const chatMessages = messages
    .map(message => ({ role: roleToChatRole(message.role), content: message.content.trim() }))
    .filter(message => message.content.length > 0);

  const promptContent = prompt.trim();
  if (promptContent.length > 0 && !chatMessages.some(message => message.role === "user" && message.content === promptContent)) {
    chatMessages.push({ role: "user", content: promptContent });
  }

  if (chatMessages.length === 0) {
    return [{ role: "user", content: prompt }];
  }

  return chatMessages;
}

function redactSensitive(value: string, apiKey: string): string {
  let redacted = value;
  if (apiKey.length > 0) {
    redacted = redacted.split(apiKey).join("[redacted]");
  }

  return redacted
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/(authorization\s*[:=]\s*)[^\s,;}]+/gi, "$1[redacted]")
    .replace(/((?:api[-_]?key|x-api-key)\s*[:=]\s*)[^\s,;}]+/gi, "$1[redacted]");
}

function tryParseJson(text: string): unknown {
  if (text.trim().length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    return undefined;
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function formatProviderError(response: OpenAICompatibleFetchResponse, responseText: string, apiKey: string): string {
  const payload = tryParseJson(responseText);
  if (payload && typeof payload === "object") {
    const error = (payload as OpenAIErrorBody).error;
    if (error && typeof error === "object") {
      const parts = [
        stringField(error.type),
        stringField(error.message),
        stringField(error.param),
        stringField(error.code)
      ];
      const detail = parts.filter((part): part is string => Boolean(part)).join("; ");
      if (detail.length > 0) {
        return redactSensitive(detail, apiKey);
      }
    }
  }

  return response.statusText ? redactSensitive(response.statusText, apiKey) : "request failed";
}

function parseToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const toolCalls: ToolCall[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      return [];
    }

    const functionValue = (item as { function?: unknown }).function;
    if (!functionValue || typeof functionValue !== "object") {
      return [];
    }

    const name = (functionValue as { name?: unknown }).name;
    const argumentsValue = (functionValue as { arguments?: unknown }).arguments;
    if (typeof name !== "string" || name.length === 0 || typeof argumentsValue !== "string") {
      return [];
    }

    let input: unknown;
    try {
      input = JSON.parse(argumentsValue);
    } catch (error) {
      return [];
    }

    toolCalls.push({ name, input });
  }

  return toolCalls;
}

function parseCompletionResponse(responseText: string): ModelResponse {
  const payload = tryParseJson(responseText);
  if (!payload || typeof payload !== "object") {
    throw new StrongCodeError("MODEL_ERROR", "Model completion response must be valid JSON");
  }

  const choices = (payload as OpenAIResponseBody).choices;
  const message = choices?.[0]?.message;
  if (!message || typeof message !== "object") {
    throw new StrongCodeError("MODEL_ERROR", "Model completion response must include choices[0].message");
  }

  const toolCalls = parseToolCalls(message.tool_calls);
  if (message.content !== null && typeof message.content !== "string") {
    throw new StrongCodeError("MODEL_ERROR", "Model completion response must include choices[0].message.content");
  }

  return {
    message: message.content ?? "",
    toolCalls
  };
}

export class OpenAICompatibleModelProvider implements ModelProvider {
  readonly name: string;
  private readonly fetcher: OpenAICompatibleFetcher;

  constructor(private readonly options: OpenAICompatibleProviderOptions) {
    this.name = options.providerId;
    this.fetcher = options.fetcher ?? globalOpenAICompatibleFetchTransport();
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const credentials = await resolveProviderCredentials(this.options.providerId, this.options.providerConfig, { authStore: this.options.authStore });
    const url = completionUrl(this.options.providerId, this.options.providerConfig, credentials.type);
    const body = JSON.stringify({
      model: this.options.modelConfig.model ?? this.options.modelId,
      messages: toChatMessages(request.messages, request.prompt)
    });

    let response: OpenAICompatibleFetchResponse;
    try {
      response = await this.fetcher(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${credentials.type === "oauth" ? credentials.access : credentials.apiKey}`,
          ...(credentials.type === "oauth" && credentials.accountId ? { "ChatGPT-Account-Id": credentials.accountId } : {})
        },
        body
      });
    } catch (error) {
      if (error instanceof StrongCodeError) {
        throw error;
      }

      const message = error instanceof Error ? redactSensitive(error.message, credentials.secret) : "request failed";
      throw new StrongCodeError("MODEL_ERROR", `Provider ${this.options.providerId} completion request failed: ${message}`);
    }

    const responseText = await response.text();
    if (!response.ok) {
      const detail = formatProviderError(response, responseText, credentials.secret);
      throw new StrongCodeError("MODEL_ERROR", `Provider ${this.options.providerId} completion failed with HTTP ${response.status}: ${detail}`);
    }

    return parseCompletionResponse(responseText);
  }
}
