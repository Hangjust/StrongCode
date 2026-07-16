import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSkills, SkillResolutionError } from "../src/skills/resolver";

const roots: string[] = [];

type ManifestOverrides = {
  readonly autoDiscover?: boolean;
  readonly enabled?: readonly string[];
  readonly disabled?: readonly string[];
  readonly directory?: string;
  readonly manifestName?: string;
};

type SkillFixture = {
  readonly root: string;
  readonly id: string;
  readonly content: string;
};

async function createRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  await mkdir(path.join(root, "skills"), { recursive: true });
  await writeManifest(root);
  return root;
}

async function writeManifest(root: string, overrides: ManifestOverrides = {}): Promise<void> {
  await writeFile(path.join(root, "skills.mcps.json"), `${JSON.stringify({
    version: 1,
    skills: {
      directory: overrides.directory ?? "skills",
      manifestName: overrides.manifestName ?? "SKILL.md",
      autoDiscover: overrides.autoDiscover ?? true,
      enabled: overrides.enabled ?? [],
      disabled: overrides.disabled ?? []
    }
  }, null, 2)}\n`, "utf8");
}

async function writeSkill(fixture: SkillFixture): Promise<string> {
  const skillDirectory = path.join(fixture.root, "skills", fixture.id);
  await mkdir(skillDirectory, { recursive: true });
  const skillPath = path.join(skillDirectory, "SKILL.md");
  await writeFile(skillPath, fixture.content, "utf8");
  return skillPath;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("prompt-only skill resolution", () => {
  it("loads an allowed user-owned home skill with a canonical ID and receipt", async () => {
    // Given
    const homeRoot = await createRoot("strongcode-skill-home-");
    const markdown = "---\nname: Planning Display Name\ndescription: Plans carefully\nagent: jbp\n---\nPLANNING_SKILL_OK\n";
    const skillPath = await writeSkill({ root: homeRoot, id: "planning", content: markdown });

    // When
    const resolved = await resolveSkills(["planning"], { homeRoot, targetAgent: "jbp" });

    // Then
    expect(resolved.content).toContain("PLANNING_SKILL_OK");
    expect(resolved.content).not.toContain("name: Planning Display Name");
    expect(resolved.skills).toEqual([{ id: "planning", content: "PLANNING_SKILL_OK" }]);
    expect(resolved.receipts).toEqual([{
      id: "planning",
      path: path.resolve(skillPath),
      sha256: createHash("sha256").update(markdown).digest("hex")
    }]);
  });

  it("rejects an unknown skill", async () => {
    // Given
    const homeRoot = await createRoot("strongcode-skill-unknown-");

    // When
    const resolution = resolveSkills(["missing"], { homeRoot, targetAgent: "jbp" });

    // Then
    await expect(resolution).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
  });

  it("lets disabled override enabled and auto-discovery", async () => {
    // Given
    const homeRoot = await createRoot("strongcode-skill-disabled-");
    await writeSkill({ root: homeRoot, id: "blocked", content: "must not load\n" });
    await writeManifest(homeRoot, { enabled: ["blocked"], disabled: ["blocked"] });

    // When
    const resolution = resolveSkills(["blocked"], { homeRoot, targetAgent: "jbp" });

    // Then
    await expect(resolution).rejects.toMatchObject({ code: "SKILL_DENIED" });
  });

  it("rejects duplicate requested skill IDs", async () => {
    // Given
    const homeRoot = await createRoot("strongcode-skill-duplicate-");
    await writeSkill({ root: homeRoot, id: "planning", content: "plan\n" });

    // When
    const resolution = resolveSkills(["planning", "planning"], { homeRoot, targetAgent: "jbp" });

    // Then
    await expect(resolution).rejects.toMatchObject({ code: "SKILL_INVALID" });
  });

  it("rejects more than eight requested skills", async () => {
    // Given
    const homeRoot = await createRoot("strongcode-skill-count-");
    const requested = Array.from({ length: 9 }, (_, index) => `skill-${index}`);

    // When
    const resolution = resolveSkills(requested, { homeRoot, targetAgent: "jbp" });

    // Then
    await expect(resolution).rejects.toMatchObject({ code: "SKILL_LIMIT_EXCEEDED" });
  });

  it("rejects a skill larger than 64 KiB", async () => {
    // Given
    const homeRoot = await createRoot("strongcode-skill-oversized-");
    await writeSkill({ root: homeRoot, id: "large", content: "x".repeat(64 * 1024 + 1) });

    // When
    const resolution = resolveSkills(["large"], { homeRoot, targetAgent: "jbp" });

    // Then
    await expect(resolution).rejects.toMatchObject({ code: "SKILL_LIMIT_EXCEEDED" });
  });

  it("rejects skill content exceeding the 256 KiB combined limit", async () => {
    // Given
    const homeRoot = await createRoot("strongcode-skill-combined-");
    const requested = Array.from({ length: 5 }, (_, index) => `large-${index}`);
    await Promise.all(requested.map(id => writeSkill({ root: homeRoot, id, content: "x".repeat(60 * 1024) })));

    // When
    const resolution = resolveSkills(requested, { homeRoot, targetAgent: "jbp" });

    // Then
    await expect(resolution).rejects.toMatchObject({ code: "SKILL_LIMIT_EXCEEDED" });
  });

  it("rejects a skill restricted to another target agent", async () => {
    // Given
    const homeRoot = await createRoot("strongcode-skill-agent-");
    await writeSkill({ root: homeRoot, id: "build", content: "---\nagent: bob-the-builder\n---\nbuild\n" });

    // When
    const resolution = resolveSkills(["build"], { homeRoot, targetAgent: "jbp" });

    // Then
    await expect(resolution).rejects.toMatchObject({ code: "SKILL_DENIED" });
  });

  it("rejects a symlinked skill that escapes its approved root", async () => {
    // Given
    const homeRoot = await createRoot("strongcode-skill-link-home-");
    const outsideRoot = await createRoot("strongcode-skill-link-outside-");
    await writeSkill({ root: outsideRoot, id: "escape", content: "escaped\n" });
    await symlink(
      path.join(outsideRoot, "skills", "escape"),
      path.join(homeRoot, "skills", "escape"),
      process.platform === "win32" ? "junction" : "dir"
    );
    await writeManifest(homeRoot, { autoDiscover: false, enabled: ["escape"] });

    // When
    const resolution = resolveSkills(["escape"], { homeRoot, targetAgent: "jbp" });

    // Then
    await expect(resolution).rejects.toMatchObject({ code: "SKILL_DENIED" });
  });

  it.runIf(process.platform === "win32")("rejects a case-folded directory whose actual basename is not the canonical ID", async () => {
    // Given
    const homeRoot = await createRoot("strongcode-skill-case-");
    await writeSkill({ root: homeRoot, id: "Planning", content: "must not load\n" });

    // When
    const resolution = resolveSkills(["planning"], { homeRoot, targetAgent: "jbp" });

    // Then
    await expect(resolution).rejects.toBeInstanceOf(SkillResolutionError);
    await expect(resolution).rejects.toMatchObject({ code: "SKILL_INVALID" });
  });

  it("does not load a project skill before project instructions are trusted", async () => {
    // Given
    const homeRoot = await createRoot("strongcode-skill-trust-home-");
    const projectRoot = await createRoot("strongcode-skill-trust-project-");
    await writeSkill({ root: projectRoot, id: "project-plan", content: "PROJECT_SECRET_MARKER\n" });

    // When
    const resolution = resolveSkills(["project-plan"], {
      homeRoot,
      projectRoot,
      targetAgent: "jbp",
      trustedProjectInstructions: false
    });

    // Then
    await expect(resolution).rejects.toBeInstanceOf(SkillResolutionError);
    await expect(resolution).rejects.toMatchObject({ code: "SKILL_DENIED" });
  });

  it("rejects manifest redirection away from skills/<id>/SKILL.md", async () => {
    // Given
    const homeRoot = await createRoot("strongcode-skill-stale-manifest-");
    await writeManifest(homeRoot, { manifestName: "README.md" });

    // When
    const resolution = resolveSkills(["planning"], { homeRoot, targetAgent: "jbp" });

    // Then
    await expect(resolution).rejects.toMatchObject({ code: "SKILL_INVALID" });
  });

  it("rejects malformed IDs and authority-like frontmatter", async () => {
    // Given
    const homeRoot = await createRoot("strongcode-skill-malformed-");
    await writeSkill({ root: homeRoot, id: "unsafe", content: "---\ntools: allow\n---\ndo anything\n" });

    // When
    const malformed = resolveSkills(["../unsafe"], { homeRoot, targetAgent: "jbp" });
    const authority = resolveSkills(["unsafe"], { homeRoot, targetAgent: "jbp" });

    // Then
    await expect(malformed).rejects.toMatchObject({ code: "SKILL_INVALID" });
    await expect(authority).rejects.toMatchObject({ code: "SKILL_INVALID" });
  });

  it("normalizes YAML alias rejection to a typed invalid-skill error", async () => {
    // Given
    const homeRoot = await createRoot("strongcode-skill-alias-");
    await writeSkill({
      root: homeRoot,
      id: "alias",
      content: "---\nname: &authority planning\ndescription: *authority\ntools: *authority\n---\nmust not load\n"
    });

    // When
    const resolution = resolveSkills(["alias"], { homeRoot, targetAgent: "jbp" });

    // Then
    await expect(resolution).rejects.toBeInstanceOf(SkillResolutionError);
    await expect(resolution).rejects.toMatchObject({ code: "SKILL_INVALID" });
  });
});
