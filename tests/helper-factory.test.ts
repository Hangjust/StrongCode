import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfiguredModelRoute } from "../src/agents/model-routing";
import { SPECIALIST_AGENT_IDS, type SpawnTarget } from "../src/agents/spawn-targets";
import type { StrongCodeConfig } from "../src/config/schema";
import { loadRuntimeCatalog } from "../src/config/runtime-catalog";
import { EnsembleModelProvider } from "../src/models/ensemble-provider";
import { createModelProvider } from "../src/models/factory";
import {
  CHILD_SAFETY_FOOTER,
  createChildAgent,
  type ChildFactoryInput
} from "../src/runtime/child-factory";
import type { ResolvedSkills } from "../src/skills/resolver";
import type { ChildExecutionPolicy } from "../src/tools/child-policy";
import { testConfig } from "./helpers";

vi.mock("../src/models/factory", async importOriginal => {
  const original = await importOriginal<typeof import("../src/models/factory")>();
  return { ...original, createModelProvider: vi.fn(original.createModelProvider) };
});

vi.mock("../src/agents/model-routing", async importOriginal => {
  const original = await importOriginal<typeof import("../src/agents/model-routing")>();
  return { ...original, resolveConfiguredModelRoute: vi.fn(original.resolveConfiguredModelRoute) };
});

const providerSpy = vi.mocked(createModelProvider);
const configuredRouteSpy = vi.mocked(resolveConfiguredModelRoute);

const SKILLS: ResolvedSkills = {
  content: "Reviewed skill Markdown: preserve the acceptance marker SKILL_OK.",
  skills: [{ id: "planning", content: "preserve the acceptance marker SKILL_OK." }],
  receipts: [{ id: "planning", path: "C:/trusted/skills/planning/SKILL.md", sha256: "a".repeat(64) }]
};

function policy(toolNames: readonly string[]): ChildExecutionPolicy {
  const permissions = Object.fromEntries(toolNames.map(toolName => [toolName, "allow" as const]));
  const tools = [...toolNames];
  Object.freeze(permissions);
  Object.freeze(tools);
  return Object.freeze({ permissions, tools });
}

async function input(
  config: StrongCodeConfig,
  target: SpawnTarget,
  overrides: Partial<Pick<ChildFactoryInput, "trustedInstructions" | "skills" | "policy" | "taskUserContent">> = {}
): Promise<ChildFactoryInput> {
  return {
    config,
    target,
    catalog: await loadRuntimeCatalog(config, {
      directory: process.cwd(),
      trustedAdjacentMetadata: false
    }),
    trustedInstructions: ["Trusted global instruction."],
    skills: SKILLS,
    policy: policy(["read_file"]),
    taskUserContent: "Inspect only the focused task.",
    ...overrides
  };
}

function addRoutingModels(config: StrongCodeConfig): void {
  config.models = {
    default: { provider: "mock", model: "default", displayName: "Default", enabled: true },
    explicit: { provider: "mock", model: "explicit", displayName: "Explicit", enabled: false },
    fallback: { provider: "mock", model: "fallback", displayName: "Fallback", enabled: true },
    flash: { provider: "mock", model: "gemini-flash", displayName: "Gemini Flash", enabled: true },
    ultra: { provider: "mock", model: "gpt-5.6-sol-ultra", displayName: "GPT 5.6 SOL Ultra", enabled: true }
  };
  config.agents.default.model = "default";
}

function addEnsembleModels(config: StrongCodeConfig): void {
  config.models = Object.fromEntries([1, 2, 3, 4].map(index => [`mock-${index}`, {
    provider: "mock",
    model: `brain-${index}`,
    displayName: `Brain ${index}`,
    enabled: true
  }]));
  config.agents.default.model = "mock-1";
}

beforeEach(() => {
  providerSpy.mockClear();
  configuredRouteSpy.mockClear();
});

describe("child agent factory", () => {
  it("fails a disabled helper before model routing or provider construction", async () => {
    // Given
    const config = testConfig(process.cwd());
    const request = await input(config, { kind: "helper", id: "build" });
    providerSpy.mockClear();
    configuredRouteSpy.mockClear();

    // When / Then
    expect(() => createChildAgent(request)).toThrowError(expect.objectContaining({ code: "HELPER_DISABLED" }));
    expect(configuredRouteSpy).not.toHaveBeenCalled();
    expect(providerSpy).not.toHaveBeenCalled();
  });

  it("uses helper override, fallback, canonical preference, configured default, and runnable fallback routing", async () => {
    // Given
    const config = testConfig(process.cwd());
    addRoutingModels(config);

    // When
    config.helpers = { explore: { model: "fallback", fallbackModels: [] } };
    const explicit = createChildAgent(await input(config, { kind: "helper", id: "explore" }));
    config.helpers = {
      explore: { model: "explicit", fallbackModels: ["fallback"] }
    };
    const fallback = createChildAgent(await input(config, { kind: "helper", id: "explore" }));
    config.helpers = {};
    const preferredExplore = createChildAgent(await input(config, { kind: "helper", id: "explore" }));
    const oracle = createChildAgent(await input(config, { kind: "helper", id: "oracle" }));
    config.helpers = { explore: { model: "explicit", fallbackModels: [] } };
    config.models.flash.enabled = false;
    config.models.ultra.enabled = false;
    const configuredDefault = createChildAgent(await input(config, { kind: "helper", id: "explore" }));
    config.models.default.enabled = false;
    const runnableFallback = createChildAgent(await input(config, { kind: "helper", id: "explore" }));

    // Then
    expect(explicit.agent.modelResolution).toMatchObject({ modelId: "fallback", provenance: "agent-override" });
    expect(fallback.agent.modelResolution).toMatchObject({ modelId: "fallback", provenance: "user-fallback" });
    expect(preferredExplore.agent.modelResolution).toMatchObject({ modelId: "flash", preference: "Gemini Flash" });
    expect(oracle.agent.modelResolution).toMatchObject({ modelId: "ultra", preference: "GPT 5.6 SOL Ultra" });
    expect(configuredDefault.agent.modelResolution).toMatchObject({ modelId: "default", provenance: "configured-default" });
    expect(runnableFallback.agent.modelResolution).toMatchObject({ modelId: "fallback", provenance: "available-fallback" });
  });

  it("keeps reserved helper identities separate from primary aliases when explicitly enabled", async () => {
    // Given
    const config = testConfig(process.cwd());
    config.helpers = {
      plan: { enabled: true, model: "mock" },
      build: { enabled: true, model: "mock" },
      general: { enabled: true, model: "mock" }
    };

    // When
    const children = await Promise.all((["plan", "build", "general"] as const).map(async id => (
      createChildAgent(await input(config, { kind: "helper", id }))
    )));

    // Then
    expect(children.map(child => child.agent.name)).toEqual(["plan", "build", "general"]);
    expect(children.map(child => child.agent.runtimeRole)).toEqual(["child", "child", "child"]);
    expect(children.map(child => child.agent.displayName)).toEqual(["Plan", "Build", "General"]);
  });

  it("orders trusted instructions, role prompt, skill Markdown, and the final immutable safety footer", async () => {
    // Given
    const config = testConfig(process.cwd());
    const taskUserContent = "TASK_PACKET_MUST_STAY_USER_CONTENT";

    // When
    const child = createChildAgent(await input(config, { kind: "helper", id: "explore" }, {
      trustedInstructions: ["GLOBAL_FIRST"],
      taskUserContent
    }));
    const systemPrompt = child.agent.systemPrompt ?? "";

    // Then
    expect(systemPrompt.indexOf("GLOBAL_FIRST")).toBeLessThan(systemPrompt.indexOf("Inspect the requested code area"));
    expect(systemPrompt.indexOf("Inspect the requested code area")).toBeLessThan(systemPrompt.indexOf("SKILL_OK"));
    expect(systemPrompt.indexOf("SKILL_OK")).toBeLessThan(systemPrompt.indexOf(CHILD_SAFETY_FOOTER));
    expect(systemPrompt.endsWith(CHILD_SAFETY_FOOTER)).toBe(true);
    expect(systemPrompt).not.toContain(taskUserContent);
    expect(child.task).toEqual({ role: "user", content: taskUserContent });
  });

  it("builds all six specialists as child identities with attenuated non-delegating tools", async () => {
    // Given
    const config = testConfig(process.cwd());
    addEnsembleModels(config);
    const effectivePolicy = policy(["read_file", "write_file", "delegate_task", "mcp__server__worker"]);

    // When
    const children = await Promise.all(SPECIALIST_AGENT_IDS.map(async id => (
      createChildAgent(await input(config, { kind: "specialist", id }, { policy: effectivePolicy }))
    )));

    // Then
    expect(children.map(child => child.agent.name)).toEqual(SPECIALIST_AGENT_IDS);
    expect(children.every(child => child.agent.runtimeRole === "child")).toBe(true);
    expect(children.every(child => !child.agent.config.tools.some(tool => /delegate_task|worker/u.test(tool)))).toBe(true);
    expect(children.find(child => child.agent.name === "government")?.agent.config.tools).toEqual(["read_file"]);
    expect(children.find(child => child.agent.name === "steve-jobs")?.agent.config.tools).toEqual(["read_file", "write_file"]);
  });

  it("keeps Hood as a four-distinct-model ensemble child", async () => {
    // Given
    const config = testConfig(process.cwd());
    addEnsembleModels(config);

    // When
    const child = createChildAgent(await input(config, { kind: "specialist", id: "hood-research-department" }));

    // Then
    expect(child.agent.model).toBeInstanceOf(EnsembleModelProvider);
    expect(child.agent.definition?.orchestration.minimumDistinctModels).toBe(4);
    expect(providerSpy).toHaveBeenCalledTimes(4);
  });

  it("returns frozen effective configuration, policy, task content, and skill receipts", async () => {
    // Given
    const config = testConfig(process.cwd());

    // When
    const child = createChildAgent(await input(config, { kind: "helper", id: "explore" }));

    // Then
    expect(Object.isFrozen(child)).toBe(true);
    expect(Object.isFrozen(child.agent.config)).toBe(true);
    expect(Object.isFrozen(child.agent.config.tools)).toBe(true);
    expect(Object.isFrozen(child.policy)).toBe(true);
    expect(Object.isFrozen(child.policy.permissions)).toBe(true);
    expect(Object.isFrozen(child.policy.tools)).toBe(true);
    expect(Object.isFrozen(child.task)).toBe(true);
    expect(Object.isFrozen(child.skillReceipts)).toBe(true);
    expect(Object.isFrozen(child.skillReceipts[0])).toBe(true);
  });
});
