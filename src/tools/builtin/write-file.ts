import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { StrongCodeError, toStrongCodeError } from "../../core/errors";
import { err, ok } from "../../core/result";
import type { Tool } from "../tool";
import { assertMutationOwnership } from "../../tasks/ownership";
import { resolveWorkspaceMutationPath } from "./list-files";

const inputSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  overwrite: z.boolean().default(false),
  createParents: z.boolean().default(true)
});

export const writeFileTool: Tool = {
  name: "write_file",
  description: "Create a UTF-8 file in the workspace. Existing files require overwrite=true.",
  effect: "mutation",
  inputSchema,
  inputJsonSchema: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1 },
      content: { type: "string" },
      overwrite: { type: "boolean", default: false },
      createParents: { type: "boolean", default: true }
    },
    required: ["path", "content"],
    additionalProperties: false
  },
  readOnly: false,
  async execute(input, context) {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) return err(new StrongCodeError("VALIDATION_ERROR", parsed.error.message));
    const resolved = await resolveWorkspaceMutationPath(context, parsed.data.path);
    if (!resolved.ok) return resolved;
    const owned = assertMutationOwnership(context, resolved.value);
    if (!owned.ok) return owned;
    try {
      if (parsed.data.createParents) await mkdir(path.dirname(resolved.value), { recursive: true });
      await writeFile(resolved.value, parsed.data.content, { encoding: "utf8", flag: parsed.data.overwrite ? "w" : "wx" });
      return ok({ content: `Wrote ${Buffer.byteLength(parsed.data.content, "utf8")} bytes to ${parsed.data.path}` });
    } catch (error) {
      return err(toStrongCodeError(error instanceof Error ? error : new Error(String(error)), "TOOL_ERROR"));
    }
  }
};
