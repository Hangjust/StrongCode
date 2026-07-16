import { z } from "zod";
import { StrongCodeError } from "../../core/errors";
import { resolveNativeExecutable } from "../../core/executable";
import { err } from "../../core/result";
import type { Tool } from "../tool";
import { assertWorkspaceOwnership } from "../../tasks/ownership";
import { resolveWorkspaceRealPath } from "./list-files";
import { runProcess } from "./run-process";
import { buildDelegatedProcessEnv } from "../../models/delegated-environment";

const inputSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).max(256).default([]),
  cwd: z.string().default("."),
  timeoutMs: z.number().int().positive().max(300000).default(120000),
  maxOutputBytes: z.number().int().positive().max(10_000_000).default(1_000_000)
});

export const shellTool: Tool = {
  name: "shell",
  description: "Run one executable directly in the workspace. Supply arguments separately; shell operators, pipes, and redirection are not interpreted.",
  effect: "shell",
  inputSchema,
  inputJsonSchema: {
    type: "object",
    properties: {
      command: { type: "string", minLength: 1 },
      args: { type: "array", items: { type: "string" }, maxItems: 256, default: [] },
      cwd: { type: "string", default: "." },
      timeoutMs: { type: "integer", minimum: 1, maximum: 300000, default: 120000 },
      maxOutputBytes: { type: "integer", minimum: 1, maximum: 10000000, default: 1000000 }
    },
    required: ["command"],
    additionalProperties: false
  },
  readOnly: false,
  async execute(input, context) {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) return err(new StrongCodeError("VALIDATION_ERROR", parsed.error.message));
    if (parsed.data.command.includes("/") || parsed.data.command.includes("\\")) {
      return err(new StrongCodeError("VALIDATION_ERROR", "Shell executable must be resolved from PATH; do not pass a path"));
    }
    const cwd = await resolveWorkspaceRealPath(context, parsed.data.cwd);
    if (!cwd.ok) return cwd;
    const workspaceRoot = await resolveWorkspaceRealPath(context, ".");
    if (!workspaceRoot.ok) return workspaceRoot;
    const owned = assertWorkspaceOwnership(context, workspaceRoot.value);
    if (!owned.ok) return owned;
    let resolved;
    try {
      resolved = await resolveNativeExecutable(parsed.data.command, {
        cwd: cwd.value,
        excludedRoots: [process.cwd(), workspaceRoot.value],
        env: buildDelegatedProcessEnv()
      });
    } catch (error) {
      if (error instanceof StrongCodeError) return err(new StrongCodeError("TOOL_ERROR", error.message));
      throw error;
    }
    return runProcess({
      command: resolved.executable,
      args: parsed.data.args,
      cwd: cwd.value,
      env: resolved.env,
      timeoutMs: parsed.data.timeoutMs,
      maxOutputBytes: parsed.data.maxOutputBytes,
      ...(context.signal ? { signal: context.signal } : {})
    });
  }
};
