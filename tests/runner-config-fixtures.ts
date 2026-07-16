import { z } from "zod";
import { tempWorkspace } from "./helpers";

export function parseJsonObject(text: string): Record<string, unknown> {
  return z.record(z.unknown()).parse(JSON.parse(text));
}

export function openAIChatGptConfig(workspace: Awaited<ReturnType<typeof tempWorkspace>>) {
  return {
    ...workspace.config,
    providers: {
      ...workspace.config.providers,
      openai: {
        type: "openai" as const,
        displayName: "GPT / OpenAI",
        apiKeyEnv: "STRONGCODE_TEST_OPENAI_API_KEY",
        baseUrl: "https://api.openai.com/v1",
        modelsEndpoint: "/models",
        enabled: true
      }
    },
    agents: {
      ...workspace.config.agents,
      default: { ...workspace.config.agents.default, model: "gpt-test" }
    },
    models: {
      ...workspace.config.models,
      "gpt-test": {
        provider: "openai",
        model: "gpt-test",
        displayName: "GPT Test",
        enabled: true,
        source: "configured" as const,
        options: undefined
      }
    }
  };
}

export function openAICompatibleConfig(workspace: Awaited<ReturnType<typeof tempWorkspace>>) {
  return {
    ...workspace.config,
    providers: {
      ...workspace.config.providers,
      custom: {
        type: "openai-compatible" as const,
        displayName: "Custom Provider",
        apiKeyEnv: "STRONGCODE_TEST_API_KEY",
        baseUrl: "https://example.com/v1",
        modelsEndpoint: "/models",
        enabled: true
      }
    },
    agents: {
      ...workspace.config.agents,
      default: { ...workspace.config.agents.default, model: "custom-model" }
    },
    models: {
      ...workspace.config.models,
      "custom-model": {
        provider: "custom",
        model: "provider-model",
        displayName: "Provider Model",
        enabled: true,
        source: "configured" as const,
        options: undefined
      }
    }
  };
}
