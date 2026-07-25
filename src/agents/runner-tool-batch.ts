import { StrongCodeError } from "../core/errors";
import { err, ok, type Result } from "../core/result";
import type { ToolCall } from "../core/types";
import type { ModelToolDefinition } from "../models/provider";
import type { ToolInvocationContext } from "../runtime/context";
import { assertChildToolAllowed } from "../tools/child-policy";
import {
  assertRuntimeToolAllowed,
  assertRuntimeToolNameAllowed,
  assertToolAllowedByAgentPolicy
} from "../tools/capability-policy";
import { assertToolAllowed } from "../tools/permissions";
import type { Tool, ToolModelView } from "../tools/tool";
import type { Agent } from "./agent";

export type ToolBatchContext = {
  readonly agent: Agent;
  readonly invocation: ToolInvocationContext;
  readonly toolsByName: ReadonlyMap<string, Tool>;
};

export type AdmittedToolCall<T extends ToolCall> = {
  readonly call: T;
  readonly tool: Tool;
};

export type ModelToolProjection = Readonly<{
  visibleTools: readonly Tool[];
  names: readonly string[];
  definitions: readonly ModelToolDefinition[];
}>;

export type ModelToolSnapshot = Readonly<{
  enabledToolNames: readonly string[];
  toolDefinitions: readonly ModelToolDefinition[];
  toolsByName: ReadonlyMap<string, Tool>;
}>;

export function admitToolBatch<T extends ToolCall>(
  toolCalls: readonly T[],
  context: ToolBatchContext
): Result<readonly AdmittedToolCall<T>[]> {
  const questionCalls = toolCalls.filter(toolCall => toolCall.name === "question").length;
  if (questionCalls > 1 || (questionCalls === 1 && toolCalls.length > 1)) {
    return err(new StrongCodeError("MODEL_ERROR", "The question tool must be the only tool call in a model response"));
  }

  const admitted: AdmittedToolCall<T>[] = [];
  for (const call of toolCalls) {
    const tool = context.toolsByName.get(call.name);
    if (!tool) {
      return err(new StrongCodeError("PERMISSION_DENIED", `Tool '${call.name}' is not enabled for agent '${context.agent.name}'`));
    }
    const policyAllowed = assertToolAllowedByAgentPolicy(context.agent.toolPolicy, tool);
    if (!policyAllowed.ok) return policyAllowed;
    const roleAllowed = assertRuntimeToolNameAllowed(context.agent.runtimeRole ?? "primary", call.name);
    if (!roleAllowed.ok) return roleAllowed;
    const classified = assertRuntimeToolAllowed(context.agent.runtimeRole ?? "primary", tool);
    if (!classified.ok) return classified;
    const childAllowed = assertChildToolAllowed(context.invocation, tool);
    if (!childAllowed.ok) return childAllowed;
    const allowed = assertToolAllowed(context.invocation.config, call.name, context.invocation.effectivePermissions);
    if (!allowed.ok) return allowed;
    admitted.push({ call, tool });
  }
  return ok(admitted);
}

export function modelToolDefinition(tool: Tool, view?: ToolModelView): ModelToolDefinition {
  return {
    name: tool.name,
    description: view?.description ?? tool.description,
    inputSchema: view?.inputJsonSchema ?? tool.inputJsonSchema ?? { type: "object", additionalProperties: true }
  };
}

export function projectModelTools(
  tools: readonly Tool[],
  context: ToolInvocationContext
): ModelToolProjection {
  const visibleTools: Tool[] = [];
  const names: string[] = [];
  const definitions: ModelToolDefinition[] = [];
  for (const tool of tools) {
    const modelView = tool.modelView;
    const view = modelView?.(context);
    if (modelView !== undefined && view === undefined) {
      continue;
    }
    const definition = modelToolDefinition(tool, view);
    visibleTools.push(tool);
    names.push(definition.name);
    definitions.push(definition);
  }
  return { visibleTools, names, definitions };
}

export function createModelToolSnapshot(
  tools: readonly Tool[],
  context: ToolInvocationContext
): ModelToolSnapshot {
  const modelTools = projectModelTools(tools, context);
  const permittedToolNames = new Set(modelTools.visibleTools.filter(tool => (
    assertChildToolAllowed(context, tool).ok
    && assertToolAllowed(context.config, tool.name, context.effectivePermissions).ok
  )).map(tool => tool.name));
  return {
    enabledToolNames: modelTools.names.filter(name => permittedToolNames.has(name)),
    toolDefinitions: modelTools.definitions.filter(definition => permittedToolNames.has(definition.name)),
    toolsByName: new Map(modelTools.visibleTools.map(tool => [tool.name, tool]))
  };
}
