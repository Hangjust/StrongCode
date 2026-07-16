import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { StrongCodeError } from "../core/errors";
import type { PathReceipt } from "../core/path-identity";
import { resolveStrongCodeHome } from "./paths";
import { readTrustedHomeFile } from "./trusted-home-file";

const MAX_INSTRUCTIONS_BYTES = 256 * 1024;

async function readProjectInstructionFile(filePath: string): Promise<string | undefined> {
  try {
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) throw new StrongCodeError("CONFIG_ERROR", `Refusing to load non-regular instruction file: ${filePath}`);
    if (stats.size > MAX_INSTRUCTIONS_BYTES) throw new StrongCodeError("CONFIG_ERROR", `Instruction file exceeds ${MAX_INSTRUCTIONS_BYTES} bytes: ${filePath}`);
    const value = (await readFile(filePath, "utf8")).trim();
    return value || undefined;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export interface LoadAgentInstructionsOptions {
  /** Repository instructions are omitted unless the user explicitly trusts the project. */
  includeProject?: boolean;
  readonly automaticHomeReceipt?: PathReceipt;
}

/** Load user-owned global guidance and, only when opted in, repository guidance. */
export async function loadAgentInstructions(
  workspaceRoot: string,
  homePath = resolveStrongCodeHome(),
  options: LoadAgentInstructionsOptions = {}
): Promise<string | undefined> {
  const globalPath = path.join(path.resolve(homePath), "AGENTS.md");
  const projectPath = path.join(path.resolve(workspaceRoot), "AGENTS.md");
  let globalInstructions: string | undefined;
  try {
    const bytes = await readTrustedHomeFile(globalPath, {
      automaticHomeReceipt: options.automaticHomeReceipt,
      maxBytes: BigInt(MAX_INSTRUCTIONS_BYTES)
    });
    globalInstructions = bytes?.toString("utf8").trim() || undefined;
  } catch (error) {
    throw new StrongCodeError(
      "CONFIG_ERROR",
      `Failed to read global instructions ${globalPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const projectInstructions = options.includeProject === true && !samePath(globalPath, projectPath)
    ? await readProjectInstructionFile(projectPath)
    : undefined;
  const sections = [
    globalInstructions ? `User-owned global instructions:\n${globalInstructions}` : undefined,
    projectInstructions ? `Explicitly trusted repository instructions:\n${projectInstructions}` : undefined
  ].filter((value): value is string => Boolean(value));
  return sections.length ? sections.join("\n\n") : undefined;
}
