import { z } from "zod";
import { StrongCodeError } from "../core/errors";
import { HELPER_IDS, getHelperDefinition, type HelperDefinition, type HelperId } from "./helper-registry";
import { getAgentDefinition, listAgentDefinitions, normalizeAgentId, type AgentDefinition, type BuiltInAgentId } from "./registry";

export const PRIMARY_SPAWN_AGENT_IDS = ["tesla", "newton", "jbp", "bob-the-builder"] as const satisfies readonly BuiltInAgentId[];
export type PrimarySpawnAgentId = (typeof PRIMARY_SPAWN_AGENT_IDS)[number];

export const SPECIALIST_AGENT_IDS = [
  "hood-research-department",
  "steve-jobs",
  "government",
  "meta",
  "sugar-boo",
  "warren-buffer"
] as const satisfies readonly BuiltInAgentId[];
export type SpecialistAgentId = (typeof SPECIALIST_AGENT_IDS)[number];

export type SpawnTarget =
  | { readonly kind: "helper"; readonly id: HelperId }
  | { readonly kind: "specialist"; readonly id: SpecialistAgentId };

export type SpawnOrigin =
  | { readonly kind: "primary-root"; readonly agentId: PrimarySpawnAgentId }
  | { readonly kind: "child"; readonly agentId: string };

export type ResolvedSpawnTarget =
  | { readonly kind: "helper"; readonly id: HelperId; readonly definition: HelperDefinition }
  | { readonly kind: "specialist"; readonly id: SpecialistAgentId; readonly definition: AgentDefinition };

export const spawnTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("helper"), id: z.enum(HELPER_IDS) }).strict(),
  z.object({ kind: z.literal("specialist"), id: z.enum(SPECIALIST_AGENT_IDS) }).strict()
]);

function unexpectedVariant(value: never): never {
  throw new StrongCodeError("VALIDATION_ERROR", `Unexpected spawn variant: ${String(value)}`);
}

export function resolveSpawnTarget(input: unknown, origin: SpawnOrigin): ResolvedSpawnTarget {
  switch (origin.kind) {
    case "child":
      throw new StrongCodeError("NESTED_SPAWN_DENIED", "Child invocations cannot spawn another agent.");
    case "primary-root":
      if (!PRIMARY_SPAWN_AGENT_IDS.some(agentId => agentId === origin.agentId)) {
        throw new StrongCodeError("PERMISSION_DENIED", "Only canonical primary-root agents may spawn.");
      }
      break;
    default:
      return unexpectedVariant(origin);
  }

  const parsed = spawnTargetSchema.safeParse(input);
  if (!parsed.success) {
    throw new StrongCodeError("VALIDATION_ERROR", "Invalid class-qualified spawn target.");
  }

  const target: SpawnTarget = parsed.data;
  switch (target.kind) {
    case "helper": {
      const definition = getHelperDefinition(target.id);
      if (!definition) throw new StrongCodeError("VALIDATION_ERROR", "Unknown helper spawn target.");
      if (!definition.enabledByDefault) {
        throw new StrongCodeError("HELPER_DISABLED", `Helper '${target.id}' is disabled.`);
      }
      return { kind: "helper", id: target.id, definition };
    }
    case "specialist": {
      const definition = listAgentDefinitions("specialist").find(agent => agent.id === target.id);
      if (!definition) throw new StrongCodeError("CONFIG_ERROR", `Specialist '${target.id}' is not registered.`);
      return { kind: "specialist", id: target.id, definition };
    }
    default:
      return unexpectedVariant(target);
  }
}

export function resolveDirectAgentDefinition(value: string): AgentDefinition | undefined {
  const definition = getAgentDefinition(value);
  if (definition) return definition;

  const helper = getHelperDefinition(normalizeAgentId(value));
  if (helper) {
    throw new StrongCodeError("HELPER_BACKSTAGE", `Helper '${helper.id}' is backstage; selection denied.`);
  }
  return undefined;
}
