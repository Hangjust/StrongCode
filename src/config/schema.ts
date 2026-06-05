import { z } from "zod";
import { mockProviderDefaults } from "../models/registry";
import { isSecretLikeConfigKey, looksLikeProviderApiKeyEnv } from "./security";
import { parseProviderBaseUrl, validateProviderModelsEndpoint } from "../models/provider-url";

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
  tools: z.array(z.string().min(1)).default([])
});

const providerConfigBaseSchema = z.object({
  type: z.string().min(1),
  displayName: z.string().min(1),
  apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*_API_KEY$/, "Use an API-key environment variable name such as OPENAI_API_KEY").optional(),
  baseUrl: z.string().min(1).optional(),
  modelsEndpoint: z.string().startsWith("/").optional(),
  enabled: z.boolean().optional()
}).passthrough();

export const providerConfigSchema = providerConfigBaseSchema.superRefine((provider, context) => {
  rejectSecretLikeKeys(provider, context);
  validateProviderBaseUrl(provider.baseUrl, context);
  validateModelsEndpoint(provider.modelsEndpoint, context);
  if (provider.apiKeyEnv && !looksLikeProviderApiKeyEnv(provider.apiKeyEnv)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["apiKeyEnv"],
      message: "Use an API-key environment variable name such as OPENAI_API_KEY"
    });
  }
}).transform(provider => ({
  type: provider.type,
  displayName: provider.displayName,
  apiKeyEnv: provider.apiKeyEnv,
  baseUrl: provider.baseUrl,
  modelsEndpoint: provider.modelsEndpoint,
  enabled: provider.enabled
}));

const modelConfigBaseSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  source: z.string().min(1).optional(),
  options: z.record(z.unknown()).optional()
}).passthrough();

export const modelConfigSchema = modelConfigBaseSchema.superRefine((model, context) => {
  rejectSecretLikeKeys(model, context);
}).transform(model => ({
  provider: model.provider,
  model: model.model,
  displayName: model.displayName,
  enabled: model.enabled,
  source: model.source,
  options: model.options
}));

export const strongCodeConfigSchema = z.object({
  version: z.literal(1),
  workspace: z.string().min(1).default("."),
  dataDir: z.string().min(1).default(".strongcode"),
  defaultAgent: z.string().min(1),
  providers: z.record(providerConfigSchema).optional(),
  agents: z.record(agentConfigSchema),
  models: z.record(modelConfigSchema),
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
}).transform(config => ({
  ...config,
  providers: config.providers ?? mockProviderDefaults()
}));

export type PermissionDecision = z.infer<typeof permissionDecisionSchema>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type ModelConfig = z.infer<typeof modelConfigSchema>;
export type StrongCodeConfig = z.infer<typeof strongCodeConfigSchema>;
