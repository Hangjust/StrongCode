import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { StrongCodeError, toStrongCodeError } from "../../core/errors";
import { err, ok } from "../../core/result";
import type { Tool } from "../tool";
import { assertMutationOwnership } from "../../tasks/ownership";
import { resolveWorkspaceRealPath } from "./list-files";

const inputSchema = z.object({
  path: z.string().min(1),
  oldText: z.string().min(1),
  newText: z.string(),
  replaceAll: z.boolean().default(false),
  expectedOccurrences: z.number().int().positive().default(1)
});

export const editFileTool: Tool = {
  name: "edit_file",
  description: "Replace exact text in an existing UTF-8 workspace file with occurrence checking.",
  effect: "mutation",
  inputSchema,
  inputJsonSchema: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1 },
      oldText: { type: "string", minLength: 1 },
      newText: { type: "string" },
      replaceAll: { type: "boolean", default: false },
      expectedOccurrences: { type: "integer", minimum: 1, default: 1 }
    },
    required: ["path", "oldText", "newText"],
    additionalProperties: false
  },
  readOnly: false,
  async execute(input, context) {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) return err(new StrongCodeError("VALIDATION_ERROR", parsed.error.message));
    const resolved = await resolveWorkspaceRealPath(context, parsed.data.path);
    if (!resolved.ok) return resolved;
    const owned = assertMutationOwnership(context, resolved.value);
    if (!owned.ok) return owned;
    try {
      const content = await readFile(resolved.value, "utf8");
      const occurrences = content.split(parsed.data.oldText).length - 1;
      if (occurrences !== parsed.data.expectedOccurrences) {
        return err(new StrongCodeError("TOOL_ERROR", `Expected ${parsed.data.expectedOccurrences} occurrence(s) in ${parsed.data.path}, found ${occurrences}`));
      }
      const updated = parsed.data.replaceAll
        ? content.split(parsed.data.oldText).join(parsed.data.newText)
        : content.replace(parsed.data.oldText, parsed.data.newText);
      await writeFile(resolved.value, updated, "utf8");
      return ok({ content: `Edited ${parsed.data.path}` });
    } catch (error) {
      return err(toStrongCodeError(error instanceof Error ? error : new Error(String(error)), "TOOL_ERROR"));
    }
  }
};
