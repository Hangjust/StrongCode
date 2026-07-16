import { types } from "node:util";
import { z } from "zod";
import { categoryOverridesSchema, type CategoryOverride } from "../config/runtime-config";
import { strongCodeConfigSchema, type StrongCodeConfig } from "../config/schema";
import { StrongCodeError } from "../core/errors";
import type { ProviderAuthReader } from "../models/auth-store";
import type { ChatGptOAuthFetch } from "../models/chatgpt-oauth";
import type { OpenAICompatibleFetcher } from "../models/openai-compatible-provider";
import type { ResolveSkillsOptions } from "../skills/resolver";
import { parseTaskPacket, type TaskPacket } from "./task-packet";

const MAX_SNAPSHOT_ARRAY_ITEMS = 10_000;

const taskDataSchema = z.object({
  categoryId: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/u).optional(),
  requestedSkills: z.array(z.string().min(1).max(512)).max(8).default([])
}).strict();

const skillOptionsSchema = z.object({
  homeRoot: z.string().min(1).optional(),
  projectRoot: z.string().min(1).optional(),
  trustedProjectInstructions: z.boolean().optional()
}).strict();

const authorityDataSchema = z.object({
  config: strongCodeConfigSchema,
  activeAgentId: z.string().min(1),
  approvedPlanExecution: z.boolean().optional(),
  categories: categoryOverridesSchema.optional(),
  skillOptions: skillOptionsSchema.optional(),
  allowEnvironmentCredentials: z.boolean().optional(),
  workspaceRoot: z.string().min(1).optional()
}).strict();

const ROOT_KEYS = new Set(["task", "authority"]);
const TASK_KEYS = new Set(["categoryId", "taskPacket", "requestedSkills"]);
const AUTHORITY_KEYS = new Set([
  "config",
  "activeAgentId",
  "approvedPlanExecution",
  "categories",
  "skillOptions",
  "modelFetch",
  "chatGptFetch",
  "authStore",
  "allowEnvironmentCredentials",
  "workspaceRoot"
]);

export type FocusedActivationTaskInput = {
  readonly categoryId?: string;
  readonly taskPacket: unknown;
  readonly requestedSkills?: readonly string[];
};

export type FocusedActivationAuthorityInput = {
  readonly config: StrongCodeConfig;
  readonly activeAgentId: string;
  readonly approvedPlanExecution?: boolean;
  readonly categories?: Readonly<Record<string, CategoryOverride>>;
  readonly skillOptions?: Omit<ResolveSkillsOptions, "targetAgent">;
  readonly modelFetch?: OpenAICompatibleFetcher;
  readonly chatGptFetch?: ChatGptOAuthFetch;
  readonly authStore?: ProviderAuthReader;
  readonly allowEnvironmentCredentials?: boolean;
  readonly workspaceRoot?: string;
};

export type FocusedActivationInput = {
  readonly task: FocusedActivationTaskInput;
  readonly authority: FocusedActivationAuthorityInput;
};

export type FocusedActivationSnapshot = {
  readonly task: {
    readonly categoryId?: string;
    readonly packet: TaskPacket;
    readonly requestedSkills: readonly string[];
  };
  readonly authority: FocusedActivationAuthorityInput & {
    readonly categories: Readonly<Record<string, CategoryOverride>>;
  };
};

function denyInput(message: string): never {
  throw new StrongCodeError("CATEGORY_POLICY_DENIED", `Focused activation input ${message}`);
}

function inspectRecord(value: unknown, label: string, allowedKeys?: ReadonlySet<string>): Record<string, PropertyDescriptor> {
  if (!value || typeof value !== "object") return denyInput(`${label} must be a plain object.`);
  if (types.isProxy(value)) return denyInput(`${label} must not be a Proxy.`);
  if (Array.isArray(value)) return denyInput(`${label} must be a plain object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return denyInput(`${label} must use a plain-object prototype.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") return denyInput(`${label} must not contain symbol properties.`);
    const descriptor = descriptors[key];
    if (!descriptor) return denyInput(`${label}.${key} has no stable descriptor.`);
    if (allowedKeys && !allowedKeys.has(key)) return denyInput(`${label}.${key} is not allowed.`);
    if (!descriptor.enumerable) return denyInput(`${label}.${key} must be enumerable.`);
    if (!("value" in descriptor)) return denyInput(`${label}.${key} must not be an accessor.`);
  }
  return descriptors;
}

function inspectTypedRecord<T extends object>(
  value: T,
  label: string,
  allowedKeys: ReadonlySet<string>
): { [Property in keyof T]: TypedPropertyDescriptor<T[Property]> } {
  inspectRecord(value, label, allowedKeys);
  return Object.getOwnPropertyDescriptors(value);
}

function typedDescriptorValue<T>(descriptor: TypedPropertyDescriptor<T> | undefined): T | undefined {
  return descriptor?.value;
}

function cloneArray(value: readonly unknown[], active: WeakSet<object>, label: string): readonly unknown[] {
  if (types.isProxy(value)) return denyInput(`${label} must not be a Proxy.`);
  if (Object.getPrototypeOf(value) !== Array.prototype) return denyInput(`${label} must use the standard array prototype.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_SNAPSHOT_ARRAY_ITEMS) {
    return denyInput(`${label} has an invalid array length.`);
  }
  const itemKeys = keys.filter(key => key !== "length");
  if (itemKeys.some(key => typeof key === "symbol")) return denyInput(`${label} must not contain symbol properties.`);
  if (itemKeys.length !== length) return denyInput(`${label} must be a dense array without extra properties.`);
  const clone: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !("value" in descriptor)) return denyInput(`${label}[${index}] must be enumerable data.`);
    clone.push(clonePlainData(descriptor.value, active, `${label}[${index}]`));
  }
  return Object.freeze(clone);
}

function clonePlainData(value: unknown, active: WeakSet<object>, label: string): unknown {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : denyInput(`${label} must be a finite number.`);
  if (typeof value !== "object") return denyInput(`${label} contains an unsupported value.`);
  if (types.isProxy(value)) return denyInput(`${label} must not be a Proxy.`);
  if (active.has(value)) return denyInput(`${label} contains a cycle.`);
  active.add(value);
  const clone = Array.isArray(value)
    ? cloneArray(value, active, label)
    : clonePlainRecord(value, active, label);
  active.delete(value);
  return clone;
}

function clonePlainRecord(value: object, active: WeakSet<object>, label: string): Readonly<Record<string, unknown>> {
  const descriptors = inspectRecord(value, label);
  const clone: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    Object.defineProperty(clone, key, {
      value: clonePlainData(descriptor.value, active, `${label}.${key}`),
      enumerable: true,
      configurable: false,
      writable: false
    });
  }
  return Object.freeze(clone);
}

function parseData<TSchema extends z.ZodTypeAny>(schema: TSchema, value: unknown, label: string): z.output<TSchema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return denyInput(`${label} is invalid.`);
  return parsed.data;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export function snapshotFocusedActivationInput(input: FocusedActivationInput): FocusedActivationSnapshot {
  const active = new WeakSet<object>();
  const root = inspectTypedRecord(input, "root", ROOT_KEYS);
  const taskValue = typedDescriptorValue(root.task);
  const authorityValue = typedDescriptorValue(root.authority);
  if (!taskValue) return denyInput("task is required.");
  if (!authorityValue) return denyInput("authority is required.");
  const task = inspectTypedRecord(taskValue, "task", TASK_KEYS);
  const authority = inspectTypedRecord(authorityValue, "authority", AUTHORITY_KEYS);
  const parsedTask = parseData(taskDataSchema, {
    categoryId: clonePlainData(typedDescriptorValue(task.categoryId), active, "task.categoryId"),
    requestedSkills: clonePlainData(typedDescriptorValue(task.requestedSkills), active, "task.requestedSkills")
  }, "task");
  const parsedAuthority = parseData(authorityDataSchema, {
    config: clonePlainData(typedDescriptorValue(authority.config), active, "authority.config"),
    activeAgentId: clonePlainData(typedDescriptorValue(authority.activeAgentId), active, "authority.activeAgentId"),
    approvedPlanExecution: clonePlainData(typedDescriptorValue(authority.approvedPlanExecution), active, "authority.approvedPlanExecution"),
    categories: clonePlainData(typedDescriptorValue(authority.categories), active, "authority.categories"),
    skillOptions: clonePlainData(typedDescriptorValue(authority.skillOptions), active, "authority.skillOptions"),
    allowEnvironmentCredentials: clonePlainData(typedDescriptorValue(authority.allowEnvironmentCredentials), active, "authority.allowEnvironmentCredentials"),
    workspaceRoot: clonePlainData(typedDescriptorValue(authority.workspaceRoot), active, "authority.workspaceRoot")
  }, "authority");
  const config = deepFreeze(parsedAuthority.config);
  const categories = deepFreeze(parsedAuthority.categories ?? config.categories ?? {});
  const taskPacket = clonePlainData(typedDescriptorValue(task.taskPacket), active, "task.taskPacket");
  const modelFetch = typedDescriptorValue(authority.modelFetch);
  const chatGptFetch = typedDescriptorValue(authority.chatGptFetch);
  const authStore = typedDescriptorValue(authority.authStore);
  if (modelFetch !== undefined && typeof modelFetch !== "function") return denyInput("authority.modelFetch is invalid.");
  if (chatGptFetch !== undefined && typeof chatGptFetch !== "function") return denyInput("authority.chatGptFetch is invalid.");
  if (authStore !== undefined && (!authStore || (typeof authStore !== "object" && typeof authStore !== "function"))) {
    return denyInput("authority.authStore is invalid.");
  }
  const snapshotAuthority = Object.freeze({
    ...deepFreeze(parsedAuthority),
    config,
    categories,
    modelFetch,
    chatGptFetch,
    authStore
  });
  return Object.freeze({
    authority: snapshotAuthority,
    task: Object.freeze({
      ...deepFreeze(parsedTask),
      packet: parseTaskPacket(taskPacket)
    })
  });
}
