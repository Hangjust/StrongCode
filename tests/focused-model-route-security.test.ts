import { beforeEach, describe, expect, it, vi } from "vitest";
import { activateFocusedAgent } from "../src/agents/focused-active-agent";
import type { StrongCodeConfig } from "../src/config/schema";
import { testConfig } from "./helpers";

const providerFactory = vi.hoisted(() => {
  const providerIds: string[] = [];
  return { constructions: 0, providerIds };
});

vi.mock("../src/models/factory", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/models/factory")>();
  return {
    ...actual,
    createModelProvider(options: Parameters<typeof actual.createModelProvider>[0]) {
      providerFactory.constructions += 1;
      providerFactory.providerIds.push(options.providerId);
      return actual.createModelProvider(options);
    }
  };
});

const packet = {
  goal: "Resolve the exact focused model.",
  expectedOutcome: "Only constructable exact routes run.",
  scope: ["src/agents"],
  requiredChecks: ["Run routing tests."],
  prohibitions: ["No provider redirection."],
  relevantPaths: [],
  artifacts: []
};

type ActiveRouteCase = {
  readonly label: string;
  readonly activeAgentId: "tesla" | "bob-the-builder";
  readonly category: "none" | "tools-only";
  readonly allowEnvironmentCredentials?: boolean;
  readonly provider: StrongCodeConfig["providers"][string];
};

const invalidActiveRoutes: readonly ActiveRouteCase[] = [
  {
    label: "Tesla missing-base-url provider without category",
    activeAgentId: "tesla",
    category: "none",
    provider: { type: "anthropic", displayName: "Missing URL", enabled: true }
  },
  {
    label: "Tesla missing-base-url provider with tools-only category",
    activeAgentId: "tesla",
    category: "tools-only",
    provider: { type: "google", displayName: "Missing URL", enabled: true }
  },
  {
    label: "approved Bob restricted account provider without category",
    activeAgentId: "bob-the-builder",
    category: "none",
    allowEnvironmentCredentials: false,
    provider: { type: "chatgpt", displayName: "Restricted", enabled: true }
  },
  {
    label: "approved Bob invalid Vertex provider with tools-only category",
    activeAgentId: "bob-the-builder",
    category: "tools-only",
    provider: { type: "google-vertex", displayName: "Invalid Vertex", enabled: true }
  }
];

describe("focused exact and inherited model routes", () => {
  beforeEach(() => {
    providerFactory.constructions = 0;
    providerFactory.providerIds.length = 0;
  });

  it("prefers an exact configured key over an earlier native alias", async () => {
    const config = testConfig(process.cwd());
    config.providers.attacker = { type: "mock", displayName: "Attacker", enabled: true };
    config.models = {
      redirect: { provider: "attacker", model: "mock", enabled: true },
      mock: { provider: "mock", model: "safe-native-model", enabled: true }
    };
    config.agents.default.model = "mock";

    const activated = await activateFocusedAgent({
      authority: {
        config,
        activeAgentId: "tesla",
        categories: { deep: { model: "mock", tools: ["read_file"] } }
      },
      task: { categoryId: "deep", taskPacket: packet }
    });

    expect(activated.agent.modelResolution?.modelId).toBe("mock");
    expect(activated.agent.modelResolution?.providerId).toBe("mock");
    expect(activated.modelRoute).toEqual({ categoryId: "deep", provenance: "category-model" });
    expect(providerFactory.providerIds).toEqual(["mock"]);
  });

  it.each(invalidActiveRoutes)("rejects $label before provider construction", async route => {
    const config = testConfig(process.cwd());
    config.providers.denied = route.provider;
    config.models.denied = { provider: "denied", model: "denied", enabled: true };
    config.agents.default.model = "denied";
    config.agents.default.tools = ["read_file", "write_file"];
    const categories = route.category === "tools-only" ? { deep: { tools: ["read_file"] } } : undefined;
    const categoryId = route.category === "tools-only" ? "deep" : undefined;

    await expect(activateFocusedAgent({
      authority: {
        config,
        activeAgentId: route.activeAgentId,
        approvedPlanExecution: route.activeAgentId === "bob-the-builder",
        categories,
        allowEnvironmentCredentials: route.allowEnvironmentCredentials
      },
      task: { categoryId, taskPacket: packet }
    })).rejects.toMatchObject({ code: "CATEGORY_POLICY_DENIED" });
    expect(providerFactory.constructions).toBe(0);
  });

  it("keeps a valid inherited active route unchanged", async () => {
    const activated = await activateFocusedAgent({
      authority: { config: testConfig(process.cwd()), activeAgentId: "tesla" },
      task: { taskPacket: packet }
    });

    expect(activated.agent.name).toBe("tesla");
    expect(activated.agent.modelResolution?.modelId).toBe("mock");
    expect(providerFactory.providerIds).toEqual(["mock"]);
  });
});
