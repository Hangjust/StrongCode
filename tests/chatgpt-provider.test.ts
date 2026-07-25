import type { OAuthProviderAuth, ProviderAuth, ProviderAuthReader } from "../src/models/auth-store";
import { CHATGPT_CODEX_ENDPOINT, type ChatGptOAuthFetch } from "../src/models/chatgpt-oauth";
import { ChatGptModelProvider } from "../src/models/chatgpt-provider";
import { parseChatGptResponse } from "../src/models/chatgpt-response";
import { providerDefaults } from "../src/models/registry";

class MemoryAuthStore implements ProviderAuthReader {
  constructor(public auth: OAuthProviderAuth) {}
  async get(): Promise<ProviderAuth> { return this.auth; }
  async all(): Promise<Record<string, ProviderAuth>> { return { chatgpt: this.auth }; }
  async set(_providerId: string, auth: OAuthProviderAuth): Promise<void> { this.auth = auth; }
}

function sse(events: unknown[]): Response {
  return new Response(events.map(event => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

function provider(authStore: ProviderAuthReader, fetcher: ChatGptOAuthFetch): ChatGptModelProvider {
  return new ChatGptModelProvider({
    providerId: "chatgpt",
    providerConfig: { ...providerDefaults().chatgpt, enabled: true },
    modelId: "gpt-5.5",
    modelConfig: { provider: "chatgpt", model: "gpt-5.5", enabled: true },
    authStore,
    fetcher,
    timeoutMs: 2_000
  });
}

describe("ChatGPT direct Responses provider", () => {
  it("parses final text and ordered reasoning summaries from a JSON response", () => {
    const response = parseChatGptResponse(JSON.stringify({
      output: [
        {
          type: "reasoning",
          encrypted_content: "json-encrypted-secret",
          content: [{ type: "reasoning_text", text: "raw hidden reasoning" }],
          summary: [
            { type: "summary_text", text: "First " },
            { type: "ignored_summary", text: "ignored" },
            { type: "summary_text", text: "summary." },
            { type: "summary_text", text: 42 }
          ]
        },
        {
          type: "message",
          content: [{ type: "output_text", text: "Final <think>literal text</think>" }]
        }
      ]
    }), "application/json");

    expect(response).toEqual({
      message: "Final <think>literal text</think>",
      reasoning: "First summary.",
      toolCalls: []
    });
  });

  it("omits whitespace-only reasoning summaries from a JSON response", () => {
    // Given: a completed response with blank summary fragments and useful final text.
    const payload = JSON.stringify({
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: " \n\t" }] },
        { type: "message", content: [{ type: "output_text", text: "Final answer" }] }
      ]
    });

    // When: the JSON response is normalized.
    const response = parseChatGptResponse(payload, "application/json");

    // Then: reasoning is absent and final text is unchanged.
    expect(response).toEqual({ message: "Final answer", toolCalls: [] });
  });

  it("parses SSE reasoning summary slots without duplicating delta and done text", () => {
    const events = [
      { type: "response.reasoning_summary_text.delta", item_id: "reasoning-1", output_index: 0, summary_index: 0, delta: "First " },
      { type: "response.reasoning_summary_text.delta", item_id: "reasoning-1", output_index: 0, summary_index: 1, delta: "Second " },
      { type: "response.reasoning_summary_text.delta", item_id: "reasoning-1", output_index: 0, summary_index: 0, delta: "summary. " },
      { type: "response.reasoning_summary_text.done", item_id: "reasoning-1", output_index: 0, summary_index: 0, text: "First summary. " },
      { type: "response.reasoning_summary_text.done", item_id: "reasoning-1", output_index: 0, summary_index: 1, text: "Second summary." },
      { type: "response.reasoning_text.delta", item_id: "reasoning-1", delta: "raw hidden reasoning" },
      { type: "response.output_text.done", text: "Final <think>literal SSE text</think>" },
      {
        type: "response.completed",
        response: {
          output: [
            { type: "reasoning", encrypted_content: "sse-encrypted-secret", summary: [] },
            { type: "message", content: [{ type: "output_text", text: "Final <think>literal SSE text</think>" }] }
          ]
        }
      }
    ];
    const stream = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

    const response = parseChatGptResponse(stream, "text/event-stream");

    expect(response).toEqual({
      message: "Final <think>literal SSE text</think>",
      reasoning: "First summary. Second summary.",
      toolCalls: []
    });
  });

  it("prefers non-empty completed reasoning summaries over accumulated SSE summaries", () => {
    const events = [
      { type: "response.reasoning_summary_text.delta", item_id: "reasoning-1", summary_index: 0, delta: "Stale stream summary" },
      { type: "response.reasoning_summary_text.done", item_id: "reasoning-1", summary_index: 0, text: "Stale stream summary" },
      { type: "response.output_text.done", text: "Final answer" },
      {
        type: "response.completed",
        response: {
          output: [
            {
              type: "reasoning",
              encrypted_content: "completed-encrypted-secret",
              summary: [
                { type: "summary_text", text: "Authoritative " },
                { type: "summary_text", text: "snapshot." }
              ]
            },
            { type: "message", content: [{ type: "output_text", text: "Final answer" }] }
          ]
        }
      }
    ];
    const stream = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

    const response = parseChatGptResponse(stream, "text/event-stream");

    expect(response).toEqual({ message: "Final answer", reasoning: "Authoritative snapshot.", toolCalls: [] });
  });

  it("retains streamed reasoning when done and completed summaries contain only whitespace", () => {
    // Given: useful streamed reasoning followed by whitespace-only terminal snapshots.
    const events = [
      { type: "response.reasoning_summary_text.delta", item_id: "reasoning-1", summary_index: 0, delta: "Useful streamed summary." },
      { type: "response.reasoning_summary_text.done", item_id: "reasoning-1", summary_index: 0, text: " \n\t" },
      { type: "response.output_text.done", text: "Final answer" },
      {
        type: "response.completed",
        response: {
          output: [
            { type: "reasoning", summary: [{ type: "summary_text", text: "\t " }] },
            { type: "message", content: [{ type: "output_text", text: "Final answer" }] }
          ]
        }
      }
    ];
    const stream = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

    // When: the SSE response is normalized.
    const response = parseChatGptResponse(stream, "text/event-stream");

    // Then: blank terminal snapshots cannot displace useful streamed reasoning or final text.
    expect(response).toEqual({ message: "Final answer", reasoning: "Useful streamed summary.", toolCalls: [] });
  });

  it("sends the OpenCode-compatible wire format and parses streamed text plus tools", async () => {
    const store = new MemoryAuthStore({
      type: "oauth",
      access: "oauth-access",
      refresh: "oauth-refresh",
      expires: Date.now() + 3_600_000,
      accountId: "account-123"
    });
    let requestBody: Record<string, unknown> | undefined;
    const result = await provider(store, async (input, init) => {
      expect(String(input)).toBe(CHATGPT_CODEX_ENDPOINT);
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer oauth-access");
      expect(headers.get("chatgpt-account-id")).toBe("account-123");
      expect(headers.get("accept")).toBe("text/event-stream");
      requestBody = JSON.parse(String(init?.body));
      return sse([
        { type: "response.output_text.delta", delta: "Hello " },
        { type: "response.output_text.delta", delta: "world" },
        { type: "response.output_item.done", item: { type: "function_call", call_id: "call-1", name: "list_files", arguments: "{\"path\":\".\"}" } },
        { type: "response.completed", response: { output: [{ type: "function_call", call_id: "call-1", name: "list_files", arguments: "{\"path\":\".\"}" }] } }
      ]);
    }).complete({
      prompt: "Inspect the workspace",
      systemPrompt: "Be precise.",
      sessionId: "session/one",
      messages: [],
      items: [
        { type: "text", role: "user", content: "Inspect the workspace" },
        { type: "tool_call", role: "assistant", callId: "call-history-a", name: "list_files", input: { path: "." } },
        { type: "tool_call", role: "assistant", callId: "call-history-b", name: "list_files", input: { path: "src" } },
        { type: "tool_result", role: "tool", callId: "call-history-a", content: "README.md", isError: false },
        { type: "tool_result", role: "tool", callId: "call-history-b", content: "index.ts", isError: true }
      ],
      tools: ["list_files"],
      toolDefinitions: [{ name: "list_files", description: "List files", inputSchema: { type: "object" } }]
    });

    expect(result).toEqual({ message: "Hello world", toolCalls: [{ callId: "call-1", name: "list_files", input: { path: "." } }] });
    expect(requestBody?.["input"]).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Inspect the workspace" }] },
      { type: "function_call", call_id: "call-history-a", name: "list_files", arguments: "{\"path\":\".\"}" },
      { type: "function_call", call_id: "call-history-b", name: "list_files", arguments: "{\"path\":\"src\"}" },
      { type: "function_call_output", call_id: "call-history-a", output: "README.md" },
      { type: "function_call_output", call_id: "call-history-b", output: "index.ts" }
    ]);
    expect(requestBody).toMatchObject({
      model: "gpt-5.5",
      instructions: "Be precise.",
      store: false,
      stream: true,
      prompt_cache_key: "session-one",
      input: [
        { role: "user", content: [{ type: "input_text", text: "Inspect the workspace" }] },
        { type: "function_call", call_id: "call-history-a", name: "list_files", arguments: '{"path":"."}' },
        { type: "function_call", call_id: "call-history-b", name: "list_files", arguments: '{"path":"src"}' },
        { type: "function_call_output", call_id: "call-history-a", output: "README.md" },
        { type: "function_call_output", call_id: "call-history-b", output: "index.ts" }
      ],
      tools: [{ type: "function", name: "list_files", description: "List files", parameters: { type: "object" }, strict: false }]
    });
  });

  it("refreshes once after a 401, persists the token, and retries with the new bearer", async () => {
    const store = new MemoryAuthStore({
      type: "oauth",
      access: "old-access",
      refresh: "refresh-token",
      expires: Date.now() + 3_600_000
    });
    const bearerValues: string[] = [];
    const fetcher: ChatGptOAuthFetch = async (input, init) => {
      if (String(input).endsWith("/oauth/token")) {
        return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }), { status: 200 });
      }
      bearerValues.push(new Headers(init?.headers).get("authorization") ?? "");
      if (bearerValues.length === 1) return new Response("unauthorized", { status: 401 });
      return sse([{ type: "response.output_text.done", text: "retried" }]);
    };

    await expect(provider(store, fetcher).complete({ prompt: "hello", sessionId: "refresh", messages: [], tools: [] }))
      .resolves.toEqual({ message: "retried", toolCalls: [] });
    expect(bearerValues).toEqual(["Bearer old-access", "Bearer new-access"]);
    expect(store.auth).toMatchObject({ access: "new-access", refresh: "new-refresh" });
  });

  it("never forwards malformed account metadata as an HTTP header", async () => {
    const store = new MemoryAuthStore({
      type: "oauth",
      access: "oauth-access",
      expires: Date.now() + 3_600_000,
      accountId: "bad\r\nx-injected: yes"
    });
    await provider(store, async (_input, init) => {
      expect(new Headers(init?.headers).has("chatgpt-account-id")).toBe(false);
      return sse([{ type: "response.output_text.done", text: "safe" }]);
    }).complete({ prompt: "hello", sessionId: "safe", messages: [], tools: [] });
  });
});
