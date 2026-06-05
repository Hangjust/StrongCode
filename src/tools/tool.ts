import { z } from "zod";
import { Result } from "../core/result";
import { RuntimeContext } from "../runtime/context";

export interface ToolResult {
  content: string;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: z.ZodType<unknown>;
  execute(input: unknown, context: RuntimeContext): Promise<Result<ToolResult>>;
}
