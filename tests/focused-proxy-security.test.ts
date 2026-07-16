import { describe, expect, it, vi } from "vitest";
import { activateFocusedAgent } from "../src/agents/focused-active-agent";
import { testConfig } from "./helpers";

const providerFactory = vi.hoisted(() => {
  const fetchers: unknown[] = [];
  const authStores: unknown[] = [];
  return { constructions: 0, fetchers, authStores };
});

vi.mock("../src/models/factory", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/models/factory")>();
  return {
    ...actual,
    createModelProvider(options: Parameters<typeof actual.createModelProvider>[0]) {
      providerFactory.constructions += 1;
      providerFactory.fetchers.push(options.fetcher);
      providerFactory.authStores.push(options.authStore);
      return actual.createModelProvider(options);
    }
  };
});

const packet = {
  goal: "Reject proxy authority.",
  expectedOutcome: "No reflective traps execute.",
  scope: ["src/agents"],
  requiredChecks: ["Run security tests."],
  prohibitions: ["No authority mutation."],
  relevantPaths: [],
  artifacts: []
};

type ProxyBoundary = "root" | "task" | "authority" | "config" | "category" | "nested-array";

function proxyWithTraps<T extends object>(target: T, onTrap: () => void): T {
  return new Proxy(target, {
    getPrototypeOf(current) {
      onTrap();
      return Reflect.getPrototypeOf(current);
    },
    ownKeys(current) {
      onTrap();
      return Reflect.ownKeys(current);
    },
    getOwnPropertyDescriptor(current, key) {
      onTrap();
      return Reflect.getOwnPropertyDescriptor(current, key);
    }
  });
}

function proxiedActivationInput(boundary: ProxyBoundary) {
  const config = testConfig(process.cwd());
  config.agents.default.tools = ["read_file", "write_file"];
  const categories = { deep: { tools: ["read_file"] } };
  const skillOptions = { homeRoot: "safe-home" };
  const originalModelFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [] }),
    text: async () => "{}"
  });
  const authority = {
    config,
    activeAgentId: "bob-the-builder",
    approvedPlanExecution: false,
    categories,
    skillOptions,
    modelFetch: originalModelFetch
  };
  const input = { authority, task: { categoryId: "deep", taskPacket: packet } };
  let traps = 0;
  const mutateAuthority = () => {
    traps += 1;
    authority.approvedPlanExecution = true;
    skillOptions.homeRoot = "attacker-home";
    config.providers.mock.type = "future-transport";
    authority.modelFetch = async () => { throw new Error("FORGED_CAPABILITY"); };
  };

  switch (boundary) {
    case "root":
      return { input: proxyWithTraps(input, mutateAuthority), trapCount: () => traps };
    case "task":
      input.task = proxyWithTraps(input.task, mutateAuthority);
      return { input, trapCount: () => traps };
    case "authority":
      input.authority = proxyWithTraps(input.authority, mutateAuthority);
      return { input, trapCount: () => traps };
    case "config":
      authority.config = proxyWithTraps(authority.config, mutateAuthority);
      return { input, trapCount: () => traps };
    case "category":
      categories.deep = proxyWithTraps(categories.deep, mutateAuthority);
      return { input, trapCount: () => traps };
    case "nested-array":
      categories.deep.tools = proxyWithTraps(categories.deep.tools, mutateAuthority);
      return { input, trapCount: () => traps };
  }
}

describe("focused activation Proxy rejection", () => {
  it.each(["root", "task", "authority", "config", "category", "nested-array"] as const)(
    "rejects a %s Proxy before any trap or provider construction",
    async boundary => {
      providerFactory.constructions = 0;
      const attempt = proxiedActivationInput(boundary);

      await expect(activateFocusedAgent(attempt.input)).rejects.toMatchObject({
        code: "CATEGORY_POLICY_DENIED"
      });
      expect(attempt.trapCount()).toBe(0);
      expect(providerFactory.constructions).toBe(0);
    }
  );

  it("captures trusted Proxy capability leaves by identity without reflection", async () => {
    providerFactory.constructions = 0;
    providerFactory.fetchers.length = providerFactory.authStores.length = 0;
    let capabilityTraps = 0;
    const modelFetch = new Proxy(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [] }),
      text: async () => "{}"
    }), {
      getPrototypeOf(target) {
        capabilityTraps += 1;
        return Reflect.getPrototypeOf(target);
      }
    });
    const authStore = new Proxy({ get: async () => undefined, all: async () => ({}) }, {
      getPrototypeOf(target) {
        capabilityTraps += 1;
        return Reflect.getPrototypeOf(target);
      }
    });

    const activated = await activateFocusedAgent({
      authority: { config: testConfig(process.cwd()), activeAgentId: "tesla", modelFetch, authStore },
      task: { taskPacket: packet }
    });

    expect(activated.agent.name).toBe("tesla");
    expect(providerFactory.fetchers[0]).toBe(modelFetch);
    expect(providerFactory.authStores[0]).toBe(authStore);
    expect(capabilityTraps).toBe(0);
    expect(providerFactory.constructions).toBe(1);
  });
});
