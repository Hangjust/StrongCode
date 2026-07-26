import type { ProviderConfig, ModelConfig } from "../config/schema";
import { StrongCodeError } from "../core/errors";
import type { ConversationItem } from "../core/types";
import { resolveProviderCredentials } from "./credentials";
import type { ProviderAuthReader } from "./auth-store";
import { buildProviderUrl } from "./provider-url";
import { modelRequestItems, type ModelProvider, type ModelRequest, type ModelResponse } from "./provider";
import type { ProviderResponseBody } from "./response-body";
import { MAX_COMPLETION_RESPONSE_BYTES, readBoundedResponseText } from "./response-body";
import { parseOpenAICompatibleErrorDetails, parseOpenAICompatibleResponse } from "./openai-compatible-response";
import { promptCacheKey } from "./prompt-cache";

type ChatRole = "system" | "user" | "assistant" | "tool";

interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string | null;
  readonly tool_calls?: readonly {
    readonly id: string;
    readonly type: "function";
    readonly function: { readonly name: string; readonly arguments: string };
  }[];
  readonly tool_call_id?: string;
}

interface OpenAICompatibleFetchResponse extends ProviderResponseBody {
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
}

export type OpenAICompatibleFetcher = (url: string, init: {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}) => Promise<OpenAICompatibleFetchResponse>;

export interface OpenAICompatibleProviderOptions {
  providerId: string;
  providerConfig: ProviderConfig;
  modelId: string;
  modelConfig: ModelConfig;
  fetcher?: OpenAICompatibleFetcher;
  authStore?: ProviderAuthReader;
  allowEnvironmentCredentials?: boolean;
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

function completionUrl(providerId: string, providerConfig: Pick<ProviderConfig, "baseUrl">): string {
  return buildChatCompletionsUrl(providerId, providerConfig);
}

function supportsOpenAIPromptCaching(completionEndpoint: string): boolean {
  const endpoint = new URL(completionEndpoint);
  return endpoint.protocol === "https:" && endpoint.hostname === "api.openai.com" && endpoint.port === "";
}

function globalOpenAICompatibleFetchTransport(): OpenAICompatibleFetcher {
  return async (url, init) => {
    if (typeof fetch !== "function") {
      throw new StrongCodeError("MODEL_ERROR", "Global fetch is not available for chat completions");
    }

    return fetch(url, init);
  };
}

function toChatMessages(request: ModelRequest, items: readonly ConversationItem[]): ChatMessage[] {
  const chatMessages: ChatMessage[] = [];
  for (const item of items) {
    switch (item.type) {
      case "text": {
        if (item.role === "tool") {
          throw new StrongCodeError("VALIDATION_ERROR", "Flat tool text requires a correlated tool_result item");
        }
        const content = item.content.trim();
        if (content.length > 0) chatMessages.push({ role: item.role, content });
        break;
      }
      case "tool_call": {
        const argumentsText = JSON.stringify(item.input);
        if (argumentsText === undefined) {
          throw new StrongCodeError("VALIDATION_ERROR", `Tool call '${item.callId}' input is not JSON serializable`);
        }
        const toolCall = {
          id: item.callId,
          type: "function" as const,
          function: { name: item.name, arguments: argumentsText }
        };
        const previous = chatMessages[chatMessages.length - 1];
        if (previous?.role === "assistant") {
          chatMessages[chatMessages.length - 1] = {
            ...previous,
            tool_calls: [...(previous.tool_calls ?? []), toolCall]
          };
        } else {
          chatMessages.push({ role: "assistant", content: null, tool_calls: [toolCall] });
        }
        break;
      }
      case "tool_result":
        chatMessages.push({ role: "tool", tool_call_id: item.callId, content: item.content });
        break;
    }
  }

  const promptContent = request.prompt.trim();
  if (promptContent.length > 0 && !chatMessages.some(message => message.role === "user" && message.content === promptContent)) {
    chatMessages.push({ role: "user", content: promptContent });
  }

  if (chatMessages.length === 0) {
    chatMessages.push({ role: "user", content: request.prompt });
  }

  return request.systemPrompt
    ? [{ role: "system", content: request.systemPrompt }, ...chatMessages]
    : chatMessages;
}

function redactSensitive(value: string, apiKey: string): string {
  let redacted = value;
  if (apiKey.length > 0) {
    redacted = redacted.split(apiKey).join("[redacted]");
  }

  return redacted
    .replace(/(^|[^A-Za-z0-9_-])(authorization[ \t]*[:=][ \t]*)[^ \t\r\n,;}'"]+[ \t]+[^ \t\r\n,;}'"]+/gi, "$1$2[redacted]")
    .replace(/(^|[^A-Za-z0-9_-])(authorization[ \t]*[:=][ \t]*)[^ \t\r\n,;}'"]+/gi, "$1$2[redacted]")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/((?:api[-_]?key|x-api-key)\s*[:=]\s*)[^\s,;}]+/gi, "$1[redacted]");
}

function formatProviderError(response: OpenAICompatibleFetchResponse, responseText: string, apiKey: string): string {
  const detail = parseOpenAICompatibleErrorDetails(responseText).join("; ");
  if (detail.length > 0) return redactSensitive(detail, apiKey);

  return response.statusText ? redactSensitive(response.statusText, apiKey) : "request failed";
}

export class OpenAICompatibleModelProvider implements ModelProvider {
  readonly name: string;
  private readonly fetcher: OpenAICompatibleFetcher;

  constructor(private readonly options: OpenAICompatibleProviderOptions) {
    this.name = options.providerId;
    this.fetcher = options.fetcher ?? globalOpenAICompatibleFetchTransport();
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    request.signal?.throwIfAborted();
    const messages = toChatMessages(request, modelRequestItems(request));
    const credentials = await resolveProviderCredentials(this.options.providerId, this.options.providerConfig, {
      authStore: this.options.authStore,
      allowEnvironmentCredentials: this.options.allowEnvironmentCredentials
    });
    request.signal?.throwIfAborted();
    const url = completionUrl(this.options.providerId, this.options.providerConfig);
    const body = JSON.stringify({
      model: this.options.modelConfig.model ?? this.options.modelId,
      messages,
      ...(this.options.providerConfig.type === "openai" && supportsOpenAIPromptCaching(url)
        ? { prompt_cache_key: promptCacheKey(request.sessionId) }
        : {}),
      ...(request.tools.length > 0 ? {
        tools: (request.toolDefinitions ?? request.tools.map(name => ({
          name,
          description: `StrongCode tool: ${name}`,
          inputSchema: { type: "object", additionalProperties: true }
        }))).map(tool => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema
          }
        }))
      } : {})
    });

    let response: OpenAICompatibleFetchResponse;
    try {
      response = await this.fetcher(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(credentials.type === "api" ? { Authorization: `Bearer ${credentials.apiKey}` } : {}),
        },
        body,
        ...(request.signal ? { signal: request.signal } : {})
      });
      request.signal?.throwIfAborted();
    } catch (error) {
      if (request.signal?.aborted) throw request.signal.reason;
      if (error instanceof StrongCodeError) {
        throw error;
      }

      const message = error instanceof Error ? redactSensitive(error.message, credentials.secret) : "request failed";
      throw new StrongCodeError("MODEL_ERROR", `Provider ${this.options.providerId} completion request failed: ${message}`);
    }

    let responseText: string;
    const responseTooLarge = new StrongCodeError("MODEL_ERROR", "Model completion response exceeded 10 MB");
    try {
      const declaredLength = response.headers?.get("content-length");
      if (declaredLength !== undefined
        && declaredLength !== null
        && Number.parseInt(declaredLength, 10) > MAX_COMPLETION_RESPONSE_BYTES) {
        throw responseTooLarge;
      }

      const sourceReader = response.body?.getReader();
      let streamedBytes = 0;
      const boundedBody = sourceReader ? new ReadableStream<Uint8Array>({
        async pull(controller): Promise<void> {
          const chunk = await sourceReader.read();
          if (chunk.done) {
            controller.close();
            return;
          }
          streamedBytes += chunk.value.byteLength;
          if (streamedBytes > MAX_COMPLETION_RESPONSE_BYTES) {
            try {
              await sourceReader.cancel();
            } catch {
              throw responseTooLarge;
            }
            controller.error(responseTooLarge);
            return;
          }
          controller.enqueue(chunk.value);
        },
        cancel(reason): Promise<void> {
          return sourceReader.cancel(reason);
        }
      }) : undefined;
      const locallyBoundedResponse: ProviderResponseBody = {
        ...(boundedBody ? { body: boundedBody } : {}),
        async text(): Promise<string> {
          const text = await response.text();
          if (new TextEncoder().encode(text).byteLength > MAX_COMPLETION_RESPONSE_BYTES) {
            throw responseTooLarge;
          }
          return text;
        }
      };
      responseText = await readBoundedResponseText(locallyBoundedResponse);
      request.signal?.throwIfAborted();
    } catch (error) {
      if (request.signal?.aborted) throw request.signal.reason;
      if (error === responseTooLarge) throw responseTooLarge;
      const code = error instanceof StrongCodeError ? error.code : "MODEL_ERROR";
      throw new StrongCodeError(code, `Provider ${this.options.providerId} completion response body read failed`);
    }
    if (!response.ok) {
      const detail = formatProviderError(response, responseText, credentials.secret);
      throw new StrongCodeError("MODEL_ERROR", `Provider ${this.options.providerId} completion failed with HTTP ${response.status}: ${detail}`);
    }

    return parseOpenAICompatibleResponse(responseText, response.headers?.get("x-request-id") ?? undefined);
  }
}
