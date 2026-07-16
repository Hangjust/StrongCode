import { readdir, realpath } from "node:fs/promises";
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

/** Resolve the existing target through symlinks/junctions before any read. */
export async function resolveWorkspaceRealPath(context: RuntimeContext, requestedPath: string): Promise<Result<string>> {
  const lexical = resolveWorkspacePath(context, requestedPath);
  if (!lexical.ok) return lexical;
  try {
    const [root, target] = await Promise.all([realpath(context.workspaceRoot), realpath(lexical.value)]);
    const relative = path.relative(root, target);
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
      return ok(target);
    }
    return err(new StrongCodeError("PATH_OUTSIDE_WORKSPACE", `Path resolves outside workspace: ${requestedPath}`));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return err(toStrongCodeError(error, "TOOL_ERROR"));
  }
}

/** Resolve an existing directory entry without dereferencing its final symlink or junction. */
export async function resolveWorkspaceEntryPath(context: RuntimeContext, requestedPath: string): Promise<Result<string>> {
  const lexical = resolveWorkspacePath(context, requestedPath);
  if (!lexical.ok) return lexical;
  try {
    const [root, parent] = await Promise.all([
      realpath(context.workspaceRoot),
      realpath(path.dirname(lexical.value))
    ]);
    const relative = path.relative(root, parent);
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
      return ok(path.join(parent, path.basename(lexical.value)));
    }
    return err(new StrongCodeError("PATH_OUTSIDE_WORKSPACE", `Path resolves outside workspace: ${requestedPath}`));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return err(toStrongCodeError(error, "TOOL_ERROR"));
  }
}

/** Resolve an existing or future target while checking every existing parent through symlinks. */
export async function resolveWorkspaceMutationPath(context: RuntimeContext, requestedPath: string): Promise<Result<string>> {
  const lexical = resolveWorkspacePath(context, requestedPath);
  if (!lexical.ok) return lexical;
  try {
    const root = await realpath(context.workspaceRoot);
    const suffix: string[] = [];
    let cursor = lexical.value;
    while (true) {
      try {
        const existing = await realpath(cursor);
        const target = path.join(existing, ...suffix.reverse());
        const relative = path.relative(root, target);
        if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
          return ok(target);
        }
        return err(new StrongCodeError("PATH_OUTSIDE_WORKSPACE", `Path resolves outside workspace: ${requestedPath}`));
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
        const parent = path.dirname(cursor);
        if (parent === cursor) return err(new StrongCodeError("PATH_OUTSIDE_WORKSPACE", `Unable to resolve workspace path: ${requestedPath}`));
        suffix.push(path.basename(cursor));
        cursor = parent;
      }
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return err(toStrongCodeError(error, "TOOL_ERROR"));
  }
}

export const listFilesTool: Tool = {
  name: "list_files",
  description: "List direct children of a directory inside the workspace.",
  effect: "read",
  inputSchema,
  inputJsonSchema: {
    type: "object",
    properties: { path: { type: "string", default: "." } },
    additionalProperties: false
  },
  readOnly: true,
  async execute(input: unknown, context: RuntimeContext) {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) {
      return err(new StrongCodeError("VALIDATION_ERROR", parsed.error.message));
    }

    const resolved = await resolveWorkspaceRealPath(context, parsed.data.path);
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
      if (!(error instanceof Error)) throw error;
      return err(toStrongCodeError(error, "TOOL_ERROR"));
    }
  }
};
