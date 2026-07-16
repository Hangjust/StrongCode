import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activateFocusedAgent } from "../src/agents/focused-active-agent";
import type { StrongCodeConfig } from "../src/config/schema";
import * as rootApi from "../src/index";
import { testConfig } from "./helpers";

const resolverGate = vi.hoisted(() => {
  let blocked: Promise<void> | undefined;
  let entered: Promise<void> | undefined;
  let releaseBlocked: (() => void) | undefined;
  let markEntered: (() => void) | undefined;
  return {
    arm() {
      blocked = new Promise(resolve => { releaseBlocked = resolve; });
      entered = new Promise(resolve => { markEntered = resolve; });
    },
    async wait() {
      markEntered?.();
      await blocked;
    },
    async waitUntilEntered() {
      await entered;
    },
    release() {
      releaseBlocked?.();
      blocked = undefined;
      entered = undefined;
      releaseBlocked = undefined;
      markEntered = undefined;
    }
  };
});

const providerFactory = vi.hoisted(() => {
  const fetchers: unknown[] = [];
  const chatGptFetchers: unknown[] = [];
  const authStores: unknown[] = [];
  return { constructions: 0, fetchers, chatGptFetchers, authStores };
});

vi.mock("../src/skills/resolver", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/skills/resolver")>();
  return {
    ...actual,
    async resolveSkills(...parameters: Parameters<typeof actual.resolveSkills>) {
      await resolverGate.wait();
      return actual.resolveSkills(...parameters);
    }
  };
});

vi.mock("../src/models/factory", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/models/factory")>();
  return {
    ...actual,
    createModelProvider(options: Parameters<typeof actual.createModelProvider>[0]) {
      providerFactory.constructions += 1;
      providerFactory.fetchers.push(options.fetcher);
      providerFactory.chatGptFetchers.push(options.chatGptFetch);
      providerFactory.authStores.push(options.authStore);
      return actual.createModelProvider(options);
    }
  };
});

const roots: string[] = [];

function packet(goal = "Enforce the focused policy boundary.") {
  return {
    goal,
    expectedOutcome: "Only the active primary agent runs with attenuated authority.",
    scope: ["src/agents"],
    requiredChecks: ["Run focused policy tests."],
    prohibitions: ["Do not create child tasks."],
    relevantPaths: ["src/agents/focused-active-agent.ts"],
    artifacts: ["policy receipt"]
  };
}

function focusedInput(config: StrongCodeConfig) {
  return {
    authority: {
      config,
      activeAgentId: "tesla",
      categories: { deep: { tools: ["read_file"] } }
    },
    task: { categoryId: "deep", taskPacket: packet() }
  };
}

describe("focused activation authority rejections", () => {
  beforeEach(() => {
    providerFactory.constructions = 0;
    providerFactory.fetchers.length = providerFactory.chatGptFetchers.length = providerFactory.authStores.length = 0;
  });

  afterEach(async () => {
    resolverGate.release();
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  it("exposes exactly one asynchronous activation argument", () => {
    expect(activateFocusedAgent.length).toBe(1);
    expect(activateFocusedAgent.constructor.name).toBe("AsyncFunction");
  });

  it.each([
    {
      label: "disabled selected model",
      arrange(config: StrongCodeConfig) {
        config.models.denied = { provider: "mock", model: "denied", enabled: false };
        return { model: "denied" };
      }
    },
    {
      label: "disabled fallback model",
      arrange(config: StrongCodeConfig) {
        config.models.denied = { provider: "mock", model: "denied", enabled: false };
        return { model: "mock", fallbackModels: ["denied"] };
      }
    },
    {
      label: "missing required base URL",
      arrange(config: StrongCodeConfig) {
        config.providers.denied = { type: "anthropic", displayName: "Denied", enabled: true };
        config.models.denied = { provider: "denied", model: "denied", enabled: true };
        return { model: "denied" };
      }
    },
    {
      label: "restricted account provider",
      arrange(config: StrongCodeConfig) {
        config.providers.denied = { type: "chatgpt", displayName: "Denied", enabled: true };
        config.models.denied = { provider: "denied", model: "denied", enabled: true };
        return { model: "denied" };
      },
      allowEnvironmentCredentials: false
    },
    {
      label: "Vertex missing required data",
      arrange(config: StrongCodeConfig) {
        config.providers.denied = { type: "google-vertex", displayName: "Denied", enabled: true };
        config.models.denied = { provider: "denied", model: "denied", enabled: true };
        return { model: "denied" };
      }
    },
    {
      label: "fallback on an unconstructable provider",
      arrange(config: StrongCodeConfig) {
        config.providers.denied = { type: "google", displayName: "Denied", enabled: true };
        config.models.denied = { provider: "denied", model: "denied", enabled: true };
        return { model: "mock", fallbackModels: ["denied"] };
      }
    }
  ])("denies $label before provider construction", async ({ arrange, allowEnvironmentCredentials }) => {
    const config = testConfig(process.cwd());
    const category = arrange(config);
    const input = focusedInput(config);
    const authority = {
      ...input.authority,
      categories: { deep: category },
      allowEnvironmentCredentials
    };

    await expect(activateFocusedAgent({ ...input, authority })).rejects.toMatchObject({
      code: "CATEGORY_POLICY_DENIED"
    });
    expect(providerFactory.constructions).toBe(0);
  });

  it("snapshots all authority, task data, and provider capabilities before resolver await", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-focused-snapshot-"));
    roots.push(root);
    const config = testConfig(root);
    config.dataDir = ".focused";
    config.agents.default.tools = ["read_file", "write_file"];
    config.agents.default.systemPrompt = "SAFE_SYSTEM_TEXT";
    const categorySkills: string[] = [];
    const categories = { deep: { model: "mock", fallbackModels: ["mock"], tools: ["read_file"], skills: categorySkills } };
    const taskPacket = packet("SAFE_TASK_TEXT");
    const originalModelFetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [] }), text: async () => "{}" });
    const originalChatGptFetch = async () => new Response("{}", { status: 200 });
    const originalAuthStore = { get: async () => undefined, all: async () => ({}) };
    const authority = {
      config,
      activeAgentId: "bob-the-builder",
      approvedPlanExecution: true,
      categories,
      modelFetch: originalModelFetch,
      chatGptFetch: originalChatGptFetch,
      authStore: originalAuthStore
    };
    const requestedSkills: string[] = [];
    const task = { categoryId: "deep", taskPacket, requestedSkills };
    resolverGate.arm();

    const activation = activateFocusedAgent({ authority, task });
    await resolverGate.waitUntilEntered();
    authority.activeAgentId = "tesla";
    authority.approvedPlanExecution = false;
    authority.modelFetch = async () => { throw new Error("FORGED_MODEL_FETCH"); };
    authority.chatGptFetch = async () => { throw new Error("FORGED_CHATGPT_FETCH"); };
    authority.authStore = { get: async () => { throw new Error("FORGED_AUTH"); }, all: async () => ({}) };
    config.agents.default.tools = ["write_file"];
    config.agents.default.systemPrompt = "FORGED_SYSTEM_TEXT";
    config.models.mock.provider = "forged";
    config.providers.mock.type = "future-transport";
    categories.deep.model = "forged";
    categories.deep.fallbackModels[0] = "forged";
    categories.deep.tools[0] = "write_file";
    categorySkills.push("forged-skill");
    task.categoryId = "forged";
    task.requestedSkills.push("forged-skill");
    taskPacket.goal = "FORGED_TASK_TEXT";
    resolverGate.release();

    const activated = await activation;
    expect(activated.agent.name).toBe("bob-the-builder");
    expect(activated.agent.toolPolicy).toBe("standard");
    expect(activated.agent.config.model).toBe("mock");
    expect(activated.agent.config.tools).toEqual(["read_file"]);
    expect(activated.category).toMatchObject({
      model: "mock",
      fallbackModels: ["mock"],
      tools: ["read_file"],
      skills: []
    });
    expect(activated.task.content).toContain("SAFE_TASK_TEXT");
    expect(activated.task.content).not.toContain("FORGED_TASK_TEXT");
    expect(activated.agent.systemPrompt).toContain("SAFE_SYSTEM_TEXT");
    expect(activated.agent.systemPrompt).not.toContain("FORGED_SYSTEM_TEXT");
    expect(providerFactory.fetchers).toEqual([originalModelFetch]);
    expect(providerFactory.chatGptFetchers).toEqual([originalChatGptFetch]);
    expect(providerFactory.authStores).toEqual([originalAuthStore]);
    expect(providerFactory.constructions).toBe(1);
    await expect(access(path.join(root, ".focused", "tasks"))).rejects.toThrow();
  });

  it("rejects task-selected skill trust roots", async () => {
    const input = focusedInput(testConfig(process.cwd()));
    const task = {
      ...input.task,
      skillOptions: { homeRoot: "attacker", trustedProjectInstructions: true }
    };

    await expect(activateFocusedAgent({
      ...input,
      task
    })).rejects.toMatchObject({ code: "CATEGORY_POLICY_DENIED" });
    expect(providerFactory.constructions).toBe(0);
  });

  it.each([
    "activateFocusedAgent",
    "prepareFocusedActiveAgent",
    "parseTaskPacket",
    "renderTaskPacket",
    "taskPacketSchema"
  ])("does not publish premature root export %s", exportName => {
    expect(exportName in rootApi).toBe(false);
  });
});
