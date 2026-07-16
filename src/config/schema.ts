import { z } from "zod";
import { mockProviderDefaults } from "../models/registry";
import { isSecretLikeConfigKey, looksLikeProviderApiKeyEnv } from "./security";
import { isLocalProviderBaseUrl, parseProviderBaseUrl, validateProviderModelsEndpoint } from "../models/provider-url";
import { preflightConfigSchema } from "../agents/preflight/config";
import { categoryOverridesSchema, delegationConfigSchema, helperOverridesSchema, validateRuntimeModelReferences } from "./runtime-config";
import { toolPatternSchema } from "../tools/pattern";

function validateProviderBaseUrl(value: string | undefined, context: z.RefinementCtx): void {
  if (!value) return;
  try {
    parseProviderBaseUrl(value, "provider config");
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["baseUrl"],
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

function validateModelsEndpoint(value: string | undefined, context: z.RefinementCtx): void {
  if (!value) return;
  try {
    validateProviderModelsEndpoint(value);
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["modelsEndpoint"],
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

function rejectSecretLikeKeys(value: unknown, context: z.RefinementCtx, path: (string | number)[] = []): void {
  if (!value || typeof value !== "object") {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((nestedValue, index) => rejectSecretLikeKeys(nestedValue, context, [...path, index]));
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const nestedPath = [...path, key];
    if (isSecretLikeConfigKey(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: nestedPath,
        message: `Do not store '${key}' in config; use an apiKeyEnv reference instead`
      });
    }

    rejectSecretLikeKeys(nestedValue, context, nestedPath);
  }
}

export const permissionDecisionSchema = z.enum(["allow", "ask", "deny"]);

export const agentConfigSchema = z.object({
  model: z.string().min(1),
  tools: z.array(toolPatternSchema).default([]),
  displayName: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  mode: z.enum(["primary", "specialist", "subagent"]).optional(),
  systemPrompt: z.string().min(1).optional(),
  fallbackModels: z.array(z.string().min(1)).optional(),
  skills: z.array(z.string().min(1)).optional(),
  hidden: z.boolean().optional()
});

const providerConfigBaseSchema = z.object({
  type: z.string().min(1),
  displayName: z.string().min(1),
  apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*_API_KEY$/, "Use an API-key environment variable name such as OPENAI_API_KEY").optional(),
  baseUrl: z.string().min(1).optional(),
  modelsEndpoint: z.string().startsWith("/").optional(),
  allowUnauthenticated: z.boolean().optional(),
  projectId: z.string().regex(/^[A-Za-z0-9._-]+$/).optional(),
  location: z.string().regex(/^[A-Za-z0-9._-]+$/).optional(),
  enabled: z.boolean().optional()
}).passthrough();

interface ProviderConfigValue {
  type: string;
  displayName: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  modelsEndpoint?: string;
  allowUnauthenticated?: boolean;
  projectId?: string;
  location?: string;
  enabled?: boolean;
}

export const providerConfigSchema = providerConfigBaseSchema.superRefine((provider, context) => {
  rejectSecretLikeKeys(provider, context);
  validateProviderBaseUrl(provider.baseUrl, context);
  validateModelsEndpoint(provider.modelsEndpoint, context);
  if (provider.allowUnauthenticated && !isLocalProviderBaseUrl(provider.baseUrl)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allowUnauthenticated"],
      message: "Unauthenticated providers are allowed only on localhost"
    });
  }
  if (provider.apiKeyEnv && !looksLikeProviderApiKeyEnv(provider.apiKeyEnv)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["apiKeyEnv"],
      message: "Use an API-key environment variable name such as OPENAI_API_KEY"
    });
  }
}).transform((provider): ProviderConfigValue => ({
  type: provider.type,
  displayName: provider.displayName,
  apiKeyEnv: provider.apiKeyEnv,
  baseUrl: provider.baseUrl,
  modelsEndpoint: provider.modelsEndpoint,
  allowUnauthenticated: provider.allowUnauthenticated,
  projectId: provider.projectId,
  location: provider.location,
  enabled: provider.enabled
}));

const modelPricingSchema = z.object({
  version: z.string().min(1),
  currency: z.string().regex(/^[A-Z]{3}$/),
  inputPerMillion: z.number().nonnegative().finite().optional(),
  outputPerMillion: z.number().nonnegative().finite().optional(),
  cacheReadPerMillion: z.number().nonnegative().finite().optional(),
  cacheWritePerMillion: z.number().nonnegative().finite().optional()
}).strict().superRefine((pricing, context) => {
  if ([pricing.inputPerMillion, pricing.outputPerMillion, pricing.cacheReadPerMillion, pricing.cacheWritePerMillion]
    .every(rate => rate === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Pricing must include at least one rate" });
  }
});

const modelConfigBaseSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  source: z.string().min(1).optional(),
  options: z.record(z.unknown()).optional(),
  contextWindowTokens: z.number().int().positive().safe().optional(),
  pricing: modelPricingSchema.optional()
}).passthrough();

interface ModelConfigValue {
  provider: string;
  model?: string;
  displayName?: string;
  enabled?: boolean;
  source?: string;
  options?: Record<string, unknown>;
  contextWindowTokens?: number;
  pricing?: z.infer<typeof modelPricingSchema>;
}

export const modelConfigSchema = modelConfigBaseSchema.superRefine((model, context) => {
  rejectSecretLikeKeys(model, context);
}).transform((model): ModelConfigValue => ({
  provider: model.provider,
  model: model.model,
  displayName: model.displayName,
  enabled: model.enabled,
  source: model.source,
  options: model.options,
  contextWindowTokens: model.contextWindowTokens,
  pricing: model.pricing
}));

export const strongCodeConfigSchema = z.object({
  version: z.literal(1),
  workspace: z.string().min(1).default("."),
  dataDir: z.string().min(1).default(".strongcode"),
  defaultAgent: z.string().min(1),
  providers: z.record(providerConfigSchema).optional(),
  agents: z.record(agentConfigSchema),
  models: z.record(modelConfigSchema),
  preflight: preflightConfigSchema.optional(),
  helpers: helperOverridesSchema,
  delegation: delegationConfigSchema,
  categories: categoryOverridesSchema,
  permissions: z.object({
    tools: z.record(permissionDecisionSchema).default({})
  }).default({ tools: {} })
}).superRefine((config, context) => {
  const providers = config.providers ?? mockProviderDefaults();

  if (!Object.hasOwn(config.agents, config.defaultAgent)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["defaultAgent"],
      message: `Default agent '${config.defaultAgent}' is not defined`
    });
  }

  for (const [agentName, agent] of Object.entries(config.agents)) {
    if (!Object.hasOwn(config.models, agent.model)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["agents", agentName, "model"],
        message: `Model '${agent.model}' is not defined`
      });
    }

    (agent.fallbackModels ?? []).forEach((modelName, index) => {
      if (!Object.hasOwn(config.models, modelName)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agents", agentName, "fallbackModels", index],
          message: `Fallback model '${modelName}' is not defined`
        });
      }
    });
  }

  for (const [modelName, model] of Object.entries(config.models)) {
    if (!Object.hasOwn(providers, model.provider)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["models", modelName, "provider"],
        message: `Provider '${model.provider}' is not defined`
      });
    }
  }

  validateRuntimeModelReferences(config, context);

  if (config.preflight) {
    const routes = [
      ["summary", config.preflight.summary],
      ["analysis", config.preflight.analysis],
      ["explorer", config.preflight.explorer]
    ] as const;
    for (const [role, route] of routes) {
      if (!route) continue;
      [route.model, ...route.fallbackModels].forEach((modelName, index) => {
        if (!Object.hasOwn(config.models, modelName)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["preflight", role, index === 0 ? "model" : "fallbackModels", index === 0 ? undefined : index - 1].filter(value => value !== undefined),
            message: `Preflight ${role} model '${modelName}' is not defined`
          });
        }
      });
    }
  }
}).transform(config => ({
  ...config,
  providers: config.providers ?? mockProviderDefaults()
}));

export type PermissionDecision = z.infer<typeof permissionDecisionSchema>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type ModelConfig = z.infer<typeof modelConfigSchema>;
type ParsedStrongCodeConfig = z.infer<typeof strongCodeConfigSchema>;
export type StrongCodeConfig = Omit<ParsedStrongCodeConfig, "helpers" | "delegation" | "categories"> &
  Partial<Pick<ParsedStrongCodeConfig, "helpers" | "delegation" | "categories">>;
