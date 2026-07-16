import { StrongCodeError } from "../core/errors";
import { validateConversationItems, type ConversationItem } from "../core/types";
import { BoundedResponseBodyError, type ProviderResponseBody } from "./response-body";

export interface NativeProviderFetchResponse extends ProviderResponseBody {
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
}

export type NativeProviderFetcher = (url: string, init: {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}) => Promise<NativeProviderFetchResponse>;

export function nativeProviderRequestError(providerId: string): StrongCodeError {
  return new StrongCodeError("MODEL_ERROR", `Provider ${providerId} completion request failed`);
}

export function nativeProviderResponseError(providerId: string, error: unknown): StrongCodeError {
  if (error instanceof BoundedResponseBodyError) return error;
  const code = error instanceof StrongCodeError ? error.code : "MODEL_ERROR";
  return new StrongCodeError(code, `Provider ${providerId} completion response failed`);
}

export function globalNativeProviderFetchTransport(): NativeProviderFetcher {
  return async (url, init) => {
    if (typeof fetch !== "function") {
      throw new StrongCodeError("MODEL_ERROR", "Global fetch is not available for model completions");
    }

    return fetch(url, init);
  };
}

export function parseJson(text: string): unknown {
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function stringifyNativeProviderBody(value: unknown, providerName: string): string {
  try {
    const body = JSON.stringify(value);
    if (body === undefined) throw new StrongCodeError("VALIDATION_ERROR", `${providerName} request body is not JSON serializable`);
    return body;
  } catch (error) {
    if (error instanceof StrongCodeError) throw error;
    throw new StrongCodeError("VALIDATION_ERROR", `${providerName} request body is not JSON serializable`);
  }
}

export function validateNativeResponseItems(providerName: string, items: readonly ConversationItem[]): ConversationItem[] {
  try {
    return validateConversationItems(items);
  } catch (error) {
    if (error instanceof StrongCodeError) {
      throw new StrongCodeError("MODEL_ERROR", `${providerName} completion returned invalid tool correlation: ${error.message}`);
    }
    throw error;
  }
}

export function redactProviderSecret(value: string, secret: string): string {
  let redacted = value;
  if (secret.length > 0) redacted = redacted.split(secret).join("[redacted]");
  return redacted
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/((?:authorization|api[-_]?key|x-api-key|x-goog-api-key)\s*[:=]\s*)[^\s,;}]+/gi, "$1[redacted]");
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function formatNativeProviderError(response: NativeProviderFetchResponse, responseText: string, secret: string): string {
  const payload = parseJson(responseText);
  if (payload && typeof payload === "object") {
    const nested = (payload as { error?: unknown }).error;
    if (typeof nested === "string" && nested.length > 0) return redactProviderSecret(nested, secret);
    if (nested && typeof nested === "object") {
      const detail = [
        nonEmptyString((nested as { type?: unknown }).type),
        nonEmptyString((nested as { status?: unknown }).status),
        nonEmptyString((nested as { message?: unknown }).message),
        nonEmptyString((nested as { code?: unknown }).code)
      ].filter((part): part is string => Boolean(part)).join("; ");
      if (detail.length > 0) return redactProviderSecret(detail, secret);
    }

    const message = nonEmptyString((payload as { message?: unknown }).message);
    if (message) return redactProviderSecret(message, secret);
  }

  return response.statusText ? redactProviderSecret(response.statusText, secret) : "request failed";
}

export function modelMaxTokens(options: Record<string, unknown> | undefined): number {
  const configured = options?.maxTokens ?? options?.max_tokens;
  return typeof configured === "number" && Number.isSafeInteger(configured) && configured > 0 ? configured : 4096;
}
