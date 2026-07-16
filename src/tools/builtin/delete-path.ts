import { rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { StrongCodeError, toStrongCodeError } from "../../core/errors";
import { err, ok } from "../../core/result";
import type { Tool } from "../tool";
import { assertMutationOwnership } from "../../tasks/ownership";
import { resolveWorkspaceEntryPath, resolveWorkspacePath } from "./list-files";

const inputSchema = z.object({ path: z.string().min(1), recursive: z.boolean().default(false) });

export const deletePathTool: Tool = {
  name: "delete_path",
  description: "Delete a workspace file or directory. Recursive directory deletion requires recursive=true; the workspace root is never deletable.",
  effect: "mutation",
  inputSchema,
  inputJsonSchema: {
    type: "object",
    properties: { path: { type: "string", minLength: 1 }, recursive: { type: "boolean", default: false } },
    required: ["path"],
    additionalProperties: false
  },
  readOnly: false,
  async execute(input, context) {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) return err(new StrongCodeError("VALIDATION_ERROR", parsed.error.message));
    const lexical = resolveWorkspacePath(context, parsed.data.path);
    if (!lexical.ok) return lexical;
    if (path.resolve(lexical.value) === path.resolve(context.workspaceRoot)) {
      return err(new StrongCodeError("PERMISSION_DENIED", "Refusing to delete the workspace root"));
    }
    try {
      const target = await resolveWorkspaceEntryPath(context, parsed.data.path);
      if (!target.ok) return target;
      if (context.taskId) {
        const owned = assertMutationOwnership(context, target.value);
        if (!owned.ok) return owned;
      }
      await rm(target.value, { recursive: parsed.data.recursive, force: false });
      return ok({ content: `Deleted ${parsed.data.path}` });
    } catch (error) {
      return err(toStrongCodeError(error instanceof Error ? error : new Error(String(error)), "TOOL_ERROR"));
    }
  }
};
