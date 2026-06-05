import { readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { StrongCodeError, toStrongCodeError } from "../../core/errors";
import { err, ok, Result } from "../../core/result";
import { RuntimeContext } from "../../runtime/context";
import { Tool } from "../tool";

const inputSchema = z.object({
  path: z.string().default(".")
});

export function resolveWorkspacePath(context: RuntimeContext, requestedPath: string): Result<string> {
  const resolved = path.resolve(context.workspaceRoot, requestedPath);
  const root = context.workspaceRoot;
  const inside = resolved === root || resolved.startsWith(`${root}${path.sep}`);

  if (!inside) {
    return err(new StrongCodeError("PATH_OUTSIDE_WORKSPACE", `Path escapes workspace: ${requestedPath}`));
  }

  return ok(resolved);
}

export const listFilesTool: Tool = {
  name: "list_files",
  description: "List direct children of a directory inside the workspace.",
  inputSchema,
  async execute(input: unknown, context: RuntimeContext) {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) {
      return err(new StrongCodeError("VALIDATION_ERROR", parsed.error.message));
    }

    const resolved = resolveWorkspacePath(context, parsed.data.path);
    if (!resolved.ok) {
      return resolved;
    }

    try {
      const entries = await readdir(resolved.value, { withFileTypes: true });
      const lines = entries
        .map(entry => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
        .sort((left, right) => left.localeCompare(right));
      return ok({ content: lines.join("\n") });
    } catch (error) {
      return err(toStrongCodeError(error, "TOOL_ERROR"));
    }
  }
};
