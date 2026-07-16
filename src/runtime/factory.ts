import { loadConfig } from "../config/load";
import { StrongCodeConfig } from "../config/schema";
import { StrongCodeError } from "../core/errors";
import { Agent } from "../agents/agent";
import { createModelProvider } from "../models/factory";
import { OpenAICompatibleFetcher } from "../models/openai-compatible-provider";
import { resolveRuntimeAuthDataDir, type ProviderAuthReader } from "../models/auth-store";
import { createRuntimeContext, RuntimeContext } from "./context";
import path from "node:path";
import { strongCodeHomePath } from "../config/paths";
import { loadAgentInstructions } from "../config/instructions";
import { modelRoutingAgentConfig, resolveAgentModel, resolveAgentModelSet } from "../agents/model-routing";
import { resolveDirectAgentDefinition } from "../agents/spawn-targets";
import { getAgentDefinition } from "../agents/registry";
import { EnsembleModelProvider } from "../models/ensemble-provider";
import { realpath } from "node:fs/promises";
import { providerDefaults } from "../models/registry";
import { parseProviderBaseUrl } from "../models/provider-url";
import { AUDITED_READ_ONLY_TOOL_PATTERNS } from "../tools/defaults";
import type { ChatGptOAuthFetch } from "../models/chatgpt-oauth";
import { deriveConfigTrust } from "./config-trust";
import { RuntimeAgentRunnerFactory } from "./runner-factory";

export interface CreateAgentOptions {
  modelFetch?: OpenAICompatibleFetcher;
  chatGptFetch?: ChatGptOAuthFetch;
  authStore?: ProviderAuthReader;
  systemPrompt?: string;
  allowEnvironmentCredentials?: boolean;
  allowConfiguredSystemPrompt?: boolean;
  approvedPlanExecution?: boolean;
  restrictToReadOnlyTools?: boolean;
  workspaceRoot?: string;
}

export interface RequiredRuntime {
  config: StrongCodeConfig;
  context: RuntimeContext;
  authDataDir: string;
  systemPrompt?: string;
  /** True only for the canonical user-owned home config or an explicit project trust opt-in. */
  trustedConfig: boolean;
  /** Repository instructions require a separate explicit opt-in, even with the home config. */
  trustedProjectInstructions: boolean;
  runnerFactory: RuntimeAgentRunnerFactory;
}

const ALWAYS_READ_ONLY_STRATEGIES = new Set(["plan-only", "ensemble", "security", "marketing", "engagement", "monetization"]);

function normalizedProviderOrigin(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  const parsed = parseProviderBaseUrl(baseUrl, "provider identity validation");
  return `${parsed.protocol}//${parsed.host}`.toLowerCase();
}

function pathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function canonicalPotentialPath(target: string): Promise<string> {
  const suffix: string[] = [];
  let cursor = path.resolve(target);
  while (true) {
    try {
      const existing = await realpath(cursor);
      return path.join(existing, ...suffix.reverse());
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) return path.resolve(target);
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function assertImplicitProjectPaths(config: StrongCodeConfig, configDirectory: string): Promise<void> {
  const projectRoot = await canonicalPotentialPath(configDirectory);
  const workspace = await canonicalPotentialPath(path.resolve(configDirectory, config.workspace));
  const dataDir = await canonicalPotentialPath(path.resolve(configDirectory, config.dataDir));
  const home = await canonicalPotentialPath(path.resolve(strongCodeHomePath()));
  if (!pathInside(projectRoot, workspace)) {
    throw new StrongCodeError("CONFIG_ERROR", "An implicitly loaded project config cannot move workspace outside the project. Pass --config explicitly to trust it.");
  }
  if (!pathInside(projectRoot, dataDir) || pathInside(home, dataDir)) {
    throw new StrongCodeError("CONFIG_ERROR", "An implicitly loaded project config must keep dataDir inside the project and outside StrongCode home. Pass --config explicitly to trust it.");
  }
}

function restrictImplicitProjectConfig(config: StrongCodeConfig): StrongCodeConfig {
  const builtIns = providerDefaults();
  for (const [providerId, provider] of Object.entries(config.providers)) {
    if (provider.enabled !== false && (["chatgpt", "codex-cli", "google-vertex"].includes(provider.type))) {
      throw new StrongCodeError("CONFIG_ERROR", `Implicit project config cannot use user-account provider '${providerId}'. Pass --config explicitly or set STRONGCODE_TRUST_PROJECT_CONFIG=1.`);
    }
    const expected = builtIns[providerId];
    if (
      provider.enabled !== false
      && providerId !== "custom"
      && expected?.apiKeyEnv
      && (provider.type !== expected.type || normalizedProviderOrigin(provider.baseUrl) !== normalizedProviderOrigin(expected.baseUrl))
    ) {
      throw new StrongCodeError(
        "CONFIG_ERROR",
        `Implicit project config cannot redefine built-in provider '${providerId}' to a different type or origin. Use a custom provider id, pass --config explicitly, or set STRONGCODE_TRUST_PROJECT_CONFIG=1 after review.`
      );
    }
  }
  return {
    ...config,
    agents: Object.fromEntries(Object.entries(config.agents).map(([id, agent]) => [id, { ...agent, systemPrompt: undefined }])),
    permissions: {
      tools: Object.fromEntries(Object.entries(config.permissions.tools).map(([tool, decision]) => [
        tool,
        decision === "allow" && !AUDITED_READ_ONLY_TOOL_PATTERNS.has(tool) ? "ask" : decision
      ]))
    }
  };
}

export async function requireRuntime(configPath?: string): Promise<RequiredRuntime> {
  const loaded = await loadConfig(configPath);
  if (!loaded.ok) {
    throw loaded.error;
  }

  const environmentTrust = process.env.STRONGCODE_TRUST_PROJECT_CONFIG === "1";
  const trust = await deriveConfigTrust(loaded.value.source, environmentTrust);
  if (trust.implicitProject && !environmentTrust) {
    await assertImplicitProjectPaths(loaded.value.config, loaded.value.directory);
  }
  const runtimeConfig = trust.implicitProject && !environmentTrust
    ? restrictImplicitProjectConfig(loaded.value.config)
    : loaded.value.config;
  const context = createRuntimeContext(runtimeConfig, loaded.value.path, loaded.value.directory, {
    automaticHomeReceipt: trust.automaticHomeReceipt,
    workspaceRootOverride: trust.useCurrentWorkingDirectory ? process.cwd() : undefined
  });
  return {
    // Preserve the parsed source config for UI edits; execution uses the hardened context copy above.
    config: loaded.value.config,
    context,
    authDataDir: resolveRuntimeAuthDataDir(loaded.value.path, context.dataDir),
    systemPrompt: await loadAgentInstructions(context.workspaceRoot, undefined, {
      automaticHomeReceipt: trust.automaticHomeReceipt, includeProject: trust.trustedProjectInstructions
    }),
    trustedConfig: trust.trustedConfig,
    trustedProjectInstructions: trust.trustedProjectInstructions,
    runnerFactory: new RuntimeAgentRunnerFactory(context)
  };
}

export function createAgent(config: StrongCodeConfig, agentName: string, options: CreateAgentOptions = {}): Agent {
  const definition = getAgentDefinition(agentName);
  const configuredAgent = config.agents[agentName];
  if (!definition && !configuredAgent) resolveDirectAgentDefinition(agentName);
  const baseAgentConfig = definition ? modelRoutingAgentConfig(config, definition) : configuredAgent;
  if (!baseAgentConfig) {
    throw new StrongCodeError("CONFIG_ERROR", `Agent not found: ${agentName}`);
  }

  const modelResolution = definition ? resolveAgentModel(config, definition) : undefined;
  const resolvedAgentConfig = modelResolution ? { ...baseAgentConfig, model: modelResolution.modelId } : baseAgentConfig;
  const strategy = definition?.orchestration.strategy;
  const readOnlyByPolicy = options.restrictToReadOnlyTools === true
    || (strategy ? ALWAYS_READ_ONLY_STRATEGIES.has(strategy) : false)
    || (strategy === "execute-plan" && options.approvedPlanExecution !== true);
  const agentConfig = readOnlyByPolicy
    ? { ...resolvedAgentConfig, tools: resolvedAgentConfig.tools.filter(tool => AUDITED_READ_ONLY_TOOL_PATTERNS.has(tool)) }
    : resolvedAgentConfig;

  const modelConfig = config.models[agentConfig.model];
  if (!modelConfig) {
    throw new StrongCodeError("CONFIG_ERROR", `Model not found: ${agentConfig.model}`);
  }

  const providerConfig = config.providers[modelConfig.provider];
  if (!providerConfig) {
    throw new StrongCodeError("CONFIG_ERROR", `Provider not found: ${modelConfig.provider}`);
  }

  if (providerConfig.enabled === false) {
    throw new StrongCodeError("MODEL_ERROR", `Provider disabled: ${modelConfig.provider}`);
  }

  if (modelConfig.enabled === false) {
    throw new StrongCodeError("MODEL_ERROR", `Model disabled: ${agentConfig.model}`);
  }

  let provider = createModelProvider({
    providerId: modelConfig.provider,
    providerConfig,
    modelId: agentConfig.model,
    modelConfig,
    fetcher: options.modelFetch,
    chatGptFetch: options.chatGptFetch,
    authStore: options.authStore,
    allowEnvironmentCredentials: options.allowEnvironmentCredentials,
    cwd: options.workspaceRoot
  });

  if (definition?.orchestration.strategy === "ensemble") {
    const panel = resolveAgentModelSet(config, definition).map(resolution => {
      const panelProvider = config.providers[resolution.providerId];
      if (!panelProvider) throw new StrongCodeError("CONFIG_ERROR", `Provider not found: ${resolution.providerId}`);
      return {
        modelId: resolution.modelId,
        model: createModelProvider({
          providerId: resolution.providerId,
          providerConfig: panelProvider,
          modelId: resolution.modelId,
          modelConfig: resolution.model,
          fetcher: options.modelFetch,
          chatGptFetch: options.chatGptFetch,
          authStore: options.authStore,
          allowEnvironmentCredentials: options.allowEnvironmentCredentials,
          cwd: options.workspaceRoot
        })
      };
    });
    provider = new EnsembleModelProvider({
      panelists: panel,
      synthesizer: panel[0]?.model,
      minimumDistinctModels: definition.orchestration.minimumDistinctModels
    });
  }

  const configuredPrompt = options.allowConfiguredSystemPrompt === false ? undefined : agentConfig.systemPrompt?.trim();
  const configuredSection = configuredPrompt ? `User-configured agent addendum:\n${configuredPrompt}` : undefined;
  const systemPrompt = definition
    ? [options.systemPrompt, configuredSection, definition.systemPrompt].filter((value): value is string => Boolean(value?.trim())).join("\n\n") || undefined
    : [options.systemPrompt, configuredPrompt].filter((value): value is string => Boolean(value?.trim())).join("\n\n") || undefined;
  return {
    name: definition?.id ?? agentName,
    runtimeRole: "primary",
    toolPolicy: readOnlyByPolicy ? "read-only" : "standard",
    displayName: agentConfig.displayName ?? definition?.displayName ?? agentName,
    config: agentConfig,
    model: provider,
    systemPrompt,
    definition,
    modelResolution: modelResolution ?? {
      modelId: agentConfig.model,
      providerId: modelConfig.provider,
      model: modelConfig,
      provenance: "agent-override"
    }
  };
}

export { createPreflightAgent } from "../agents/preflight/factory";
export type { CreatePreflightAgentOptions } from "../agents/preflight/factory";
