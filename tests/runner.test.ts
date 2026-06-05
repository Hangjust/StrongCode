import { writeFile } from "node:fs/promises";
import path from "node:path";
import { AgentRunner } from "../src/agents/runner";
import { Agent } from "../src/agents/agent";
import { MockModelProvider } from "../src/models/mock-provider";
import { OpenAICompatibleFetcher } from "../src/models/openai-compatible-provider";
import { createAgent } from "../src/runtime/factory";
import { SessionStore } from "../src/sessions/session-store";
import { createDefaultToolRegistry } from "../src/tools/registry";
import { tempWorkspace } from "./helpers";

function parseJsonObject(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected JSON object");
  }

  return parsed as Record<string, unknown>;
}

function openAICompatibleConfig(workspace: Awaited<ReturnType<typeof tempWorkspace>>) {
  return {
    ...workspace.config,
    providers: {
      ...workspace.config.providers,
      custom: {
        type: "openai-compatible",
        displayName: "Custom Provider",
        apiKeyEnv: "STRONGCODE_TEST_API_KEY",
        baseUrl: "https://example.com/v1",
        modelsEndpoint: "/models",
        enabled: true
      }
    },
    agents: {
      ...workspace.config.agents,
      default: {
        ...workspace.config.agents.default,
        model: "custom-model"
      }
    },
    models: {
      ...workspace.config.models,
      "custom-model": {
        provider: "custom",
        model: "provider-model",
        displayName: "Provider Model",
        enabled: true,
        source: "configured",
        options: undefined
      }
    }
  };
}

describe("runner", () => {
  it("runs hello with the mock provider and stores a session", async () => {
    const workspace = await tempWorkspace();
    const agent: Agent = {
      name: "default",
      config: workspace.config.agents.default,
      model: new MockModelProvider()
    };
    const runner = new AgentRunner(workspace.context, new SessionStore(workspace.context.dataDir), createDefaultToolRegistry());

    const result = await runner.run(agent, "hello", "demo");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.response).toBe("Mock response: hello");
      expect(result.value.toolExecutions).toHaveLength(0);
    }
  });

  it("executes allowed read-only tools requested by the mock provider", async () => {
    const workspace = await tempWorkspace();
    await writeFile(path.join(workspace.root, "note.txt"), "agent-readable", "utf8");
    const agent: Agent = {
      name: "default",
      config: workspace.config.agents.default,
      model: new MockModelProvider()
    };
    const runner = new AgentRunner(workspace.context, new SessionStore(workspace.context.dataDir), createDefaultToolRegistry());

    const result = await runner.run(agent, "read file note.txt", "tools");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.response).toContain("agent-readable");
      expect(result.value.toolExecutions).toHaveLength(1);
    }
  });

  it("bounds model tool calls", async () => {
    const workspace = await tempWorkspace();
    const agent: Agent = {
      name: "default",
      config: workspace.config.agents.default,
      model: {
        name: "too-many-tools",
        async complete() {
          return {
            message: "too much",
            toolCalls: [
              { name: "list_files", input: { path: "." } },
              { name: "list_files", input: { path: "." } }
            ]
          };
        }
      }
    };
    const runner = new AgentRunner(workspace.context, new SessionStore(workspace.context.dataDir), createDefaultToolRegistry(), { maxToolCalls: 1 });

    const result = await runner.run(agent, "list files", "bounded");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MODEL_ERROR");
    }
  });

  it("returns MODEL_ERROR for unsupported provider completions", async () => {
    const workspace = await tempWorkspace();
    const config = {
      ...workspace.config,
      providers: {
        ...workspace.config.providers,
        anthropic: {
          type: "anthropic",
          displayName: "Claude",
          apiKeyEnv: "ANTHROPIC_API_KEY",
          baseUrl: undefined,
          modelsEndpoint: undefined,
          enabled: true
        }
      },
      agents: {
        ...workspace.config.agents,
        default: {
          ...workspace.config.agents.default,
          model: "claude-model"
        }
      },
      models: {
        ...workspace.config.models,
        "claude-model": {
          provider: "anthropic",
          model: "claude-model",
          displayName: "Claude Model",
          enabled: true,
          source: "configured",
          options: undefined
        }
      }
    };
    const agent = createAgent(config, "default");
    const runner = new AgentRunner(workspace.context, new SessionStore(workspace.context.dataDir), createDefaultToolRegistry());

    const result = await runner.run(agent, "hello", "unsupported");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MODEL_ERROR");
      expect(result.error.message).toContain("not supported");
    }
  });

  it("returns MODEL_ERROR when provider apiKeyEnv is missing at runtime", async () => {
    const workspace = await tempWorkspace();
    const originalApiKey = process.env.STRONGCODE_TEST_API_KEY;
    delete process.env.STRONGCODE_TEST_API_KEY;

    try {
      const config = openAICompatibleConfig(workspace);
      const fetcher: OpenAICompatibleFetcher = async () => {
        throw new Error("fetch should not be called without credentials");
      };
      const agent = createAgent(config, "default", { modelFetch: fetcher });
      const runner = new AgentRunner(workspace.context, new SessionStore(workspace.context.dataDir), createDefaultToolRegistry());

      const result = await runner.run(agent, "hello", "missing-env");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("MODEL_ERROR");
        expect(result.error.message).toBe("Missing API key env STRONGCODE_TEST_API_KEY for provider custom");
      }
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.STRONGCODE_TEST_API_KEY;
      } else {
        process.env.STRONGCODE_TEST_API_KEY = originalApiKey;
      }
    }
  });

  it("forms a non-streaming OpenAI-compatible request and stores the response", async () => {
    const workspace = await tempWorkspace();
    const originalApiKey = process.env.STRONGCODE_TEST_API_KEY;
    process.env.STRONGCODE_TEST_API_KEY = "test-api-key";
    const calls: Array<{ url: string; init: Parameters<OpenAICompatibleFetcher>[1] }> = [];

    try {
      const config = openAICompatibleConfig(workspace);
      const fetcher: OpenAICompatibleFetcher = async (url, init) => {
        calls.push({ url, init });
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({ choices: [{ message: { content: "real response" } }] });
          }
        };
      };
      const agent = createAgent(config, "default", { modelFetch: fetcher });
      const runner = new AgentRunner(workspace.context, new SessionStore(workspace.context.dataDir), createDefaultToolRegistry());

      const result = await runner.run(agent, "hello", "openai-compatible");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.response).toBe("real response");
      }
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("https://example.com/v1/chat/completions");
      expect(calls[0].init.method).toBe("POST");
      expect(calls[0].init.headers).toEqual({
        "Content-Type": "application/json",
        Authorization: "Bearer test-api-key"
      });
      const body = parseJsonObject(calls[0].init.body);
      expect(body.model).toBe("provider-model");
      expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.STRONGCODE_TEST_API_KEY;
      } else {
        process.env.STRONGCODE_TEST_API_KEY = originalApiKey;
      }
    }
  });

  it("redacts provider HTTP errors", async () => {
    const workspace = await tempWorkspace();
    const originalApiKey = process.env.STRONGCODE_TEST_API_KEY;
    process.env.STRONGCODE_TEST_API_KEY = "super-secret-key";

    try {
      const config = openAICompatibleConfig(workspace);
      const fetcher: OpenAICompatibleFetcher = async () => ({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        async text() {
          return JSON.stringify({
            error: {
              type: "invalid_request_error",
              message: "Authorization Bearer super-secret-key is invalid",
              code: "bad_api_key"
            }
          });
        }
      });
      const agent = createAgent(config, "default", { modelFetch: fetcher });
      const runner = new AgentRunner(workspace.context, new SessionStore(workspace.context.dataDir), createDefaultToolRegistry());

      const result = await runner.run(agent, "hello", "http-error");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("MODEL_ERROR");
        expect(result.error.message).toContain("HTTP 401");
        expect(result.error.message).toContain("Bearer [redacted]");
        expect(result.error.message).not.toContain("super-secret-key");
      }
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.STRONGCODE_TEST_API_KEY;
      } else {
        process.env.STRONGCODE_TEST_API_KEY = originalApiKey;
      }
    }
  });

  it("accepts OpenAI-compatible tool calls with null message content", async () => {
    const workspace = await tempWorkspace();
    const originalApiKey = process.env.STRONGCODE_TEST_API_KEY;
    process.env.STRONGCODE_TEST_API_KEY = "test-api-key";

    try {
      const config = openAICompatibleConfig(workspace);
      const fetcher: OpenAICompatibleFetcher = async () => ({
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            choices: [{
              message: {
                content: null,
                tool_calls: [{ function: { name: "list_files", arguments: JSON.stringify({ path: "." }) } }]
              }
            }]
          });
        }
      });
      const agent = createAgent(config, "default", { modelFetch: fetcher });
      const runner = new AgentRunner(workspace.context, new SessionStore(workspace.context.dataDir), createDefaultToolRegistry());

      const result = await runner.run(agent, "list files", "tool-null-content");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toolExecutions).toHaveLength(1);
      }
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.STRONGCODE_TEST_API_KEY;
      } else {
        process.env.STRONGCODE_TEST_API_KEY = originalApiKey;
      }
    }
  });
});
