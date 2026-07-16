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
import type { Tool } from "../tools/tool";
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

export function modelToolDefinition(tool: Tool): ModelToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputJsonSchema ?? { type: "object", additionalProperties: true }
  };
}
