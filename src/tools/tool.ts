import { z } from "zod";
import { Result } from "../core/result";
import type { ToolInvocationContext } from "../runtime/context";

export interface ToolResult {
  content: string;
}

export type ToolEffect =
  | "read"
  | "search"
  | "read-only-web"
  | "mutation"
  | "shell"
  | "interaction"
  | "discovery"
  | "worker"
  | "spawn"
  | "unclassified";

export interface Tool {
  name: string;
  /** Original provider name when registration transforms the public tool name. */
  rawName?: string;
  description: string;
  effect: ToolEffect;
  inputSchema: z.ZodType<unknown>;
  /** JSON Schema passed to model providers. Defaults to an open object. */
  inputJsonSchema?: Record<string, unknown>;
  /** Used by role-level policies that must remain read-only. */
  readOnly?: boolean;
  execute(input: unknown, context: ToolInvocationContext): Promise<Result<ToolResult>>;
}
