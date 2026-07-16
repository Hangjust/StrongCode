import { z } from "zod";
import { HELPER_IDS, type HelperId } from "../agents/helper-registry";

const operationalReferenceSchema = z.string()
  .min(1)
  .max(512)
  .refine(value => value === value.trim(), "References must not have surrounding whitespace")
  .refine(value => !/[\p{Cc}\p{Cf}]/u.test(value), "References must not contain control characters");

const operationalReferencesSchema = z.array(operationalReferenceSchema).max(64)
  .refine(values => new Set(values).size === values.length, "References must be unique");

const categorySkillReferencesSchema = z.array(operationalReferenceSchema).max(8)
  .refine(values => new Set(values).size === values.length, "Category skills must be unique");

export const helperOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  model: operationalReferenceSchema.optional(),
  fallbackModels: operationalReferencesSchema.optional(),
  tools: operationalReferencesSchema.optional(),
  maxSteps: z.number().int().min(1).max(100).optional(),
  timeoutMs: z.number().int().min(1).max(86_400_000).optional()
}).strict();

export const helperOverridesSchema = z.record(z.enum(HELPER_IDS), helperOverrideSchema).default({});

export const delegationDefaults = Object.freeze({
  enabled: true,
  maxActive: 4,
  maxChildrenPerRoot: 16,
  defaultTimeoutMs: 600_000,
  maxInlineResultChars: 12_000
});

export const delegationOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  maxActive: z.number().int().min(1).max(64).optional(),
  maxChildrenPerRoot: z.number().int().min(1).max(1_024).optional(),
  defaultTimeoutMs: z.number().int().min(1).max(86_400_000).optional(),
  maxInlineResultChars: z.number().int().min(1).max(1_000_000).optional()
}).strict();

export const delegationConfigSchema = delegationOverrideSchema
  .transform(override => ({ ...delegationDefaults, ...override }))
  .default(delegationDefaults);

export const categoryOverrideSchema = z.object({
  model: operationalReferenceSchema.optional(),
  fallbackModels: operationalReferencesSchema.optional(),
  tools: operationalReferencesSchema.optional(),
  skills: categorySkillReferencesSchema.optional(),
  maxSteps: z.number().int().min(1).max(100).optional(),
  timeoutMs: z.number().int().min(1).max(86_400_000).optional()
}).strict();

const categoryIdSchema = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/u);

export const categoryOverridesSchema = z.record(categoryIdSchema, categoryOverrideSchema).default({});

export const runtimeConfigSourceSchema = z.object({
  helpers: helperOverridesSchema.optional(),
  delegation: delegationOverrideSchema.optional(),
  categories: categoryOverridesSchema.optional()
}).passthrough();

export type HelperOverride = z.infer<typeof helperOverrideSchema>;
export type DelegationConfig = z.infer<typeof delegationConfigSchema>;
export type DelegationOverride = z.infer<typeof delegationOverrideSchema>;
export type CategoryOverride = z.infer<typeof categoryOverrideSchema>;
export type RuntimeConfigSource = z.infer<typeof runtimeConfigSourceSchema>;

type RuntimeModelReferenceConfig = {
  readonly models: Readonly<Record<string, unknown>>;
  readonly helpers: Partial<Record<HelperId, HelperOverride>>;
  readonly categories: Readonly<Record<string, CategoryOverride>>;
};

export function validateRuntimeModelReferences(config: RuntimeModelReferenceConfig, context: z.RefinementCtx): void {
  for (const [helperId, helper] of Object.entries(config.helpers)) {
    if (helper.model && !Object.hasOwn(config.models, helper.model)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["helpers", helperId, "model"],
        message: `Helper '${helperId}' model '${helper.model}' is not defined`
      });
    }
    (helper.fallbackModels ?? []).forEach((modelName, index) => {
      if (!Object.hasOwn(config.models, modelName)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["helpers", helperId, "fallbackModels", index],
          message: `Helper '${helperId}' fallback model '${modelName}' is not defined`
        });
      }
    });
  }

  for (const [categoryId, category] of Object.entries(config.categories)) {
    if (category.model && !Object.hasOwn(config.models, category.model)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["categories", categoryId, "model"],
        message: `Category '${categoryId}' model '${category.model}' is not defined`
      });
    }
    (category.fallbackModels ?? []).forEach((modelName, index) => {
      if (!Object.hasOwn(config.models, modelName)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["categories", categoryId, "fallbackModels", index],
          message: `Category '${categoryId}' fallback model '${modelName}' is not defined`
        });
      }
    });
  }
}
