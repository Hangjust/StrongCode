import { readFile } from "node:fs/promises";
import { z } from "zod";
import { StrongCodeError, toStrongCodeError } from "../../core/errors";
import { err, ok } from "../../core/result";
import { Tool } from "../tool";
import { resolveWorkspacePath } from "./list-files";

const inputSchema = z.object({
  path: z.string().min(1)
});

export const readFileTool: Tool = {
  name: "read_file",
  description: "Read a UTF-8 text file inside the workspace.",
  inputSchema,
  async execute(input, context) {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) {
      return err(new StrongCodeError("VALIDATION_ERROR", parsed.error.message));
    }

    const resolved = resolveWorkspacePath(context, parsed.data.path);
    if (!resolved.ok) {
      return resolved;
    }

    try {
      const content = await readFile(resolved.value, "utf8");
      return ok({ content });
    } catch (error) {
      return err(toStrongCodeError(error, "TOOL_ERROR"));
    }
  }
};
