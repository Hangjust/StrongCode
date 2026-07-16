import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  isSafeSkillId,
  loadSkillManifest,
  pathIsInside,
  SkillResolutionError
} from "./manifest";

export type SkillSource = "home" | "project";

export type SkillCandidate = {
  readonly id: string;
  readonly path: string;
  readonly source: SkillSource;
};

export type SkillDiscovery = {
  readonly candidates: readonly SkillCandidate[];
  readonly disabledIds: ReadonlySet<string>;
};

export type DiscoverSkillsOptions = {
  readonly rootPath: string;
  readonly source: SkillSource;
  readonly requestedIds?: readonly string[];
  readonly trustedProjectInstructions?: boolean;
};

function denied(message: string, cause?: unknown): SkillResolutionError {
  return new SkillResolutionError(
    "SKILL_DENIED",
    message,
    cause === undefined ? undefined : { cause }
  );
}

async function regularContainedDirectory(root: string, directory: string, label: string): Promise<string> {
  const stats = await lstat(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw denied(`Refusing non-regular ${label}: ${directory}`);
  }
  const resolved = await realpath(directory);
  if (!pathIsInside(root, resolved)) {
    throw denied(`Refusing ${label} outside approved root: ${directory}`);
  }
  return resolved;
}

async function candidateForId(
  options: {
    readonly id: string;
    readonly source: SkillSource;
    readonly skillsRoot: string;
    readonly manifestName: "SKILL.md";
  }
): Promise<SkillCandidate | undefined> {
  const skillDirectory = path.join(options.skillsRoot, options.id);
  let directoryStats;
  try {
    directoryStats = await lstat(skillDirectory);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw denied(`Refusing non-regular skill directory: ${skillDirectory}`);
  }

  const realDirectory = await realpath(skillDirectory);
  if (!pathIsInside(options.skillsRoot, realDirectory)) {
    throw denied(`Skill directory resolves outside approved skills root: ${skillDirectory}`);
  }
  if (path.basename(realDirectory) !== options.id) {
    throw new SkillResolutionError("SKILL_INVALID", `Skill directory basename must exactly match canonical ID '${options.id}': ${realDirectory}`);
  }

  const skillPath = path.join(skillDirectory, options.manifestName);
  let fileStats;
  try {
    fileStats = await lstat(skillPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
    throw denied(`Refusing non-regular skill Markdown: ${skillPath}`);
  }

  const realSkillPath = await realpath(skillPath);
  if (!pathIsInside(realDirectory, realSkillPath)) {
    throw denied(`Skill Markdown resolves outside its canonical directory: ${skillPath}`);
  }
  return { id: options.id, path: realSkillPath, source: options.source };
}

export async function discoverSkills(options: DiscoverSkillsOptions): Promise<SkillDiscovery> {
  if (options.source === "project" && options.trustedProjectInstructions !== true) {
    throw denied("Project skills require explicitly trusted project instructions");
  }

  const rootPath = path.resolve(options.rootPath);
  const manifest = await loadSkillManifest(rootPath);
  const rootRealPath = await realpath(rootPath);
  const skillsPath = path.join(rootPath, manifest.skills.directory);
  let skillsRoot: string;
  try {
    skillsRoot = await regularContainedDirectory(rootRealPath, skillsPath, "skills directory");
  } catch (error) {
    if (error instanceof SkillResolutionError) throw error;
    throw denied(`Unable to inspect skills directory: ${skillsPath}`, error);
  }

  let ids: readonly string[];
  if (options.requestedIds) {
    ids = options.requestedIds;
  } else if (manifest.skills.autoDiscover) {
    const entries = await readdir(skillsRoot, { withFileTypes: true });
    ids = entries.filter(entry => isSafeSkillId(entry.name)).map(entry => entry.name);
  } else {
    ids = manifest.skills.enabled;
  }

  const enabled = new Set(manifest.skills.enabled);
  const disabledIds = new Set(manifest.skills.disabled);
  const eligibleIds = [...new Set(ids)]
    .filter(id => !disabledIds.has(id) && (manifest.skills.autoDiscover || enabled.has(id)))
    .sort((left, right) => left.localeCompare(right));
  const candidates: SkillCandidate[] = [];
  for (const id of eligibleIds) {
    const candidate = await candidateForId({
      id,
      source: options.source,
      skillsRoot,
      manifestName: manifest.skills.manifestName
    });
    if (candidate) candidates.push(candidate);
  }
  return { candidates, disabledIds };
}
