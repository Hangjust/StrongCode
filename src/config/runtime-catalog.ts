import path from "node:path";
import { z } from "zod";
import { HELPER_DEFINITIONS, type HelperBackstagePolicy, type HelperId, type HelperModelPreference } from "../agents/helper-registry";
import { StrongCodeError } from "../core/errors";
import type { PathReceipt } from "../core/path-identity";
import type { StrongCodeConfig } from "./schema";
import { readTrustedHomeFile } from "./trusted-home-file";
import {
  categoryOverrideSchema,
  categoryOverridesSchema,
  delegationDefaults,
  runtimeConfigSourceSchema,
  type CategoryOverride,
  type DelegationConfig,
  type HelperOverride,
} from "./runtime-config";

const MAX_ADJACENT_METADATA_BYTES = 1024 * 1024;

const trustedCategoryEntrySchema = categoryOverrideSchema.extend({
  description: z.string().max(4_096).optional()
}).strict().transform(({ description: _description, ...operational }) => operational);

const trustedCategoriesMetadataSchema = z.object({
  version: z.literal(1),
  categories: z.record(z.string(), trustedCategoryEntrySchema).optional()
}).passthrough();

export type RuntimeHelper = {
  readonly id: HelperId;
  readonly displayName: string;
  readonly description: string;
  readonly backstagePolicy: HelperBackstagePolicy;
  readonly modelPreferences: readonly HelperModelPreference[];
  readonly systemPrompt: string;
  readonly enabled: boolean;
  readonly model?: string;
  readonly fallbackModels: readonly string[];
  readonly tools: readonly string[];
  readonly maxSteps?: number;
  readonly timeoutMs: number;
};

export type RuntimeCatalog = {
  readonly delegation: DelegationConfig;
  readonly helpers: Readonly<Record<string, RuntimeHelper>>;
  readonly categories: Readonly<Record<string, CategoryOverride>>;
};

export type RuntimeCatalogLoadOptions = {
  readonly directory: string;
  readonly trustedAdjacentMetadata: boolean;
  readonly automaticHomeReceipt?: PathReceipt;
  readonly configSource?: unknown;
};

async function readAdjacentJson(
  directory: string,
  fileName: string,
  automaticHomeReceipt: PathReceipt | undefined
): Promise<unknown | undefined> {
  const filePath = path.join(directory, fileName);
  try {
    const bytes = await readTrustedHomeFile(filePath, {
      automaticHomeReceipt,
      maxBytes: BigInt(MAX_ADJACENT_METADATA_BYTES)
    });
    return bytes === undefined ? undefined : JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new StrongCodeError("CONFIG_ERROR", `Failed to read trusted metadata ${filePath}: ${message}`);
  }
}

function parseMetadata<T>(schema: z.ZodType<T>, value: unknown, fileName: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  throw new StrongCodeError("CONFIG_ERROR", `Invalid trusted metadata ${fileName}: ${issues}`);
}

function assertHelperTools(helperId: HelperId, requested: readonly string[] | undefined, ceiling: readonly string[]): void {
  if (!requested) return;
  const excessive = requested.find(tool => !ceiling.includes(tool));
  if (excessive) {
    throw new StrongCodeError("CONFIG_ERROR", `Helper '${helperId}' tool '${excessive}' exceeds its canonical tool ceiling`);
  }
}

function assertConfiguredModels(config: StrongCodeConfig, helperId: HelperId, override: HelperOverride): void {
  for (const model of [override.model, ...(override.fallbackModels ?? [])]) {
    if (model && !Object.hasOwn(config.models, model)) {
      throw new StrongCodeError("CONFIG_ERROR", `Helper '${helperId}' model '${model}' is not defined`);
    }
  }
}

function mergeCategoryLayers(
  lower: Readonly<Record<string, CategoryOverride>> | undefined,
  higher: Readonly<Record<string, CategoryOverride>> | undefined
): Record<string, CategoryOverride> {
  const categoryIds = new Set([...Object.keys(lower ?? {}), ...Object.keys(higher ?? {})]);
  return Object.fromEntries([...categoryIds].map(categoryId => [categoryId, {
    ...lower?.[categoryId],
    ...higher?.[categoryId]
  }]));
}

function assertCategoryModels(config: StrongCodeConfig, categories: Readonly<Record<string, CategoryOverride>>): void {
  for (const [categoryId, category] of Object.entries(categories)) {
    for (const model of [category.model, ...(category.fallbackModels ?? [])]) {
      if (model && !Object.hasOwn(config.models, model)) {
        throw new StrongCodeError("CONFIG_ERROR", `Category '${categoryId}' model '${model}' is not defined`);
      }
    }
  }
}

function runtimeHelper(config: StrongCodeConfig, definition: (typeof HELPER_DEFINITIONS)[number], override: HelperOverride, timeoutMs: number): RuntimeHelper {
  assertHelperTools(definition.id, override.tools, definition.toolCeiling.tools);
  assertConfiguredModels(config, definition.id, override);
  return Object.freeze({
    id: definition.id,
    displayName: definition.displayName,
    description: definition.description,
    backstagePolicy: definition.backstagePolicy,
    modelPreferences: definition.modelPreferences,
    systemPrompt: definition.systemPrompt,
    enabled: override.enabled ?? definition.enabledByDefault,
    model: override.model,
    fallbackModels: Object.freeze([...(override.fallbackModels ?? [])]),
    tools: Object.freeze([...(override.tools ?? definition.toolCeiling.tools)]),
    maxSteps: override.maxSteps,
    timeoutMs: override.timeoutMs ?? timeoutMs
  });
}

async function trustedCategories(
  config: StrongCodeConfig,
  options: RuntimeCatalogLoadOptions
): Promise<Readonly<Record<string, CategoryOverride>> | undefined> {
  if (!options.trustedAdjacentMetadata) return undefined;
  const value = await readAdjacentJson(options.directory, "categories.json", options.automaticHomeReceipt);
  if (value === undefined) return undefined;
  const categories = parseMetadata(trustedCategoriesMetadataSchema, value, "categories.json").categories;
  if (categories === undefined) return undefined;
  return Object.fromEntries(Object.entries(categories).map(([categoryId, category]) => {
    const { model, fallbackModels, ...nonModelFields } = category;
    return [categoryId, {
      ...nonModelFields,
      ...(model !== undefined && Object.hasOwn(config.models, model) ? { model } : {}),
      ...(fallbackModels === undefined ? {} : {
        fallbackModels: fallbackModels.filter(fallback => Object.hasOwn(config.models, fallback))
      })
    }];
  }));
}

export async function loadRuntimeCatalog(config: StrongCodeConfig, options: RuntimeCatalogLoadOptions): Promise<RuntimeCatalog> {
  const adjacentCategories = await trustedCategories(config, options);
  const configured = parseMetadata(runtimeConfigSourceSchema, options.configSource ?? {
    helpers: config.helpers ?? {},
    delegation: config.delegation ?? delegationDefaults,
    categories: config.categories ?? {}
  }, "strongcode.config.yaml");
  const delegation = Object.freeze({ ...delegationDefaults, ...configured.delegation });
  const helperEntries = HELPER_DEFINITIONS.map(definition => {
    const override = configured.helpers?.[definition.id] ?? {};
    return [definition.id, runtimeHelper(config, definition, override, delegation.defaultTimeoutMs)] as const;
  });
  const categories = categoryOverridesSchema.parse(mergeCategoryLayers(adjacentCategories, configured.categories));
  assertCategoryModels(config, categories);
  return Object.freeze({
    delegation,
    helpers: Object.freeze(Object.fromEntries(helperEntries)),
    categories: Object.freeze(categories)
  });
}
