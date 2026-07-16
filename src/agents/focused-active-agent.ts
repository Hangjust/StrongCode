import type { Agent } from "./agent";
import { firstUnavailableExactModel, modelRoutingAgentConfig, resolveAgentModel } from "./model-routing";
import { getAgentDefinition } from "./registry";
import { categoryOverrideSchema, type CategoryOverride } from "../config/runtime-config";
import { StrongCodeError } from "../core/errors";
import { isModelProviderConstructable } from "../models/factory";
import { createAgent, type CreateAgentOptions } from "../runtime/factory";
import type { EffectiveToolPermission } from "../runtime/context";
import { resolveSkills, type SkillReceipt } from "../skills/resolver";
import { renderTaskPacket, type TaskPacket } from "./task-packet";
import {
  snapshotFocusedActivationInput,
  type FocusedActivationAuthorityInput,
  type FocusedActivationInput,
  type FocusedActivationSnapshot
} from "./focused-activation-input";

export type { FocusedActivationAuthorityInput, FocusedActivationInput } from "./focused-activation-input";

type FocusedAgentId = "tesla" | "bob-the-builder";

export type FocusedPolicy = {
  readonly tools: readonly string[];
  readonly permissions: Readonly<Record<string, EffectiveToolPermission>>;
};

export type FocusedTaskUserContent = {
  readonly role: "user";
  readonly content: string;
};

export type FocusedModelRoute = {
  readonly categoryId?: string;
  readonly provenance: "active-agent" | "category-model" | "category-fallback";
};

export type FocusedActiveAgent = {
  readonly activeAgentId: FocusedAgentId;
  readonly task: FocusedTaskUserContent;
  readonly packet: TaskPacket;
  readonly category?: CategoryOverride;
  readonly policy: FocusedPolicy;
  readonly skillMarkdown: string;
  readonly skillReceipts: readonly SkillReceipt[];
};

export type ActivatedFocusedAgent = FocusedActiveAgent & {
  readonly agent: Agent;
  readonly modelRoute: FocusedModelRoute;
};

function denyCategory(message: string): never {
  throw new StrongCodeError("CATEGORY_POLICY_DENIED", message);
}

function focusedAgentId(activeAgentId: string): FocusedAgentId {
  if (activeAgentId === "tesla" || activeAgentId === "bob-the-builder") return activeAgentId;
  return denyCategory("Category profiles may be used only by the active Tesla or an explicitly approved Bob The Builder.");
}

function freezeCategory(category: CategoryOverride): CategoryOverride {
  const fallbackModels = category.fallbackModels ? [...category.fallbackModels] : undefined;
  const tools = category.tools ? [...category.tools] : undefined;
  const skills = category.skills ? [...category.skills] : undefined;
  if (fallbackModels) Object.freeze(fallbackModels);
  if (tools) Object.freeze(tools);
  if (skills) Object.freeze(skills);
  return Object.freeze({
    ...category,
    ...(fallbackModels ? { fallbackModels } : {}),
    ...(tools ? { tools } : {}),
    ...(skills ? { skills } : {})
  });
}

function selectedCategory(snapshot: FocusedActivationSnapshot, agentId: FocusedAgentId): CategoryOverride | undefined {
  const categoryId = snapshot.task.categoryId;
  if (!categoryId) return undefined;
  if (agentId === "bob-the-builder" && snapshot.authority.approvedPlanExecution !== true) {
    return denyCategory("Category profiles cannot approve Bob The Builder or restore write access to an unapproved Bob.");
  }
  const parsed = categoryOverrideSchema.safeParse(snapshot.authority.categories[categoryId]);
  if (!parsed.success) {
    return denyCategory(`Category '${categoryId}' is missing, invalid, or requests unsupported authority.`);
  }
  return freezeCategory(parsed.data);
}

function reducedTools(baseTools: readonly string[], category: CategoryOverride | undefined): readonly string[] {
  if (!category?.tools) return Object.freeze([...baseTools]);
  const excessive = category.tools.find(tool => !baseTools.includes(tool));
  if (excessive) return denyCategory(`Category tool '${excessive}' expands the active agent tool policy.`);
  return Object.freeze(baseTools.filter(tool => category.tools?.includes(tool)));
}

function focusedPolicy(baseTools: readonly string[], tools: readonly string[]): FocusedPolicy {
  const permissions: Record<string, EffectiveToolPermission> = {};
  for (const tool of baseTools) permissions[tool] = tools.includes(tool) ? "allow" : "deny";
  return Object.freeze({ tools: Object.freeze([...tools]), permissions: Object.freeze(permissions) });
}

function modelRoute(categoryId: string | undefined, category: CategoryOverride | undefined, agent: Agent): FocusedModelRoute {
  if (categoryId && category?.model === agent.modelResolution?.modelId) {
    return Object.freeze({ categoryId, provenance: "category-model" });
  }
  if (categoryId && category?.fallbackModels?.includes(agent.modelResolution?.modelId ?? "")) {
    return Object.freeze({ categoryId, provenance: "category-fallback" });
  }
  return Object.freeze({ provenance: "active-agent" });
}

function withSkillMarkdown(agent: Agent, markdown: string): Agent {
  if (!markdown) return Object.freeze({ ...agent });
  return Object.freeze({ ...agent, systemPrompt: [agent.systemPrompt, markdown].filter(Boolean).join("\n\n") });
}

function createOptions(authority: FocusedActivationAuthorityInput): CreateAgentOptions {
  return {
    modelFetch: authority.modelFetch,
    chatGptFetch: authority.chatGptFetch,
    authStore: authority.authStore,
    allowEnvironmentCredentials: authority.allowEnvironmentCredentials,
    workspaceRoot: authority.workspaceRoot,
    approvedPlanExecution: authority.approvedPlanExecution
  };
}

export async function activateFocusedAgent(input: FocusedActivationInput): Promise<ActivatedFocusedAgent> {
  const snapshot = snapshotFocusedActivationInput(input);
  const agentId = focusedAgentId(snapshot.authority.activeAgentId);
  const category = selectedCategory(snapshot, agentId);
  const definition = getAgentDefinition(agentId);
  if (!definition) return denyCategory(`Active agent '${agentId}' is not registered.`);
  const activeConfig = modelRoutingAgentConfig(snapshot.authority.config, definition);
  const baseTools = activeConfig.tools;
  const tools = reducedTools(baseTools, category);
  const policy = focusedPolicy(baseTools, tools);
  const skillIds = Object.freeze([...(category?.skills ?? []), ...snapshot.task.requestedSkills]);
  const focusedAgentConfig = {
    ...activeConfig,
    model: category?.model ?? activeConfig.model,
    tools: [...tools],
    ...(category?.fallbackModels ? { fallbackModels: [...category.fallbackModels] } : {})
  };
  const focusedConfig = {
    ...snapshot.authority.config,
    agents: {
      ...snapshot.authority.config.agents,
      [agentId]: focusedAgentConfig
    }
  };
  const unavailableModel = firstUnavailableExactModel(
    snapshot.authority.config,
    [focusedAgentConfig.model, ...(focusedAgentConfig.fallbackModels ?? [])],
    snapshot.authority.allowEnvironmentCredentials
  );
  if (unavailableModel) {
    return denyCategory(`Focused route references unavailable model '${unavailableModel}'.`);
  }
  const resolvedModel = resolveAgentModel(focusedConfig, definition, {
    providerIsRunnable: (providerId, providerConfig) => isModelProviderConstructable({
      providerId,
      providerConfig,
      allowEnvironmentCredentials: snapshot.authority.allowEnvironmentCredentials
    })
  });
  if (resolvedModel.modelId !== focusedAgentConfig.model) {
    return denyCategory(`Focused route did not resolve exact model '${focusedAgentConfig.model}'.`);
  }
  const skills = await resolveSkills(skillIds, { ...snapshot.authority.skillOptions, targetAgent: agentId });
  const task = Object.freeze({ role: "user" as const, content: renderTaskPacket(snapshot.task.packet) });
  const agent = withSkillMarkdown(createAgent(
    focusedConfig,
    agentId,
    createOptions(snapshot.authority)
  ), skills.content);
  return Object.freeze({
    activeAgentId: agentId,
    task,
    packet: snapshot.task.packet,
    ...(category ? { category } : {}),
    policy,
    skillMarkdown: skills.content,
    skillReceipts: Object.freeze(skills.receipts.map(receipt => Object.freeze({ ...receipt }))),
    agent,
    modelRoute: modelRoute(snapshot.task.categoryId, category, agent)
  });
}
