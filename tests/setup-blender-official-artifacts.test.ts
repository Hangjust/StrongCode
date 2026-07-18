import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  OFFICIAL_BLENDER_MCP_PATHS,
  OFFICIAL_BLENDER_MCP_RELEASE,
  OFFICIAL_BLENDER_MCP_TARGET,
  officialArtifactCatalogSchema,
  officialWheelLockSchema
} from "../src/setup/blender/official-artifact-manifest";
import {
  parseOfficialArtifactCatalogJson,
  parseOfficialRequirements,
  parseOfficialWheelLockJson
} from "../src/setup/blender/official-artifact-parser";
import {
  downloadVerifiedArtifacts,
  officialArtifactClosure,
  type ArtifactHttpClient
} from "../src/setup/blender/artifacts";

const ASSET_ROOT = path.join(process.cwd(), "assets", "blender-mcp");

describe("official Blender Lab MCP artifact catalog", () => {
  it("pins the canonical v1.0.0 release assets and upstream identity", async () => {
    // Given
    const catalog = parseOfficialArtifactCatalogJson(await readFile(
      path.join(ASSET_ROOT, OFFICIAL_BLENDER_MCP_PATHS.catalog),
      "utf8"
    ));

    // When
    const release = catalog.release;

    // Then
    expect(release).toEqual(OFFICIAL_BLENDER_MCP_RELEASE);
    expect(catalog.upstream).toEqual({
      repository: "https://projects.blender.org/lab/blender_mcp",
      commit: "03004fd0216bfe5e0a3d9ac9b47d5efadc3d78c4",
      tag: "v1.0.0",
      version: "1.0.0",
      addonId: "mcp",
      license: "GPL-3.0-or-later"
    });
    expect(catalog.root).toEqual({
      name: "blender-mcp",
      version: "1.0.0",
      source: "verified-mcpb",
      artifact: "blender-1.0.0.mcpb"
    });
    expect(catalog.integrity).toMatchObject({
      authority: "StrongCode",
      upstreamSignatures: false
    });
    expect(catalog.integrity.notice).toMatch(/StrongCode-maintained SHA-256 pins.*not upstream signatures/iu);
  });

  it("locks only the released uv.lock dependency closure for CPython 3.11 win_amd64", async () => {
    // Given
    const lock = parseOfficialWheelLockJson(await readFile(
      path.join(ASSET_ROOT, OFFICIAL_BLENDER_MCP_PATHS.wheels),
      "utf8"
    ));

    // When
    const names = lock.dependencies.map(dependency => dependency.name);

    // Then
    expect(lock.target).toEqual(OFFICIAL_BLENDER_MCP_TARGET);
    expect(lock.roots).toEqual([
      "docutils==0.22.4",
      "mcp[cli]==1.27.0",
      "pyyaml==6.0.3"
    ]);
    expect(lock.dependencies).toHaveLength(40);
    expect(names).not.toContain("blender-mcp");
    expect(new Set(names).size).toBe(names.length);
    for (const dependency of lock.dependencies) {
      expect(dependency.url).toBe(`https://files.pythonhosted.org${new URL(dependency.url).pathname}`);
      expect(dependency.url.endsWith(`/${dependency.filename}`)).toBe(true);
      expect(dependency.size).toBeGreaterThan(0);
      expect(dependency.sha256).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  it("keeps every dependency hash-locked and covered by notices", async () => {
    // Given
    const lock = parseOfficialWheelLockJson(await readFile(
      path.join(ASSET_ROOT, OFFICIAL_BLENDER_MCP_PATHS.wheels),
      "utf8"
    ));
    const requirementsSource = await readFile(
      path.join(ASSET_ROOT, OFFICIAL_BLENDER_MCP_PATHS.requirements),
      "utf8"
    );
    const notices = await readFile(path.join(ASSET_ROOT, OFFICIAL_BLENDER_MCP_PATHS.notices), "utf8");

    // When
    const requirements = parseOfficialRequirements(lock, requirementsSource);

    // Then
    expect(requirements).toHaveLength(lock.dependencies.length);
    for (const dependency of lock.dependencies) {
      expect(requirements).toContain(`${dependency.name}==${dependency.version} --hash=sha256:${dependency.sha256}`);
      expect(notices).toContain(`| ${dependency.name} | ${dependency.version} | ${dependency.license} |`);
    }
  });

  it("records the embedded uv.lock digest and a checked-in GPL license notice", async () => {
    // Given
    const catalog = parseOfficialArtifactCatalogJson(await readFile(
      path.join(ASSET_ROOT, OFFICIAL_BLENDER_MCP_PATHS.catalog),
      "utf8"
    ));
    const license = await readFile(path.join(ASSET_ROOT, OFFICIAL_BLENDER_MCP_PATHS.license), "utf8");

    // When
    const licenseSha256 = createHash("sha256").update(license).digest("hex");

    // Then
    expect(catalog.lockSource).toEqual({
      artifact: "blender-1.0.0.mcpb",
      path: "uv.lock",
      size: 162146,
      sha256: "f6859224cf648af55274f309c56141bbbca089e04601290e0ac9891c44aad470"
    });
    expect(catalog.license).toMatchObject({ path: OFFICIAL_BLENDER_MCP_PATHS.license, spdx: "GPL-3.0-or-later" });
    expect(catalog.license.sha256).toBe(licenseSha256);
    expect(license).toMatch(/GNU GENERAL PUBLIC LICENSE/iu);
  });

  it("builds a release-and-wheel download closure without a PyPI root", async () => {
    // Given
    const catalog = parseOfficialArtifactCatalogJson(await readFile(
      path.join(ASSET_ROOT, OFFICIAL_BLENDER_MCP_PATHS.catalog),
      "utf8"
    ));
    const lock = parseOfficialWheelLockJson(await readFile(
      path.join(ASSET_ROOT, OFFICIAL_BLENDER_MCP_PATHS.wheels),
      "utf8"
    ));

    // When
    const closure = officialArtifactClosure(catalog, lock);

    // Then
    expect(closure.slice(0, 2)).toEqual(catalog.release.assets);
    expect(closure).toHaveLength(lock.dependencies.length + catalog.release.assets.length);
    expect(closure.some(artifact => /blender_mcp-.*\.whl$/u.test(artifact.filename))).toBe(false);
    expect(closure.find(artifact => artifact.filename === catalog.root.artifact)?.url)
      .toBe(OFFICIAL_BLENDER_MCP_RELEASE.assets[1].url);
  });

  it("allows verified downloads only from the official project host", async () => {
    // Given
    const content = Buffer.from("official fixture");
    const destination = await mkdtemp(path.join(tmpdir(), "strongcode-official-artifact-"));
    const artifact = {
      filename: "fixture.zip",
      url: "https://projects.blender.org/releases/fixture.zip",
      size: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex")
    };
    const http: ArtifactHttpClient = {
      async open() {
        return {
          statusCode: 200,
          headers: { "content-length": String(content.byteLength) },
          body: (async function* () { yield content; })(),
          cancel() {}
        };
      }
    };

    // When
    await downloadVerifiedArtifacts({ artifacts: [artifact], destination, http });

    // Then
    expect(await readFile(path.join(destination, artifact.filename))).toEqual(content);
  });

  it("rejects host substitution, a PyPI root wheel, and incomplete hashes", () => {
    // Given
    const catalog = {
      schemaVersion: 1,
      upstream: {
        repository: "https://projects.blender.org/lab/blender_mcp",
        commit: "03004fd0216bfe5e0a3d9ac9b47d5efadc3d78c4",
        tag: "v1.0.0",
        version: "1.0.0",
        addonId: "mcp",
        license: "GPL-3.0-or-later"
      },
      release: OFFICIAL_BLENDER_MCP_RELEASE,
      root: { name: "blender-mcp", version: "1.0.0", source: "verified-mcpb", artifact: "blender-1.0.0.mcpb" },
      lockSource: { artifact: "blender-1.0.0.mcpb", path: "uv.lock", size: 162146, sha256: "f".repeat(64) },
      integrity: { authority: "StrongCode", upstreamSignatures: false, notice: "StrongCode-maintained SHA-256 pins are not upstream signatures." },
      license: { path: "OFFICIAL_LICENSE.md", spdx: "GPL-3.0-or-later", sha256: "a".repeat(64) }
    };
    const dependency = {
      name: "blender-mcp",
      version: "1.0.0",
      filename: "blender_mcp-1.0.0-py3-none-any.whl",
      url: `https://files.pythonhosted.org/packages/aa/bb/${"c".repeat(60)}/blender_mcp-1.0.0-py3-none-any.whl`,
      size: 1,
      sha256: "d".repeat(64),
      requiresPython: ">=3.10",
      license: "GPL-3.0-or-later"
    };

    // When / Then
    expect(officialArtifactCatalogSchema.safeParse({
      ...catalog,
      release: {
        ...catalog.release,
        assets: [{ ...catalog.release.assets[0], url: "https://example.com/mcp-1.0.0.zip" }, catalog.release.assets[1]]
      }
    }).success).toBe(false);
    expect(officialWheelLockSchema.safeParse({
      schemaVersion: 1,
      target: OFFICIAL_BLENDER_MCP_TARGET,
      roots: ["blender-mcp==1.0.0"],
      dependencies: [dependency]
    }).success).toBe(false);
    expect(officialWheelLockSchema.safeParse({
      schemaVersion: 1,
      target: OFFICIAL_BLENDER_MCP_TARGET,
      roots: ["docutils==0.22.4"],
      dependencies: [{ ...dependency, name: "docutils", filename: "docutils-0.22.4-py3-none-any.whl", sha256: "missing" }]
    }).success).toBe(false);
  });
});
