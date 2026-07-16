import { z } from "zod";
import { rgPath } from "@vscode/ripgrep";
import { StrongCodeError } from "../../core/errors";
import { err, ok } from "../../core/result";
import type { Tool } from "../tool";
import { resolveWorkspaceRealPath } from "./list-files";
import { runProcess } from "./run-process";

const inputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().default("."),
  globs: z.array(z.string().min(1)).max(32).default([]),
  fixedStrings: z.boolean().default(false),
  caseSensitive: z.boolean().default(true),
  maxResults: z.number().int().positive().max(10000).default(1000)
});

export const ripgrepTool: Tool = {
  name: "ripgrep",
  description: "Search workspace file contents with ripgrep while respecting ignore files.",
  effect: "search",
  inputSchema,
  inputJsonSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", minLength: 1 },
      path: { type: "string", default: "." },
      globs: { type: "array", items: { type: "string" }, maxItems: 32, default: [] },
      fixedStrings: { type: "boolean", default: false },
      caseSensitive: { type: "boolean", default: true },
      maxResults: { type: "integer", minimum: 1, maximum: 10000, default: 1000 }
    },
    required: ["pattern"],
    additionalProperties: false
  },
  readOnly: true,
  async execute(input, context) {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) return err(new StrongCodeError("VALIDATION_ERROR", parsed.error.message));
    const resolved = await resolveWorkspaceRealPath(context, parsed.data.path);
    if (!resolved.ok) return resolved;
    const args = [
      "--line-number", "--column", "--no-heading", "--color", "never",
      ...(parsed.data.fixedStrings ? ["--fixed-strings"] : []),
      ...(parsed.data.caseSensitive ? [] : ["--ignore-case"]),
      ...parsed.data.globs.flatMap(glob => ["-g", glob]),
      "--", parsed.data.pattern, "."
    ];
    const result = await runProcess({
      command: rgPath,
      args,
      cwd: resolved.value,
      timeoutMs: 30000,
      maxOutputBytes: 4_000_000,
      ...(context.signal ? { signal: context.signal } : {})
    });
    if (!result.ok) {
      if (result.error.message.includes("exited with code 1")) return ok({ content: "" });
      return result;
    }
    return ok({ content: result.value.content.split(/\r?\n/).slice(0, parsed.data.maxResults).join("\n") });
  }
};
