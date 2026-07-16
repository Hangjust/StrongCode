import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Agent } from "../../src/agents/agent";
import { strongCodeConfigSchema } from "../../src/config/schema";
import type { ProviderAuth, ProviderAuthReader } from "../../src/models/auth-store";
import type { OpenAICompatibleFetcher } from "../../src/models/openai-compatible-provider";
import type { ModelRequest } from "../../src/models/provider";
import { createRuntimeContext } from "../../src/runtime/context";
import { RuntimeAgentRunnerFactory } from "../../src/runtime/runner-factory";
import { SessionStore } from "../../src/sessions/session-store";
import { ToolRegistry } from "../../src/tools/registry";
import type { Tool } from "../../src/tools/tool";

const authStore: ProviderAuthReader = {
  async get(): Promise<ProviderAuth> {
    return { type: "api", key: "integration-api-key" };
  },
  async all(): Promise<Record<string, ProviderAuth>> {
    return {};
  }
};

function tool(name: string, effect: Tool["effect"], invocations: string[]): Tool {
  return {
    name,
    description: `${name} integration fixture`,
    effect,
    readOnly: effect === "read" || effect === "search" || effect === "read-only-web",
    inputSchema: z.unknown(),
    async execute(input) {
      invocations.push(`${name}:${JSON.stringify(input)}`);
      return { ok: true, value: { content: `${name}-result` } };
    }
  };
}

export type RuntimeIntegrationHarness = Readonly<{
  runner: ReturnType<RuntimeAgentRunnerFactory["create"]>;
  sessions: SessionStore;
  primary: Agent;
  primaryRequests: readonly ModelRequest[];
  invocations: readonly string[];
  dataDir: string;
  cleanup: () => Promise<void>;
}>;

export async function runtimeIntegrationHarness(
  fetcher: OpenAICompatibleFetcher,
  primaryWrites = true
): Promise<RuntimeIntegrationHarness> {
  const root = await mkdtemp(path.join(tmpdir(), "strongcode-preflight-integration-"));
  const config = strongCodeConfigSchema.parse({
    version: 1,
    workspace: ".",
    dataDir: ".strongcode",
    defaultAgent: "primary",
    providers: {
      tenant: {
        type: "openai-compatible",
        displayName: "Tenant",
        apiKeyEnv: "TENANT_API_KEY",
        baseUrl: "https://tenant.invalid/v1",
        enabled: true
      }
    },
    agents: {
      primary: {
        model: "arbitrary-route",
        tools: ["read_file", "ripgrep", "web_search", "write_file"]
      }
    },
    models: {
      "arbitrary-route": {
        provider: "tenant",
        model: "tenant/arbitrary-summary-v9",
        displayName: "Arbitrary Summary",
        enabled: true
      }
    },
    preflight: {
      enabled: true,
      summary: {
        model: "arbitrary-route",
        tools: ["read_file", "ripgrep", "web_search", "write_file"]
      },
      analysis: { model: "arbitrary-route", tools: ["read_file", "ripgrep"] },
      explorer: { model: "arbitrary-route", tools: ["read_file", "web_search"] }
    },
    permissions: {
      tools: {
        read_file: "allow",
        ripgrep: "allow",
        web_search: "allow",
        write_file: "allow"
      }
    }
  });
  const configPath = path.join(root, "strongcode.config.yaml");
  const context = createRuntimeContext(config, configPath, root);
  const sessions = new SessionStore(context.dataDir);
  const invocations: string[] = [];
  const tools = new ToolRegistry();
  tools.register(tool("read_file", "read", invocations));
  tools.register(tool("ripgrep", "search", invocations));
  tools.register(tool("web_search", "read-only-web", invocations));
  tools.register(tool("write_file", "mutation", invocations));
  const primaryRequests: ModelRequest[] = [];
  let primaryStep = 0;
  const primary: Agent = {
    name: "primary",
    runtimeRole: "primary",
    config: config.agents.primary,
    model: {
      name: "tenant/arbitrary-summary-v9",
      async complete(request) {
        primaryRequests.push(request);
        primaryStep += 1;
        if (primaryWrites && primaryStep === 1) {
          return {
            message: "",
            toolCalls: [{ callId: "primary-write", name: "write_file", input: { path: "allowed.txt" } }]
          };
        }
        return { message: "primary complete", toolCalls: [] };
      }
    }
  };
  const runner = new RuntimeAgentRunnerFactory(context).create({
    sessions,
    tools,
    providerOptions: { modelFetch: fetcher, authStore }
  });
  const cleanup = async (): Promise<void> => {
    await runner.close();
    await rm(root, { recursive: true, force: true });
  };
  return { runner, sessions, primary, primaryRequests, invocations, dataDir: context.dataDir, cleanup };
}

export type ResearchFetcherState = Readonly<{
  fetcher: OpenAICompatibleFetcher;
  childPeak: () => number;
  childTools: readonly string[];
}>;

function response(body: unknown, requestId: string): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "x-request-id": requestId }
  });
}

function content(message: string, index: number): Response {
  return response({
    choices: [{ message: { content: message } }],
    usage: { prompt_tokens: 10 + index, completion_tokens: 2, total_tokens: 12 + index }
  }, `request-${index}`);
}

export function twentyFiveChildFetcher(): ResearchFetcherState {
  let requestIndex = 0;
  let rootStep = 0;
  let childActive = 0;
  let childPeak = 0;
  let releaseChildren: (() => void) | undefined;
  const childrenReleased = new Promise<void>(resolve => {
    releaseChildren = resolve;
  });
  const childTools: string[] = [];
  const fetcher: OpenAICompatibleFetcher = async (_url, init) => {
    const index = ++requestIndex;
    const body = init.body;
    if (body.includes("untrustedResearch")) {
      return content(JSON.stringify({
        title: "Integrated title",
        generalSummary: "Integrated summary",
        requestedItems: ["First request", "Second request"]
      }), index);
    }
    if (body.includes("Analyze only") || body.includes("Explore only")) {
      const parsed = JSON.parse(body);
      if (typeof parsed === "object" && parsed !== null && Array.isArray(parsed.tools)) {
        childTools.push(...parsed.tools.map((entry: unknown) => JSON.stringify(entry)));
      }
      childActive += 1;
      childPeak = Math.max(childPeak, childActive);
      if (childPeak === 25) releaseChildren?.();
      await childrenReleased;
      childActive -= 1;
      const match = /Question (\d+)/u.exec(body);
      const sourceIndex = Number.parseInt(match?.[1] ?? "0", 10);
      return content(JSON.stringify({
        requestId: `request-${sourceIndex}`,
        role: sourceIndex % 2 === 0 ? "analysis" : "explorer",
        summary: `Finding ${sourceIndex}`,
        sources: []
      }), index);
    }
    rootStep += 1;
    if (rootStep === 1) {
      return response({ choices: [{ message: {
        content: null,
        tool_calls: [{
          id: "root-read",
          type: "function",
          function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" }
        }]
      } }] }, `request-${index}`);
    }
    return content(JSON.stringify({
      kind: "research",
      requests: Array.from({ length: 25 }, (_, sourceIndex) => ({
        id: `request-${sourceIndex}`,
        role: sourceIndex % 2 === 0 ? "analysis" : "explorer",
        question: `Question ${sourceIndex}`
      }))
    }), index);
  };
  return { fetcher, childPeak: () => childPeak, childTools };
}

export function mixedDeniedFetcher(): OpenAICompatibleFetcher {
  return async () => response({ choices: [{ message: {
    content: null,
    tool_calls: [
      { id: "safe", type: "function", function: { name: "read_file", arguments: "{}" } },
      { id: "denied", type: "function", function: { name: "write_file", arguments: "{}" } }
    ]
  } }] }, "mixed-request");
}
