import type { ModelConfig, ProviderConfig } from "../config/schema";
import { StrongCodeError } from "../core/errors";
import type { ConversationItem, ToolCall } from "../core/types";
import type { ProviderAuthReader } from "./auth-store";
import { resolveProviderCredentials } from "./credentials";
import {
  formatNativeProviderError,
  globalNativeProviderFetchTransport,
  nativeProviderRequestError,
  nativeProviderResponseError,
  NativeProviderFetcher,
  parseJson,
  stringifyNativeProviderBody,
  validateNativeResponseItems
} from "./native-provider-utils";
import { modelRequestItems, type ModelProvider, type ModelRequest, type ModelResponse, type ModelToolDefinition } from "./provider";
import { parseGoogleReportedUsage } from "./native-provider-usage";
import { parseExternalRecord, parseProviderRequestId, parseProviderResponseId } from "./provider-usage";
import { buildProviderUrl } from "./provider-url";
import { readBoundedResponseText } from "./response-body";

interface GoogleProviderOptions {
  providerId: string;
  providerConfig: ProviderConfig;
  modelId: string;
  modelConfig: ModelConfig;
  fetcher?: NativeProviderFetcher;
  authStore?: ProviderAuthReader;
  allowEnvironmentCredentials?: boolean;
}

export interface GeminiContent {
  readonly role: "user" | "model";
  readonly parts: readonly GeminiPart[];
}

type GeminiPart =
  | { readonly text: string }
  | { readonly functionCall: { readonly id: string; readonly name: string; readonly args: unknown } }
  | {
      readonly functionResponse: {
        readonly id: string;
        readonly name: string;
        readonly response: { readonly output: string; readonly isError: boolean };
      };
    };

function containsGeminiUserText(contents: readonly GeminiContent[], text: string): boolean {
  return contents.some(content => content.role === "user" && content.parts.some(part => "text" in part && part.text === text));
}

function appendGeminiPart(contents: GeminiContent[], role: GeminiContent["role"], part: GeminiPart): void {
  const previous = contents[contents.length - 1];
  if (previous?.role !== role) {
    contents.push({ role, parts: [part] });
    return;
  }
  contents[contents.length - 1] = { role, parts: [...previous.parts, part] };
}

export function toGeminiContents(request: ModelRequest): GeminiContent[] {
  const converted: GeminiContent[] = [];
  const callNames = new Map<string, string>();
  for (const item of modelRequestItems(request)) {
    switch (item.type) {
      case "text": {
        if (item.role === "tool") {
          throw new StrongCodeError("VALIDATION_ERROR", "Google Gemini tool output must use a correlated tool_result item");
        }
        const text = item.content.trim();
        if (text.length > 0) converted.push({ role: item.role === "assistant" ? "model" : "user", parts: [{ text }] });
        break;
      }
      case "tool_call":
        callNames.set(item.callId, item.name);
        appendGeminiPart(converted, "model", {
          functionCall: { id: item.callId, name: item.name, args: item.input }
        });
        break;
      case "tool_result": {
        const name = callNames.get(item.callId);
        if (!name) throw new StrongCodeError("VALIDATION_ERROR", `Tool result '${item.callId}' has no correlated function name`);
        appendGeminiPart(converted, "user", {
          functionResponse: {
            id: item.callId,
            name,
            response: { output: item.content, isError: item.isError }
          }
        });
        break;
      }
    }
  }
  const current = request.prompt.trim();
  if (current.length > 0 && !containsGeminiUserText(converted, current)) {
    converted.push({ role: "user", parts: [{ text: current }] });
  }
  return converted.length > 0 ? converted : [{ role: "user", parts: [{ text: request.prompt }] }];
}

export function geminiModelId(modelId: string): string {
  const normalized = modelId.startsWith("models/") ? modelId.slice("models/".length) : modelId;
  if (normalized.length === 0) throw new StrongCodeError("CONFIG_ERROR", "Google Gemini model id must not be empty");
  return normalized;
}

/**
 * Gemini exposes separate fields for its restricted OpenAPI Schema dialect and
 * for JSON Schema. StrongCode tools are described with JSON Schema, so sending
 * them through `parameters` makes valid keywords such as
 * `additionalProperties` fail protobuf decoding before the model is called.
 */
export function toGeminiFunctionDeclarations(tools: ModelToolDefinition[]) {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: tool.inputSchema
  }));
}

export function parseGeminiResponse(text: string, provider: "gemini-developer-api" | "google-vertex-ai", headerRequestId?: string): ModelResponse {
  const payload = parseExternalRecord(parseJson(text));
  const candidates = payload?.candidates;
  const first = Array.isArray(candidates) ? candidates[0] : undefined;
  const content = parseExternalRecord(first)?.content;
  const parts = parseExternalRecord(content)?.parts;
  if (!Array.isArray(parts)) {
    throw new StrongCodeError("MODEL_ERROR", "Google Gemini completion response must include candidates[0].content.parts");
  }

  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  const items: ConversationItem[] = [];
  for (const source of parts) {
    const part = parseExternalRecord(source);
    if (!part) continue;
    if (typeof part.text === "string") {
      if (part.thought === true) {
        reasoningParts.push(part.text);
      } else {
        textParts.push(part.text);
        items.push({ type: "text", role: "assistant", content: part.text });
      }
    }
    if ("functionCall" in part) {
      const functionCall = parseExternalRecord(part.functionCall);
      if (!functionCall || typeof functionCall.id !== "string" || functionCall.id.trim().length === 0) {
        throw new StrongCodeError("MODEL_ERROR", "Google Gemini functionCall is missing an ID");
      }
      if (typeof functionCall.name !== "string" || functionCall.name.length === 0) {
        throw new StrongCodeError("MODEL_ERROR", `Google Gemini functionCall '${functionCall.id}' is missing a name`);
      }
      const input = "args" in functionCall ? functionCall.args : {};
      toolCalls.push({ callId: functionCall.id, name: functionCall.name, input });
      items.push({ type: "tool_call", role: "assistant", callId: functionCall.id, name: functionCall.name, input });
    }
  }
  const reportedUsage = parseGoogleReportedUsage(payload?.usageMetadata, provider);
  const providerRequestId = parseProviderRequestId(headerRequestId);
  const providerResponseId = parseProviderResponseId(payload?.responseId);
  const reasoning = reasoningParts.join("");
  return {
    message: textParts.join(""),
    ...(reasoning.trim().length > 0 ? { reasoning } : {}),
    toolCalls,
    items: validateNativeResponseItems("Google Gemini", items),
    ...(reportedUsage?.usage ? { usage: reportedUsage.usage } : {}),
    ...(reportedUsage ? { providerUsage: reportedUsage.providerUsage } : {}),
    ...(providerRequestId ? { providerRequestId } : {}),
    ...(providerResponseId ? { providerResponseId } : {})
  };
}

export class GoogleGeminiModelProvider implements ModelProvider {
  readonly name: string;
  private readonly fetcher: NativeProviderFetcher;

  constructor(private readonly options: GoogleProviderOptions) {
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

    const model = geminiModelId(this.options.modelConfig.model ?? this.options.modelId);
    const url = buildProviderUrl(this.options.providerConfig.baseUrl, `/models/${encodeURIComponent(model)}:generateContent`, "Google Gemini generateContent");
    const body = stringifyNativeProviderBody({
      contents: toGeminiContents(request),
      ...(request.systemPrompt ? { systemInstruction: { parts: [{ text: request.systemPrompt }] } } : {}),
      ...(request.tools.length > 0 ? {
        tools: [{
          functionDeclarations: toGeminiFunctionDeclarations(request.toolDefinitions ?? request.tools.map(name => ({
            name,
            description: `StrongCode tool: ${name}`,
            inputSchema: { type: "OBJECT", properties: {} }
          })))
        }]
      } : {})
    }, "Google Gemini");

    let response;
    try {
      response = await this.fetcher(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": credentials.apiKey
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
    return parseGeminiResponse(responseText, "gemini-developer-api", response.headers?.get("x-request-id") ?? undefined);
  }
}
