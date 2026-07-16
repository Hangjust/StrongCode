import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { ProviderAuthStore } from "../src/models/auth-store";
import { createProviderCatalog } from "../src/models/catalog";
import {
  discoverAnthropicModels,
  discoverGoogleModels,
  type DiscoveryFetcher
} from "../src/models/discovery";
import { createModelProvider } from "../src/models/factory";
import { discoverAuthenticatedProviderModels } from "../src/models/model-availability";
import type { OpenAICompatibleFetcher } from "../src/models/openai-compatible-provider";
import { BUILT_IN_PROVIDERS, providerDefaults } from "../src/models/registry";
import { testConfig } from "./helpers";

const googleAdc = vi.hoisted(() => ({
  getAccessToken: vi.fn(async (): Promise<string> => "adc-test-token")
}));

vi.mock("../src/models/gcloud-delegated", () => ({
  getGoogleAdcAccessToken: googleAdc.getAccessToken
}));

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function model(provider: string, modelId: string) {
  return {
    provider,
    model: modelId,
    displayName: modelId,
    enabled: true,
    source: "configured",
    options: undefined
  };
}

describe("native and local provider adapters", () => {
  it("registers vendor and credentialless loopback endpoints without changing legacy order", () => {
    const ids = BUILT_IN_PROVIDERS.map(provider => provider.id);
    expect(ids.slice(0, 4)).toEqual(["openai", "kimi", "anthropic", "grok"]);
    expect(BUILT_IN_PROVIDERS.find(provider => provider.id === "google")).toMatchObject({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      modelsEndpoint: "/models",
      authRequired: true
    });
    expect(BUILT_IN_PROVIDERS.find(provider => provider.id === "deepseek")).toMatchObject({
      baseUrl: "https://api.deepseek.com",
      modelsEndpoint: "/models"
    });
    expect(BUILT_IN_PROVIDERS.find(provider => provider.id === "zhipu")).toMatchObject({
      baseUrl: "https://api.z.ai/api/paas/v4",
      modelsEndpoint: "/models"
    });
    for (const id of ["ollama", "lmstudio", "vllm"]) {
      expect(BUILT_IN_PROVIDERS.find(provider => provider.id === id)).toMatchObject({ authRequired: false });
    }
  });

  it("uses the Anthropic Messages wire format and parses text plus tool calls", async () => {
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "anthropic-test-key";
    const calls: Array<{ url: string; init: Parameters<OpenAICompatibleFetcher>[1] }> = [];
    try {
      const fetcher: OpenAICompatibleFetcher = async (url, init) => {
        calls.push({ url, init });
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              content: [
                { type: "text", text: "Claude response" },
                { type: "tool_use", id: "anthropic-call-1", name: "list_files", input: { path: "." } }
              ]
            });
          }
        };
      };
      const provider = createModelProvider({
        providerId: "anthropic",
        providerConfig: { ...providerDefaults().anthropic, enabled: true },
        modelId: "claude-test",
        modelConfig: model("anthropic", "claude-test"),
        fetcher
      });

      const result = await provider.complete({
        prompt: "hello",
        systemPrompt: "Be precise.",
        sessionId: "test",
        messages: [],
        tools: ["list_files"]
      });

      expect(result).toEqual({
        message: "Claude response",
        toolCalls: [{ callId: "anthropic-call-1", name: "list_files", input: { path: "." } }],
        items: [
          { type: "text", role: "assistant", content: "Claude response" },
          { type: "tool_call", role: "assistant", callId: "anthropic-call-1", name: "list_files", input: { path: "." } }
        ]
      });
      expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
      expect(calls[0].init.headers).toEqual({
        "Content-Type": "application/json",
        "x-api-key": "anthropic-test-key",
        "anthropic-version": "2023-06-01"
      });
      expect(JSON.parse(calls[0].init.body)).toMatchObject({
        model: "claude-test",
        max_tokens: 4096,
        system: "Be precise.",
        messages: [{ role: "user", content: "hello" }]
      });
    } finally {
      restoreEnv("ANTHROPIC_API_KEY", original);
    }
  });

  it("routes explicit Anthropic thinking blocks only to reasoning", async () => {
    // Given: ordered thinking, final text, tool, and opaque thinking metadata blocks.
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "anthropic-test-key";
    try {
      const provider = createModelProvider({
        providerId: "anthropic",
        providerConfig: { ...providerDefaults().anthropic, enabled: true },
        modelId: "claude-test",
        modelConfig: model("anthropic", "claude-test"),
        fetcher: async () => ({
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              id: "anthropic-response-1",
              content: [
                { type: "thinking", thinking: "Inspect inputs. ", signature: "anthropic-signature" },
                { type: "text", text: "First final. " },
                { type: "tool_use", id: "anthropic-call-1", name: "list_files", input: { path: "." } },
                { type: "thinking", thinking: "Check tool output." },
                { type: "redacted_thinking", data: "opaque-redacted-thinking" },
                { type: "text", text: "Second final." }
              ]
            });
          }
        })
      });

      // When: the native Anthropic response is parsed.
      const result = await provider.complete({ prompt: "hello", sessionId: "test", messages: [], tools: ["list_files"] });

      // Then: only explicit thinking text is reasoning, while final text and tools retain provider order.
      expect(result).toEqual({
        message: "First final. Second final.",
        reasoning: "Inspect inputs. Check tool output.",
        toolCalls: [{ callId: "anthropic-call-1", name: "list_files", input: { path: "." } }],
        items: [
          { type: "text", role: "assistant", content: "First final. " },
          { type: "tool_call", role: "assistant", callId: "anthropic-call-1", name: "list_files", input: { path: "." } },
          { type: "text", role: "assistant", content: "Second final." }
        ],
        providerResponseId: "anthropic-response-1"
      });
      expect(JSON.stringify(result)).not.toContain("anthropic-signature");
      expect(JSON.stringify(result)).not.toContain("opaque-redacted-thinking");
    } finally {
      restoreEnv("ANTHROPIC_API_KEY", original);
    }
  });

  it("omits Anthropic reasoning when thinking fragments contain only whitespace", async () => {
    // Given: whitespace-only thinking blocks surrounding final assistant text.
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "anthropic-test-key";
    try {
      const provider = createModelProvider({
        providerId: "anthropic",
        providerConfig: { ...providerDefaults().anthropic, enabled: true },
        modelId: "claude-test",
        modelConfig: model("anthropic", "claude-test"),
        fetcher: async () => ({
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              content: [
                { type: "thinking", thinking: " \n" },
                { type: "text", text: "Final answer" },
                { type: "thinking", thinking: "\t" }
              ]
            });
          }
        })
      });

      // When: the native Anthropic response is parsed.
      const result = await provider.complete({ prompt: "hello", sessionId: "test", messages: [], tools: [] });

      // Then: reasoning is absent and final text is unchanged.
      expect(result).toEqual({
        message: "Final answer",
        toolCalls: [],
        items: [{ type: "text", role: "assistant", content: "Final answer" }]
      });
    } finally {
      restoreEnv("ANTHROPIC_API_KEY", original);
    }
  });

  it("uses Gemini generateContent and redacts API keys from provider failures", async () => {
    const original = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "gemini-test-key";
    const calls: Array<{ url: string; init: Parameters<OpenAICompatibleFetcher>[1] }> = [];
    try {
      const provider = createModelProvider({
        providerId: "google",
        providerConfig: { ...providerDefaults().google, enabled: true },
        modelId: "gemini-test",
        modelConfig: model("google", "models/gemini-test"),
        fetcher: async (url, init) => {
          calls.push({ url, init });
          return {
            ok: true,
            status: 200,
            async text() {
              return JSON.stringify({
                candidates: [{ content: { parts: [{ text: "Gemini response" }, { functionCall: { id: "gemini-call-1", name: "list_files", args: { path: "." } } }] } }]
              });
            }
          };
        }
      });

      await expect(provider.complete({
        prompt: "hello",
        systemPrompt: "Be precise.",
        sessionId: "test",
        messages: [],
        tools: ["list_files"],
        toolDefinitions: [{
          name: "list_files",
          description: "List files",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string" },
              options: {
                type: "object",
                properties: { recursive: { type: "boolean" } },
                additionalProperties: false
              }
            },
            additionalProperties: false
          }
        }]
      })).resolves.toEqual({
        message: "Gemini response",
        toolCalls: [{ callId: "gemini-call-1", name: "list_files", input: { path: "." } }],
        items: [
          { type: "text", role: "assistant", content: "Gemini response" },
          { type: "tool_call", role: "assistant", callId: "gemini-call-1", name: "list_files", input: { path: "." } }
        ]
      });
      expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent");
      expect(calls[0].init.headers).toEqual({
        "Content-Type": "application/json",
        "x-goog-api-key": "gemini-test-key"
      });
      expect(JSON.parse(calls[0].init.body)).toMatchObject({
        systemInstruction: { parts: [{ text: "Be precise." }] },
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
        tools: [{
          functionDeclarations: [{
            name: "list_files",
            parametersJsonSchema: {
              type: "object",
              properties: {
                path: { type: "string" },
                options: {
                  type: "object",
                  properties: { recursive: { type: "boolean" } },
                  additionalProperties: false
                }
              },
              additionalProperties: false
            }
          }]
        }]
      });
      expect(JSON.parse(calls[0].init.body).tools[0].functionDeclarations[0]).not.toHaveProperty("parameters");

      const failing = createModelProvider({
        providerId: "google",
        providerConfig: { ...providerDefaults().google, enabled: true },
        modelId: "gemini-test",
        modelConfig: model("google", "gemini-test"),
        fetcher: async () => ({
          ok: false,
          status: 401,
          async text() {
            return JSON.stringify({ error: { status: "UNAUTHENTICATED", message: "x-goog-api-key: gemini-test-key is invalid" } });
          }
        })
      });
      await expect(failing.complete({ prompt: "hello", sessionId: "test", messages: [], tools: [] }))
        .rejects.toThrow(/x-goog-api-key: \[redacted\]/);
      await expect(failing.complete({ prompt: "hello", sessionId: "test", messages: [], tools: [] }))
        .rejects.not.toThrow(/gemini-test-key/);
    } finally {
      restoreEnv("GEMINI_API_KEY", original);
    }
  });

  it("routes Gemini thought parts only to reasoning", async () => {
    // Given: ordered thought text, final text, a function call, and opaque thought signatures.
    const original = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "gemini-test-key";
    try {
      const provider = createModelProvider({
        providerId: "google",
        providerConfig: { ...providerDefaults().google, enabled: true },
        modelId: "gemini-test",
        modelConfig: model("google", "gemini-test"),
        fetcher: async () => ({
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              responseId: "gemini-response-1",
              candidates: [{
                content: {
                  parts: [
                    { text: "Inspect inputs. ", thought: true, thoughtSignature: "gemini-thought-signature-1" },
                    { text: "First final. " },
                    {
                      functionCall: { id: "gemini-call-1", name: "list_files", args: { path: "." } },
                      thoughtSignature: "gemini-tool-signature"
                    },
                    { text: "Check tool output.", thought: true, thoughtSignature: "gemini-thought-signature-2" },
                    { text: "Second final.", thoughtSignature: "gemini-final-signature" }
                  ]
                }
              }]
            });
          }
        })
      });

      // When: the native Gemini response is parsed.
      const result = await provider.complete({ prompt: "hello", sessionId: "test", messages: [], tools: ["list_files"] });

      // Then: thought text is reasoning-only and signatures never enter the normalized response.
      expect(result).toEqual({
        message: "First final. Second final.",
        reasoning: "Inspect inputs. Check tool output.",
        toolCalls: [{ callId: "gemini-call-1", name: "list_files", input: { path: "." } }],
        items: [
          { type: "text", role: "assistant", content: "First final. " },
          { type: "tool_call", role: "assistant", callId: "gemini-call-1", name: "list_files", input: { path: "." } },
          { type: "text", role: "assistant", content: "Second final." }
        ],
        providerResponseId: "gemini-response-1"
      });
      expect(JSON.stringify(result)).not.toContain("gemini-thought-signature");
      expect(JSON.stringify(result)).not.toContain("gemini-tool-signature");
      expect(JSON.stringify(result)).not.toContain("gemini-final-signature");
    } finally {
      restoreEnv("GEMINI_API_KEY", original);
    }
  });

  it("omits Gemini reasoning when thought fragments contain only whitespace", async () => {
    // Given: whitespace-only thought parts surrounding final assistant text.
    const original = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "gemini-test-key";
    try {
      const provider = createModelProvider({
        providerId: "google",
        providerConfig: { ...providerDefaults().google, enabled: true },
        modelId: "gemini-test",
        modelConfig: model("google", "gemini-test"),
        fetcher: async () => ({
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              candidates: [{
                content: {
                  parts: [
                    { text: " \n", thought: true },
                    { text: "Final answer" },
                    { text: "\t", thought: true }
                  ]
                }
              }]
            });
          }
        })
      });

      // When: the native Gemini response is parsed.
      const result = await provider.complete({ prompt: "hello", sessionId: "test", messages: [], tools: [] });

      // Then: reasoning is absent and final text is unchanged.
      expect(result).toEqual({
        message: "Final answer",
        toolCalls: [],
        items: [{ type: "text", role: "assistant", content: "Final answer" }]
      });
    } finally {
      restoreEnv("GEMINI_API_KEY", original);
    }
  });

  it("rejects non-Vertex origins before acquiring ADC credentials or making a request", async () => {
    googleAdc.getAccessToken.mockClear();
    const hostileBaseUrls = [
      "https://attacker.example",
      "https://aiplatform.googleapis.com.attacker.example",
      "https://us-central1-aiplatform.googleapis.com.attacker.example",
      "https://aiplatform.googleapis.com@attacker.example",
      "https://aiplatform.googleapis.com:444",
      "https://us-east1-aiplatform.googleapis.com",
      "http://aiplatform.googleapis.com"
    ];
    let fetchCalls = 0;

    for (const baseUrl of hostileBaseUrls) {
      const provider = createModelProvider({
        providerId: "google-vertex",
        providerConfig: {
          ...providerDefaults()["google-vertex"],
          baseUrl,
          projectId: "test-project",
          location: "us-central1",
          enabled: true
        },
        modelId: "gemini-test",
        modelConfig: model("google-vertex", "gemini-test"),
        fetcher: async () => {
          fetchCalls += 1;
          throw new Error("must not fetch");
        }
      });

      await expect(provider.complete({ prompt: "hello", sessionId: "test", messages: [], tools: [] }))
        .rejects.toThrow(/baseUrl|https/i);
    }

    expect(fetchCalls).toBe(0);
    expect(googleAdc.getAccessToken).not.toHaveBeenCalled();
  });

  it("sends ADC credentials only to configured global or matching regional Vertex origins", async () => {
    googleAdc.getAccessToken.mockClear();
    const allowedBaseUrls = [
      "https://aiplatform.googleapis.com",
      "https://us-central1-aiplatform.googleapis.com"
    ];

    for (const baseUrl of allowedBaseUrls) {
      const calls: Array<{ url: string; headers: Record<string, string> }> = [];
      const provider = createModelProvider({
        providerId: "google-vertex",
        providerConfig: {
          ...providerDefaults()["google-vertex"],
          baseUrl,
          projectId: "test-project",
          location: "us-central1",
          enabled: true
        },
        modelId: "gemini-test",
        modelConfig: model("google-vertex", "gemini-test"),
        fetcher: async (url, init) => {
          calls.push({ url, headers: init.headers });
          return {
            ok: true,
            status: 200,
            async text() {
              return JSON.stringify({ candidates: [{ content: { parts: [{ text: "Vertex response" }] } }] });
            }
          };
        }
      });

      await expect(provider.complete({ prompt: "hello", sessionId: "test", messages: [], tools: [] }))
        .resolves.toMatchObject({ message: "Vertex response" });
      expect(calls).toEqual([{
        url: `${baseUrl}/v1/projects/test-project/locations/us-central1/publishers/google/models/gemini-test:generateContent`,
        headers: { "Content-Type": "application/json", Authorization: "Bearer adc-test-token" }
      }]);
    }

    expect(googleAdc.getAccessToken).toHaveBeenCalledTimes(allowedBaseUrls.length);
  });

  it("discovers and normalizes paginated Anthropic and Gemini model lists", async () => {
    const originalAnthropic = process.env.ANTHROPIC_API_KEY;
    const originalGemini = process.env.GEMINI_API_KEY;
    process.env.ANTHROPIC_API_KEY = "anthropic-discovery-key";
    process.env.GEMINI_API_KEY = "gemini-discovery-key";
    try {
      const anthropicUrls: string[] = [];
      const anthropic = await discoverAnthropicModels({ id: "anthropic", ...providerDefaults().anthropic }, async (url, init) => {
        anthropicUrls.push(url);
        expect(init.headers).toEqual({ "x-api-key": "anthropic-discovery-key", "anthropic-version": "2023-06-01" });
        return {
          ok: true,
          status: 200,
          async json() {
            return anthropicUrls.length === 1
              ? { data: [{ id: "claude-a", display_name: "Claude A" }], has_more: true, last_id: "claude-a" }
              : { data: [{ id: "claude-b", display_name: "Claude B" }], has_more: false };
          }
        };
      });
      expect(anthropicUrls).toEqual([
        "https://api.anthropic.com/v1/models",
        "https://api.anthropic.com/v1/models?after_id=claude-a"
      ]);
      expect(anthropic.map(item => [item.id, item.displayName])).toEqual([["claude-a", "Claude A"], ["claude-b", "Claude B"]]);

      const googleUrls: string[] = [];
      const google = await discoverGoogleModels({ id: "google", ...providerDefaults().google }, async (url, init) => {
        googleUrls.push(url);
        expect(init.headers).toEqual({ "x-goog-api-key": "gemini-discovery-key" });
        return {
          ok: true,
          status: 200,
          async json() {
            return googleUrls.length === 1
              ? { models: [{ name: "models/gemini-a", displayName: "Gemini A" }], nextPageToken: "next page" }
              : { models: [{ name: "models/gemini-b", baseModelId: "gemini-b", displayName: "Gemini B" }] };
          }
        };
      });
      expect(googleUrls).toEqual([
        "https://generativelanguage.googleapis.com/v1beta/models",
        "https://generativelanguage.googleapis.com/v1beta/models?pageToken=next+page"
      ]);
      expect(google.map(item => [item.id, item.displayName])).toEqual([["gemini-a", "Gemini A"], ["gemini-b", "Gemini B"]]);
    } finally {
      restoreEnv("ANTHROPIC_API_KEY", originalAnthropic);
      restoreEnv("GEMINI_API_KEY", originalGemini);
    }
  });

  it("runs and discovers explicit local providers without auth, but not arbitrary custom endpoints", async () => {
    const localProvider = { ...providerDefaults().ollama, enabled: true };
    const calls: Array<{ url: string; init: Parameters<OpenAICompatibleFetcher>[1] }> = [];
    const provider = createModelProvider({
      providerId: "ollama",
      providerConfig: localProvider,
      modelId: "llama-local",
      modelConfig: model("ollama", "llama-local"),
      fetcher: async (url, init) => {
        calls.push({ url, init });
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({ choices: [{ message: { content: "local response" } }] });
          }
        };
      }
    });
    await expect(provider.complete({ prompt: "hello", sessionId: "test", messages: [], tools: [] }))
      .resolves.toMatchObject({ message: "local response" });
    expect(calls[0].init.headers).toEqual({ "Content-Type": "application/json" });

    const catalog = createProviderCatalog({
      ...testConfig("."),
      providers: { ollama: localProvider },
      models: { local: model("ollama", "llama-local") },
      agents: { default: { model: "local", tools: [] } }
    });
    expect(catalog.all[0]).toMatchObject({ id: "ollama", authMethods: ["none"], connected: true, runtimeSupport: "supported" });

    const root = await mkdtemp(path.join(tmpdir(), "strongcode-local-discovery-"));
    const authStore = new ProviderAuthStore(root);
    const discoveryCalls: Array<{ url: string; headers: Record<string, string> }> = [];
    const discoveryFetcher: DiscoveryFetcher = async (url, init) => {
      discoveryCalls.push({ url, headers: init.headers });
      return { ok: true, status: 200, async json() { return { data: [{ id: "llama-local" }] }; } };
    };
    const availability = await discoverAuthenticatedProviderModels({
      ...testConfig("."),
      providers: { ollama: localProvider },
      models: {},
      agents: { default: { model: "local", tools: [] } }
    }, authStore, discoveryFetcher);
    expect(discoveryCalls).toEqual([{ url: "http://localhost:11434/v1/models", headers: {} }]);
    expect(availability.config.models["llama-local"]).toMatchObject({ provider: "ollama", model: "llama-local" });

    const custom = createModelProvider({
      providerId: "custom",
      providerConfig: {
        type: "openai-compatible",
        displayName: "Custom local",
        apiKeyEnv: undefined,
        baseUrl: "http://localhost:9999/v1",
        modelsEndpoint: "/models",
        enabled: true
      },
      modelId: "custom-local",
      modelConfig: model("custom", "custom-local"),
      fetcher: async () => { throw new Error("must not fetch"); }
    });
    await expect(custom.complete({ prompt: "hello", sessionId: "test", messages: [], tools: [] }))
      .rejects.toThrow("requires apiKeyEnv or auth.json credentials");
  });
});
