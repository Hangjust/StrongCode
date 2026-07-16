import { z } from "zod";
import type { Agent } from "../src/agents/agent";
import { AgentRunner } from "../src/agents/runner";
import type { ProviderAuth, ProviderAuthReader } from "../src/models/auth-store";
import { AnthropicModelProvider } from "../src/models/anthropic-provider";
import { GoogleGeminiModelProvider } from "../src/models/google-provider";
import type { NativeProviderFetcher } from "../src/models/native-provider-utils";
import type { ModelProvider } from "../src/models/provider";
import { providerDefaults } from "../src/models/registry";
import { ok } from "../src/core/result";
import type { ToolInvocationContext } from "../src/runtime/context";
import { SessionStore } from "../src/sessions/session-store";
import { ToolRegistry } from "../src/tools/registry";
import { tempWorkspace } from "./helpers";

const apiAuthStore: ProviderAuthReader = {
  async get(): Promise<ProviderAuth> {
    return { type: "api", key: "runner-continuation-key" };
  },
  async all(): Promise<Record<string, ProviderAuth>> {
    return {};
  }
};

export function anthropicRunnerProvider(fetcher: NativeProviderFetcher): AnthropicModelProvider {
  return new AnthropicModelProvider({
    providerId: "anthropic",
    providerConfig: { ...providerDefaults().anthropic, enabled: true },
    modelId: "claude-test",
    modelConfig: { provider: "anthropic", model: "claude-test", enabled: true },
    authStore: apiAuthStore,
    fetcher
  });
}

export function geminiRunnerProvider(fetcher: NativeProviderFetcher): GoogleGeminiModelProvider {
  return new GoogleGeminiModelProvider({
    providerId: "google",
    providerConfig: { ...providerDefaults().google, enabled: true },
    modelId: "gemini-test",
    modelConfig: { provider: "google", model: "gemini-test", enabled: true },
    authStore: apiAuthStore,
    fetcher
  });
}

export function providerResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

export async function createRunnerHarness(model: ModelProvider): Promise<{
  readonly agent: Agent;
  readonly context: ToolInvocationContext;
  readonly runner: AgentRunner;
  readonly sessions: SessionStore;
  readonly tools: ToolRegistry;
}> {
  const workspace = await tempWorkspace();
  const config = {
    ...workspace.config,
    agents: {
      ...workspace.config.agents,
      default: { ...workspace.config.agents.default, tools: ["read_file"] }
    },
    permissions: { tools: { read_file: "allow" as const } }
  };
  const context = { ...workspace.context, config };
  const sessions = new SessionStore(context.dataDir);
  const tools = new ToolRegistry();
  tools.register({
    name: "read_file",
    description: "Read one fixture file",
    effect: "read",
    inputSchema: z.unknown(),
    async execute() {
      return ok({ content: "fixture contents" });
    }
  });
  return {
    agent: {
      name: "default",
      config: config.agents.default,
      model,
      systemPrompt: "Trusted test instructions."
    },
    context,
    runner: new AgentRunner(context, sessions, tools),
    sessions,
    tools
  };
}
