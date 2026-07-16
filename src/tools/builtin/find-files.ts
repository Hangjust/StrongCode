import { z } from "zod";
import { rgPath } from "@vscode/ripgrep";
import { StrongCodeError } from "../../core/errors";
import { err, ok } from "../../core/result";
import type { Tool } from "../tool";
import { resolveWorkspaceRealPath } from "./list-files";
import { runProcess } from "./run-process";

const inputSchema = z.object({
  path: z.string().default("."),
  query: z.string().default(""),
  globs: z.array(z.string().min(1)).max(32).default([]),
  maxResults: z.number().int().positive().max(10000).default(1000)
});

export const findFilesTool: Tool = {
  name: "find_files",
  description: "Find workspace files by path substring and optional ripgrep glob filters.",
  effect: "search",
  inputSchema,
  inputJsonSchema: {
    type: "object",
    properties: {
      path: { type: "string", default: "." },
      query: { type: "string", default: "" },
      globs: { type: "array", items: { type: "string" }, maxItems: 32, default: [] },
      maxResults: { type: "integer", minimum: 1, maximum: 10000, default: 1000 }
    },
    additionalProperties: false
  },
  readOnly: true,
  async execute(input, context) {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) return err(new StrongCodeError("VALIDATION_ERROR", parsed.error.message));
    const resolved = await resolveWorkspaceRealPath(context, parsed.data.path);
    if (!resolved.ok) return resolved;
    const args = ["--files", "--color", "never", ...parsed.data.globs.flatMap(glob => ["-g", glob]), "--", "."];
    const result = await runProcess({
      command: rgPath,
      args,
      cwd: resolved.value,
      timeoutMs: 30000,
      maxOutputBytes: 2_000_000,
      ...(context.signal ? { signal: context.signal } : {})
    });
    if (!result.ok) return result;
    const needle = parsed.data.query.toLowerCase();
    const files = result.value.content.split(/\r?\n/)
      .filter(Boolean)
      .filter(file => !needle || file.toLowerCase().includes(needle))
      .slice(0, parsed.data.maxResults);
    return ok({ content: files.join("\n") });
  }
};
