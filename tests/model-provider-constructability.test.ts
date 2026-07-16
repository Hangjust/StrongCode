import { describe, expect, it } from "vitest";
import {
  isModelProviderConstructable,
  type CreateModelProviderOptions
} from "../src/models/factory";
import { providerDefaults } from "../src/models/registry";

function options(providerId: string, providerConfig: CreateModelProviderOptions["providerConfig"]): CreateModelProviderOptions {
  return {
    providerId,
    providerConfig,
    modelId: "fixture-model",
    modelConfig: { provider: providerId, model: "fixture-model", enabled: true }
  };
}

describe("model provider constructability", () => {
  it.each([
    ["anthropic", { type: "anthropic", displayName: "Anthropic", enabled: true }],
    ["google", { type: "google", displayName: "Google", enabled: true }],
    ["openai", { type: "openai", displayName: "OpenAI", enabled: true }]
  ])("rejects %s without its required base URL", (providerId, providerConfig) => {
    const candidate = options(providerId, providerConfig);

    expect(isModelProviderConstructable(candidate)).toBe(false);
  });

  it.each(["chatgpt", "codex-cli", "google-vertex"])(
    "rejects restricted account provider %s",
    providerId => {
      const providerConfig = {
        ...providerDefaults()[providerId],
        projectId: providerId === "google-vertex" ? "project" : undefined,
        location: providerId === "google-vertex" ? "us-central1" : undefined,
        enabled: true
      };
      const candidate = { ...options(providerId, providerConfig), allowEnvironmentCredentials: false };

      expect(isModelProviderConstructable(candidate)).toBe(false);
    }
  );

  it.each([
    { projectId: undefined, location: "us-central1" },
    { projectId: "project", location: undefined },
    { projectId: "bad/project", location: "us-central1" },
    { projectId: "project", location: "bad/location" }
  ])("rejects Vertex with missing or invalid required data %#", required => {
    const candidate = options("google-vertex", {
      ...providerDefaults()["google-vertex"],
      ...required,
      enabled: true
    });

    expect(isModelProviderConstructable(candidate)).toBe(false);
  });

  it.each(["mock", "openai", "anthropic", "google", "chatgpt", "codex-cli"])(
    "accepts constructable built-in provider %s",
    providerId => {
      const configured = providerDefaults()[providerId] ?? {
        type: providerId,
        displayName: providerId
      };
      const candidate = options(providerId, { ...configured, enabled: true });
      expect(isModelProviderConstructable(candidate)).toBe(true);
    }
  );

  it("accepts Vertex only with valid project and location", () => {
    const candidate = options("google-vertex", {
      ...providerDefaults()["google-vertex"],
      projectId: "project-1",
      location: "us-central1",
      enabled: true
    });

    expect(isModelProviderConstructable(candidate)).toBe(true);
  });
});
