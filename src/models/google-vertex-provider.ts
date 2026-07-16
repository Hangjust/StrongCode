import type { ModelConfig, ProviderConfig } from "../config/schema";
import { StrongCodeError } from "../core/errors";
import type { ProviderAuthReader } from "./auth-store";
import { getGoogleAdcAccessToken } from "./gcloud-delegated";
import { geminiModelId, parseGeminiResponse, toGeminiContents, toGeminiFunctionDeclarations } from "./google-provider";
import {
  formatNativeProviderError,
  globalNativeProviderFetchTransport,
  nativeProviderRequestError,
  nativeProviderResponseError,
  NativeProviderFetcher,
  stringifyNativeProviderBody
} from "./native-provider-utils";
import type { ModelProvider, ModelRequest, ModelResponse } from "./provider";
import { parseProviderBaseUrl } from "./provider-url";
import { readBoundedResponseText } from "./response-body";

interface GoogleVertexProviderOptions {
  providerId: string;
  providerConfig: ProviderConfig;
  modelId: string;
  modelConfig: ModelConfig;
  fetcher?: NativeProviderFetcher;
  authStore?: ProviderAuthReader;
}

function safeSegment(value: string | undefined, field: string): string {
  if (!value || !/^[A-Za-z0-9._-]+$/.test(value)) throw new StrongCodeError("CONFIG_ERROR", `Google Vertex ${field} is missing or invalid`);
  return value;
}

export class GoogleVertexModelProvider implements ModelProvider {
  readonly name: string;
  private readonly fetcher: NativeProviderFetcher;

  constructor(private readonly options: GoogleVertexProviderOptions) {
    this.name = options.providerId;
    this.fetcher = options.fetcher ?? globalNativeProviderFetchTransport();
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    request.signal?.throwIfAborted();
    const project = safeSegment(this.options.providerConfig.projectId, "project ID");
    const location = safeSegment(this.options.providerConfig.location, "location");
    const model = geminiModelId(this.options.modelConfig.model ?? this.options.modelId);
    const baseUrl = this.options.providerConfig.baseUrl ?? `https://${location}-aiplatform.googleapis.com`;
    const parsedBaseUrl = parseProviderBaseUrl(baseUrl, "Google Vertex AI");
    const allowedHosts = new Set(["aiplatform.googleapis.com", `${location}-aiplatform.googleapis.com`]);
    if (parsedBaseUrl.protocol !== "https:" || parsedBaseUrl.port !== "" || !allowedHosts.has(parsedBaseUrl.hostname)) {
      throw new StrongCodeError("CONFIG_ERROR", "Google Vertex baseUrl must use the configured regional or global aiplatform.googleapis.com endpoint");
    }
    const accessToken = await getGoogleAdcAccessToken();
    request.signal?.throwIfAborted();
    const url = new URL(`/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`, baseUrl).toString();
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
    }, "Google Vertex");
    let response;
    try {
      response = await this.fetcher(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
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
      throw new StrongCodeError("MODEL_ERROR", `Provider ${this.options.providerId} completion failed with HTTP ${response.status}: ${formatNativeProviderError(response, responseText, accessToken)}`);
    }
    return parseGeminiResponse(responseText, "google-vertex-ai", response.headers?.get("x-request-id") ?? undefined);
  }
}
