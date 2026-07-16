import type { ProviderConfig } from "../config/schema";
import { StrongCodeError, type StrongCodeErrorCode } from "../core/errors";
import type { ProviderAuthReader } from "../models/auth-store";
import { resolveProviderCredentials } from "../models/credentials";
import { readBoundedResponseText, type ProviderResponseBody } from "../models/response-body";
import {
  buildDeepSeekSimplificationBody,
  parseDeepSeekSimplificationResponse
} from "./simplifier-protocol";
import type { QuestionRequest } from "./schema";

const DEEPSEEK_PROVIDER_ID = "deepseek";
const DEEPSEEK_ORIGIN = "https://api.deepseek.com";
const DEEPSEEK_COMPLETIONS_URL = `${DEEPSEEK_ORIGIN}/chat/completions`;
const MAX_RESPONSE_BYTES = 128 * 1024;

export type QuestionSimplifierErrorKind =
  | "configuration"
  | "authentication"
  | "request"
  | "response"
  | "cancelled";

const ERROR_CODES = {
  configuration: "CONFIG_ERROR",
  authentication: "CONFIG_ERROR",
  request: "MODEL_ERROR",
  response: "MODEL_ERROR",
  cancelled: "MODEL_ERROR"
} as const satisfies Record<QuestionSimplifierErrorKind, StrongCodeErrorCode>;

export class QuestionSimplifierError extends StrongCodeError {
  readonly name = "QuestionSimplifierError";

  constructor(readonly kind: QuestionSimplifierErrorKind, message: string) {
    super(ERROR_CODES[kind], message);
  }
}

export interface QuestionSimplifierFetchResponse extends ProviderResponseBody {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText?: string;
}

export interface QuestionSimplifierFetchInit {
  readonly method: "POST";
  readonly redirect: "error";
  readonly signal: AbortSignal;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export type QuestionSimplifierFetch = (
  url: string,
  init: QuestionSimplifierFetchInit
) => Promise<QuestionSimplifierFetchResponse>;

export interface DeepSeekQuestionSimplifierOptions {
  readonly providerId: string;
  readonly providerConfig: ProviderConfig;
  readonly authStore?: ProviderAuthReader;
  readonly allowEnvironmentCredentials?: boolean;
  readonly fetcher?: QuestionSimplifierFetch;
}

function globalFetchTransport(): QuestionSimplifierFetch {
  return async (url, init) => {
    if (typeof fetch !== "function") {
      throw new QuestionSimplifierError("request", "Question simplification is unavailable because HTTP fetch is not supported");
    }
    return fetch(url, init);
  };
}

function validateProvider(options: DeepSeekQuestionSimplifierOptions): ProviderConfig {
  const provider = options.providerConfig;
  if (options.providerId !== DEEPSEEK_PROVIDER_ID) {
    throw new QuestionSimplifierError("configuration", "Question simplification requires the configured DeepSeek provider");
  }
  if (provider.enabled !== true) {
    throw new QuestionSimplifierError("configuration", "Enable the DeepSeek provider before simplifying questions");
  }
  if (provider.type !== "openai-compatible") {
    throw new QuestionSimplifierError("configuration", "The DeepSeek provider must use the openai-compatible type");
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(provider.baseUrl ?? "");
  } catch (error) {
    if (error instanceof TypeError) {
      throw new QuestionSimplifierError("configuration", "The DeepSeek provider URL must be exactly https://api.deepseek.com");
    }
    throw error;
  }
  if (
    baseUrl.origin !== DEEPSEEK_ORIGIN || baseUrl.pathname !== "/"
    || baseUrl.username !== "" || baseUrl.password !== "" || baseUrl.port !== ""
    || baseUrl.search !== "" || baseUrl.hash !== ""
  ) {
    throw new QuestionSimplifierError("configuration", "The DeepSeek provider URL must be exactly https://api.deepseek.com");
  }
  return provider;
}

export class DeepSeekQuestionSimplifier {
  private readonly fetcher: QuestionSimplifierFetch;

  constructor(private readonly options: DeepSeekQuestionSimplifierOptions) {
    this.fetcher = options.fetcher ?? globalFetchTransport();
  }

  async simplify(original: QuestionRequest, signal: AbortSignal): Promise<QuestionRequest> {
    const provider = validateProvider(this.options);
    if (signal.aborted) {
      throw new QuestionSimplifierError("cancelled", "Question simplification was cancelled");
    }

    let apiKey: string;
    try {
      const credentials = await resolveProviderCredentials(DEEPSEEK_PROVIDER_ID, provider, {
        authStore: this.options.authStore,
        allowEnvironmentCredentials: this.options.allowEnvironmentCredentials === true
      });
      if (credentials.type !== "api") {
        throw new QuestionSimplifierError("authentication", "Connect a DeepSeek API key before simplifying questions");
      }
      apiKey = credentials.apiKey;
    } catch (error) {
      if (error instanceof QuestionSimplifierError) throw error;
      if (error instanceof StrongCodeError) {
        throw new QuestionSimplifierError("authentication", error.message);
      }
      throw new QuestionSimplifierError("authentication", "Could not read the DeepSeek API credential");
    }
    if (signal.aborted) {
      throw new QuestionSimplifierError("cancelled", "Question simplification was cancelled");
    }

    let response: QuestionSimplifierFetchResponse;
    try {
      response = await this.fetcher(DEEPSEEK_COMPLETIONS_URL, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: buildDeepSeekSimplificationBody(original)
      });
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        throw new QuestionSimplifierError("cancelled", "Question simplification was cancelled");
      }
      if (error instanceof QuestionSimplifierError) throw error;
      throw new QuestionSimplifierError("request", "DeepSeek could not simplify the questions");
    }

    let responseText: string;
    try {
      responseText = await readBoundedResponseText(response, {
        maxBytes: MAX_RESPONSE_BYTES,
        tooLargeMessage: "DeepSeek simplification response exceeded 128 KB"
      });
    } catch (error) {
      if (signal.aborted) {
        throw new QuestionSimplifierError("cancelled", "Question simplification was cancelled");
      }
      if (error instanceof StrongCodeError) {
        throw new QuestionSimplifierError("response", error.message);
      }
      throw new QuestionSimplifierError("response", "DeepSeek returned an unreadable simplification response");
    }
    if (!response.ok) {
      throw new QuestionSimplifierError("request", `DeepSeek simplification failed with HTTP ${response.status}`);
    }
    try {
      return parseDeepSeekSimplificationResponse(original, responseText);
    } catch (error) {
      if (error instanceof StrongCodeError) {
        throw new QuestionSimplifierError("response", error.message);
      }
      throw error;
    }
  }
}
