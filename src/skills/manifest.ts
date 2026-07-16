import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const SKILL_MANIFEST_FILE = "skills.mcps.json";
const MAX_MANIFEST_BYTES = 64 * 1024;
const skillIdSchema = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/);

export const SKILL_ERROR_CODES = [
  "SKILL_INVALID",
  "SKILL_DENIED",
  "SKILL_NOT_FOUND",
  "SKILL_LIMIT_EXCEEDED"
] as const;

export type SkillErrorCode = (typeof SKILL_ERROR_CODES)[number];

export class SkillResolutionError extends Error {
  readonly name = "SkillResolutionError";

  constructor(
    readonly code: SkillErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

const skillSettingsSchema = z.object({
  directory: z.literal("skills"),
  manifestName: z.literal("SKILL.md"),
  autoDiscover: z.boolean(),
  enabled: z.array(skillIdSchema).max(2048),
  disabled: z.array(skillIdSchema).max(2048)
}).strict();

const skillManifestSchema = z.object({
  version: z.literal(1),
  skills: skillSettingsSchema
}).passthrough();

export type SkillManifest = z.infer<typeof skillManifestSchema>;

export function isSafeSkillId(value: string): boolean {
  return skillIdSchema.safeParse(value).success;
}

export function pathIsInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function invalidManifest(filePath: string, detail: string, cause?: unknown): SkillResolutionError {
  return new SkillResolutionError(
    "SKILL_INVALID",
    `Invalid skill manifest ${filePath}: ${detail}`,
    cause === undefined ? undefined : { cause }
  );
}

export async function loadSkillManifest(rootPath: string): Promise<SkillManifest> {
  const approvedRoot = path.resolve(rootPath);
  const manifestPath = path.join(approvedRoot, SKILL_MANIFEST_FILE);

  try {
    const [rootRealPath, manifestStats] = await Promise.all([realpath(approvedRoot), lstat(manifestPath)]);
    if (manifestStats.isSymbolicLink() || !manifestStats.isFile()) {
      throw invalidManifest(manifestPath, "manifest must be a regular file, not a symlink");
    }
    if (manifestStats.size > MAX_MANIFEST_BYTES) {
      throw invalidManifest(manifestPath, `manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
    }

    const manifestRealPath = await realpath(manifestPath);
    if (!pathIsInside(rootRealPath, manifestRealPath)) {
      throw invalidManifest(manifestPath, "manifest resolves outside its approved root");
    }

    const text = await readFile(manifestRealPath, "utf8");
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      if (error instanceof Error) throw invalidManifest(manifestPath, `malformed JSON: ${error.message}`, error);
      throw invalidManifest(manifestPath, `malformed JSON: ${String(error)}`, error);
    }

    const parsed = skillManifestSchema.safeParse(value);
    if (!parsed.success) {
      const detail = parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ");
      throw invalidManifest(manifestPath, detail);
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof SkillResolutionError) throw error;
    throw invalidManifest(manifestPath, error instanceof Error ? error.message : String(error), error);
  }
}
