import { StrongCodeError } from "../core/errors";
import type { ModelConfig, ProviderConfig } from "../config/schema";
import type { OAuthProviderAuth, ProviderAuthReader } from "./auth-store";
import { CHATGPT_CODEX_ENDPOINT, refreshChatGptAccessToken, type ChatGptOAuthFetch } from "./chatgpt-oauth";
import { modelRequestItems, type ModelProvider, type ModelRequest, type ModelResponse, type ModelToolDefinition } from "./provider";
import { readBoundedResponseText } from "./response-body";
import { parseChatGptResponse } from "./chatgpt-response";

export interface ChatGptProviderOptions {
  providerId: string;
  providerConfig: ProviderConfig;
  modelId: string;
  modelConfig: ModelConfig;
  authStore?: ProviderAuthReader;
  fetcher?: ChatGptOAuthFetch;
  timeoutMs?: number;
}

interface WritableAuthReader extends ProviderAuthReader {
  set(providerId: string, auth: OAuthProviderAuth): Promise<void>;
}

function writable(store: ProviderAuthReader | undefined): store is WritableAuthReader {
  return Boolean(store && "set" in store && typeof store.set === "function");
}

function safeSessionKey(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._:-]+/g, "-").slice(0, 128);
  return sanitized || "strongcode-session";
}

function safeAccountId(value: string | undefined): string | undefined {
  return value && /^[\x21-\x7e]{1,512}$/.test(value) ? value : undefined;
}

type ResponseInputItem =
  | {
    readonly role: "user" | "assistant";
    readonly content: readonly { readonly type: "input_text" | "output_text"; readonly text: string }[];
  }
  | { readonly type: "function_call"; readonly call_id: string; readonly name: string; readonly arguments: string }
  | { readonly type: "function_call_output"; readonly call_id: string; readonly output: string };

function responseInput(request: ModelRequest): ResponseInputItem[] {
  const result: ResponseInputItem[] = [];
  for (const item of modelRequestItems(request)) {
    switch (item.type) {
      case "text": {
        if (item.role === "tool") {
          throw new StrongCodeError("VALIDATION_ERROR", "Flat tool text requires a correlated tool_result item");
        }
        const content = item.content.trim();
        if (content.length === 0) break;
        if (item.role === "assistant") {
          result.push({ role: "assistant", content: [{ type: "output_text", text: content }] });
        } else {
          result.push({ role: "user", content: [{ type: "input_text", text: content }] });
        }
        break;
      }
      case "tool_call": {
        const argumentsText = JSON.stringify(item.input);
        if (argumentsText === undefined) {
          throw new StrongCodeError("VALIDATION_ERROR", `Tool call '${item.callId}' input is not JSON serializable`);
        }
        result.push({ type: "function_call", call_id: item.callId, name: item.name, arguments: argumentsText });
        break;
      }
      case "tool_result":
        result.push({ type: "function_call_output", call_id: item.callId, output: item.content });
        break;
    }
  }
  const trimmedPrompt = request.prompt.trim();
  const hasPrompt = result.some(item => "role" in item && item.role === "user"
    && item.content.some(part => part.text === trimmedPrompt));
  if (trimmedPrompt && !hasPrompt) result.push({ role: "user", content: [{ type: "input_text", text: trimmedPrompt }] });
  if (result.length === 0) result.push({ role: "user", content: [{ type: "input_text", text: request.prompt }] });
  return result;
}

function responseTools(request: ModelRequest): Array<Record<string, unknown>> {
  const definitions: ModelToolDefinition[] = request.toolDefinitions
    ?? request.tools.map(name => ({
      name,
      description: `StrongCode tool: ${name}`,
      inputSchema: { type: "object", additionalProperties: true }
    }));
  return definitions.map(tool => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false
  }));
}

function requestBody(request: ModelRequest, model: string): string {
  const tools = request.tools.length > 0 ? responseTools(request) : [];
  return JSON.stringify({
    model,
    input: responseInput(request),
    ...(request.systemPrompt ? { instructions: request.systemPrompt } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    store: false,
    stream: true,
    prompt_cache_key: safeSessionKey(request.sessionId),
    include: ["reasoning.encrypted_content"],
    reasoning: { effort: "medium", summary: "auto" },
    text: { verbosity: "medium" }
  });
}

function redact(value: string, auth: OAuthProviderAuth): string {
  let result = value;
  for (const secret of [auth.access, auth.refresh]) {
    if (secret) result = result.split(secret).join("[redacted]");
  }
  return result.replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]");
}

export class ChatGptModelProvider implements ModelProvider {
  readonly name: string;
  private refreshPromise?: Promise<OAuthProviderAuth>;

  constructor(private readonly options: ChatGptProviderOptions) {
    this.name = options.providerId;
  }

  private async auth(forceRefresh = false): Promise<OAuthProviderAuth> {
    const stored = await this.options.authStore?.get(this.options.providerId);
    if (stored?.type !== "oauth") throw new StrongCodeError("CONFIG_ERROR", "ChatGPT is not connected; run strongcode setup --force and choose browser or headless login");
    if (!forceRefresh && (!stored.expires || stored.expires > Date.now() + 60_000)) return stored;
    if (!this.refreshPromise) {
      this.refreshPromise = refreshChatGptAccessToken(stored, { fetcher: this.options.fetcher })
        .then(async refreshed => {
          if (writable(this.options.authStore)) await this.options.authStore.set(this.options.providerId, refreshed);
          return refreshed;
        })
        .finally(() => { this.refreshPromise = undefined; });
    }
    return this.refreshPromise;
  }

  private async request(request: ModelRequest, auth: OAuthProviderAuth, body: string): Promise<{ response: Response; text: string }> {
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = (): void => controller.abort(request.signal?.reason);
    if (request.signal?.aborted) abortFromCaller();
    else request.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.timeoutMs ?? 10 * 60_000);
    const accountId = safeAccountId(auth.accountId);
    try {
      controller.signal.throwIfAborted();
      const response = await (this.options.fetcher ?? fetch)(CHATGPT_CODEX_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${auth.access}`,
          ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
          originator: "strongcode",
          "User-Agent": "strongcode/0.1.0"
        },
        body,
        redirect: "error",
        signal: controller.signal
      });
      controller.signal.throwIfAborted();
      const text = await readBoundedResponseText(response);
      controller.signal.throwIfAborted();
      return { response, text };
    } catch (error) {
      if (request.signal?.aborted) throw request.signal.reason;
      if (timedOut) throw new StrongCodeError("MODEL_ERROR", "ChatGPT request timed out");
      if (error instanceof StrongCodeError) throw error;
      throw new StrongCodeError("MODEL_ERROR", `ChatGPT request failed: ${redact(error instanceof Error ? error.message : String(error), auth)}`);
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    request.signal?.throwIfAborted();
    const body = requestBody(request, this.options.modelConfig.model ?? this.options.modelId);
    let auth = await this.auth();
    request.signal?.throwIfAborted();
    let result = await this.request(request, auth, body);
    if (result.response.status === 401 && auth.refresh) {
      request.signal?.throwIfAborted();
      auth = await this.auth(true);
      request.signal?.throwIfAborted();
      result = await this.request(request, auth, body);
    }
    const { response, text } = result;
    if (!response.ok) {
      const detail = redact(text.slice(0, 2_000), auth).replace(/\s+/g, " ").trim() || response.statusText || "request failed";
      throw new StrongCodeError("MODEL_ERROR", `ChatGPT completion failed with HTTP ${response.status}: ${detail}`);
    }
    try {
      return parseChatGptResponse(text, response.headers.get("content-type"), response.headers.get("x-request-id") ?? undefined);
    } catch (error) {
      if (error instanceof StrongCodeError) throw new StrongCodeError(error.code, redact(error.message, auth));
      throw error;
    }
  }
}
