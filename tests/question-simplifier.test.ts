import { z } from "zod";
import type { ProviderConfig } from "../src/config/schema";
import type { ProviderAuthReader } from "../src/models/auth-store";
import {
  DeepSeekQuestionSimplifier,
  QuestionSimplifierError,
  type QuestionSimplifierFetch,
  type QuestionSimplifierFetchInit
} from "../src/questions/simplifier";
import { parseQuestionRequest, type QuestionRequest } from "../src/questions/schema";

const requestBodySchema = z.object({
  model: z.literal("deepseek-v4-flash"),
  thinking: z.object({ type: z.literal("disabled") }).strict(),
  temperature: z.literal(0),
  stream: z.literal(false),
  response_format: z.object({ type: z.literal("json_object") }).strict(),
  max_tokens: z.number().int().positive().max(4096),
  messages: z.tuple([
    z.object({ role: z.literal("system"), content: z.string().min(1) }).strict(),
    z.object({ role: z.literal("user"), content: z.string().min(1) }).strict()
  ])
}).strict();

const projectionSchema = z.object({
  questions: z.array(z.object({
    header: z.string(),
    question: z.string(),
    options: z.array(z.object({
      label: z.string(),
      description: z.string().optional()
    }).strict())
  }).strict())
}).strict();

function questionRequest(): QuestionRequest {
  const parsed = parseQuestionRequest({
    questions: [
      {
        id: "private-runtime-id",
        header: "Runtime choice",
        question: "Which runtime should we use?",
        multiple: true,
        allowCustom: false,
        options: [
          { id: "private-node-id", label: "Node.js 22", description: "Use the current LTS." },
          { id: "private-bun-id", label: "Bun 1.2", description: "Use the fast runtime." }
        ]
      },
      {
        id: "private-store-id",
        header: "Data store",
        question: "Where should records be stored?",
        options: [
          { id: "private-sqlite-id", label: "SQLite", description: "Keep data in one local file." },
          { id: "private-postgres-id", label: "PostgreSQL" }
        ]
      }
    ]
  });
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

function rewrittenContent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    questions: [
      {
        header: "Choose runtime",
        question: "Which runtime works best?",
        options: [
          { label: "Node.js 22", description: "Use the stable LTS release." },
          { label: "Bun 1.2", description: "Use the faster runtime." }
        ]
      },
      {
        header: "Store records",
        question: "Where should we save records?",
        options: [
          { label: "SQLite", description: "Save data in one local file." },
          { label: "PostgreSQL" }
        ]
      }
    ],
    ...overrides
  });
}

function completion(content = rewrittenContent()): Response {
  return new Response(JSON.stringify({
    id: "completion-id",
    object: "chat.completion",
    created: 1,
    model: "deepseek-v4-flash",
    choices: [{
      index: 0,
      message: { role: "assistant", content },
      logprobs: null,
      finish_reason: "stop"
    }],
    usage: { prompt_tokens: 50, completion_tokens: 50, total_tokens: 100 }
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function providerConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    type: "openai-compatible",
    displayName: "DeepSeek",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com",
    enabled: true,
    ...overrides
  };
}

function authReader(key = "connected-deepseek-key"): ProviderAuthReader {
  const auth = {
    type: "api" as const,
    key,
    metadata: {
      providerType: "openai-compatible",
      origin: "https://api.deepseek.com"
    }
  };
  return {
    async get() {
      return auth;
    },
    async all() {
      return { deepseek: auth };
    }
  };
}

describe("DeepSeekQuestionSimplifier", () => {
  it("sends only the ordered visible projection and preserves local identity and flags", async () => {
    const original = questionRequest();
    const calls: Array<{ readonly url: string; readonly init: QuestionSimplifierFetchInit }> = [];
    const fetcher: QuestionSimplifierFetch = async (url, init) => {
      calls.push({ url, init });
      return completion();
    };
    const simplifier = new DeepSeekQuestionSimplifier({
      providerId: "deepseek",
      providerConfig: providerConfig(),
      authStore: authReader(),
      fetcher
    });
    const signal = new AbortController().signal;

    const rewritten = await simplifier.simplify(original, signal);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe("https://api.deepseek.com/chat/completions");
    expect(call?.init).toMatchObject({ method: "POST", redirect: "error", signal });
    expect(call?.init.headers).toEqual({
      Accept: "application/json",
      Authorization: "Bearer connected-deepseek-key",
      "Content-Type": "application/json"
    });
    const body = requestBodySchema.parse(JSON.parse(call?.init.body ?? ""));
    expect(body).toMatchObject({
      model: "deepseek-v4-flash",
      thinking: { type: "disabled" },
      temperature: 0,
      stream: false,
      response_format: { type: "json_object" }
    });
    expect(projectionSchema.parse(JSON.parse(body.messages[1].content))).toEqual({
      questions: [
        {
          header: "Runtime choice",
          question: "Which runtime should we use?",
          options: [
            { label: "Node.js 22", description: "Use the current LTS." },
            { label: "Bun 1.2", description: "Use the fast runtime." }
          ]
        },
        {
          header: "Data store",
          question: "Where should records be stored?",
          options: [
            { label: "SQLite", description: "Keep data in one local file." },
            { label: "PostgreSQL" }
          ]
        }
      ]
    });
    expect(rewritten.questions.map(question => ({
      id: question.id,
      multiple: question.multiple,
      allowCustom: question.allowCustom,
      optionIds: question.options.map(option => option.id)
    }))).toEqual(original.questions.map(question => ({
      id: question.id,
      multiple: question.multiple,
      allowCustom: question.allowCustom,
      optionIds: question.options.map(option => option.id)
    })));
    expect(rewritten.questions[0]?.header).toBe("Choose runtime");
    expect(rewritten).not.toBe(original);
  });

  it("does not acquire credentials or make a request until simplify is invoked", async () => {
    let authCalls = 0;
    let fetchCalls = 0;
    const authStore: ProviderAuthReader = {
      async get() {
        authCalls += 1;
        return (await authReader().get("deepseek"));
      },
      async all() {
        return {};
      }
    };
    const simplifier = new DeepSeekQuestionSimplifier({
      providerId: "deepseek",
      providerConfig: providerConfig(),
      authStore,
      fetcher: async () => {
        fetchCalls += 1;
        return completion();
      }
    });

    expect(authCalls).toBe(0);
    expect(fetchCalls).toBe(0);
    await simplifier.simplify(questionRequest(), new AbortController().signal);
    expect(authCalls).toBe(1);
    expect(fetchCalls).toBe(1);
  });

  it.each([
    ["other provider ID", "deepseek-alias", providerConfig()],
    ["disabled provider", "deepseek", providerConfig({ enabled: false })],
    ["wrong provider type", "deepseek", providerConfig({ type: "openai" })],
    ["missing base URL", "deepseek", providerConfig({ baseUrl: undefined })],
    ["wrong host", "deepseek", providerConfig({ baseUrl: "https://attacker.example" })],
    ["host suffix", "deepseek", providerConfig({ baseUrl: "https://api.deepseek.com.attacker.example" })],
    ["userinfo", "deepseek", providerConfig({ baseUrl: "https://api.deepseek.com@attacker.example" })],
    ["custom port", "deepseek", providerConfig({ baseUrl: "https://api.deepseek.com:444" })],
    ["query", "deepseek", providerConfig({ baseUrl: "https://api.deepseek.com?next=attacker" })],
    ["fragment", "deepseek", providerConfig({ baseUrl: "https://api.deepseek.com#fragment" })],
    ["path", "deepseek", providerConfig({ baseUrl: "https://api.deepseek.com/v1" })]
  ])("rejects %s before credential lookup", async (_case, providerId, config) => {
    let authCalls = 0;
    let fetchCalls = 0;
    const simplifier = new DeepSeekQuestionSimplifier({
      providerId,
      providerConfig: config,
      authStore: {
        async get() {
          authCalls += 1;
          return undefined;
        },
        async all() {
          return {};
        }
      },
      fetcher: async () => {
        fetchCalls += 1;
        return completion();
      }
    });

    await expect(simplifier.simplify(questionRequest(), new AbortController().signal))
      .rejects.toMatchObject({ name: "QuestionSimplifierError", kind: "configuration" });
    expect(authCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  it("uses environment credentials only after explicit constructor opt-in", async () => {
    const previous = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "environment-deepseek-key";
    let fetchCalls = 0;
    const fetcher: QuestionSimplifierFetch = async (_url, init) => {
      fetchCalls += 1;
      expect(init.headers.Authorization).toBe("Bearer environment-deepseek-key");
      return completion();
    };
    try {
      const denied = new DeepSeekQuestionSimplifier({
        providerId: "deepseek",
        providerConfig: providerConfig(),
        fetcher
      });
      await expect(denied.simplify(questionRequest(), new AbortController().signal))
        .rejects.toMatchObject({ kind: "authentication" });
      expect(fetchCalls).toBe(0);

      const allowed = new DeepSeekQuestionSimplifier({
        providerId: "deepseek",
        providerConfig: providerConfig(),
        allowEnvironmentCredentials: true,
        fetcher
      });
      await expect(allowed.simplify(questionRequest(), new AbortController().signal)).resolves.toBeDefined();
      expect(fetchCalls).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previous;
    }
  });

  it("cancels the sole in-flight transport with the caller signal", async () => {
    let fetchCalls = 0;
    let markStarted = (): void => undefined;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const controller = new AbortController();
    const fetcher: QuestionSimplifierFetch = async (_url, init) => {
      fetchCalls += 1;
      markStarted();
      return await new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
      });
    };
    const simplifier = new DeepSeekQuestionSimplifier({
      providerId: "deepseek",
      providerConfig: providerConfig(),
      authStore: authReader(),
      fetcher
    });

    const pending = simplifier.simplify(questionRequest(), controller.signal);
    await started;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "QuestionSimplifierError", kind: "cancelled" });
    expect(fetchCalls).toBe(1);
  });

  it("rejects the entire rewrite when any nested value or count is invalid without mutating the original", async () => {
    const original = questionRequest();
    const snapshot = JSON.stringify(original);
    const invalid = JSON.stringify({
      questions: [
        {
          header: "Choose runtime",
          question: "Which runtime works best?",
          options: [
            { label: "Node.js 22" },
            { label: "Bun 1.2" }
          ]
        },
        {
          header: "Store records",
          question: "Where should we save records?",
          options: [{ label: "Only one option" }]
        }
      ]
    });
    const simplifier = new DeepSeekQuestionSimplifier({
      providerId: "deepseek",
      providerConfig: providerConfig(),
      authStore: authReader(),
      fetcher: async () => completion(invalid)
    });

    await expect(simplifier.simplify(original, new AbortController().signal))
      .rejects.toMatchObject({ name: "QuestionSimplifierError", kind: "response" });
    expect(JSON.stringify(original)).toBe(snapshot);
    expect(original).toEqual(questionRequest());
  });

  it("rejects unknown nested response fields instead of accepting unchecked JSON", async () => {
    const content = rewrittenContent({ internal_id: "must-not-be-accepted" });
    const simplifier = new DeepSeekQuestionSimplifier({
      providerId: "deepseek",
      providerConfig: providerConfig(),
      authStore: authReader(),
      fetcher: async () => completion(content)
    });

    await expect(simplifier.simplify(questionRequest(), new AbortController().signal))
      .rejects.toBeInstanceOf(QuestionSimplifierError);
  });

  it("makes no retry or fallback request after an HTTP failure", async () => {
    let fetchCalls = 0;
    const simplifier = new DeepSeekQuestionSimplifier({
      providerId: "deepseek",
      providerConfig: providerConfig(),
      authStore: authReader("secret-that-must-not-leak"),
      fetcher: async () => {
        fetchCalls += 1;
        return new Response("secret-that-must-not-leak", { status: 503, statusText: "Unavailable" });
      }
    });

    const failure = simplifier.simplify(questionRequest(), new AbortController().signal);
    await expect(failure).rejects.toMatchObject({ kind: "request" });
    await expect(failure).rejects.not.toThrow("secret-that-must-not-leak");
    expect(fetchCalls).toBe(1);
  });

  it("rejects a declared oversized response without reading its body", async () => {
    let bodyReads = 0;
    const simplifier = new DeepSeekQuestionSimplifier({
      providerId: "deepseek",
      providerConfig: providerConfig(),
      authStore: authReader(),
      fetcher: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => String(128 * 1024 + 1) },
        async text() {
          bodyReads += 1;
          return "{}";
        }
      })
    });

    await expect(simplifier.simplify(questionRequest(), new AbortController().signal))
      .rejects.toMatchObject({ kind: "response" });
    expect(bodyReads).toBe(0);
  });
});
