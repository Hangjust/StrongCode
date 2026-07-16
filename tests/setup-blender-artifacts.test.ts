import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  BLENDER_MCP_ADDON,
  BLENDER_MCP_MANIFEST_PATHS,
  BLENDER_MCP_SUPPORTED_TARGET,
  BLENDER_MCP_WHEEL,
  artifactProvenanceSchema,
  parseArtifactProvenanceJson,
  parseWheelLockJson,
  wheelLockSchema
} from "../src/setup/blender/artifact-manifest";
import {
  nodeBlenderInstallerFileSystem,
  verifyDerivativeWrapperAssets
} from "../src/setup/blender/install-files";

const EXPECTED_CLOSURE = [
  "annotated-doc==0.0.4",
  "annotated-types==0.7.0",
  "anyio==4.14.2",
  "attrs==26.1.0",
  "blender-mcp==1.6.4",
  "certifi==2026.6.17",
  "cffi==2.1.0",
  "click==8.4.2",
  "colorama==0.4.6",
  "cryptography==49.0.0",
  "h11==0.16.0",
  "httpcore==1.0.9",
  "httpx-sse==0.4.3",
  "httpx==0.28.1",
  "idna==3.18",
  "jsonschema-specifications==2025.9.1",
  "jsonschema==4.26.0",
  "markdown-it-py==4.2.0",
  "mcp==1.28.1",
  "mdurl==0.1.2",
  "pycparser==3.0",
  "pydantic-core==2.46.4",
  "pydantic-settings==2.14.2",
  "pydantic==2.13.4",
  "pygments==2.20.0",
  "pyjwt==2.13.0",
  "python-dotenv==1.2.2",
  "python-multipart==0.0.32",
  "pywin32==312",
  "referencing==0.37.0",
  "rich==15.0.0",
  "rpds-py==2026.6.3",
  "shellingham==1.5.4",
  "sse-starlette==3.4.5",
  "starlette==1.3.1",
  "typer==0.26.8",
  "typing-extensions==4.16.0",
  "typing-inspection==0.4.2",
  "uvicorn==0.51.0"
] as const;

const ASSET_ROOT = path.join(process.cwd(), "assets", "blender-mcp");

describe("Blender MCP artifact contract", () => {
  it("parses commit-pinned upstream provenance with complete license coverage", async () => {
    const provenance = parseArtifactProvenanceJson(
      await readFile(path.join(ASSET_ROOT, BLENDER_MCP_MANIFEST_PATHS.provenance), "utf8")
    );
    const license = await readFile(path.join(ASSET_ROOT, BLENDER_MCP_MANIFEST_PATHS.license));

    expect(provenance.artifacts).toEqual([BLENDER_MCP_WHEEL, BLENDER_MCP_ADDON]);
    expect(provenance.license).toMatchObject({
      path: BLENDER_MCP_MANIFEST_PATHS.license,
      spdx: "MIT",
      sourceSha256: "049501fd54d27852507853a5b88094ca1c6ff97404418a5032f3310eecc9cde6",
      appliesTo: [BLENDER_MCP_WHEEL.filename, BLENDER_MCP_ADDON.filename]
    });
    expect(createHash("sha256").update(license).digest("hex")).toBe(provenance.license.sha256);
    expect(provenance.derivatives.length).toBeGreaterThan(0);
    for (const derivative of provenance.derivatives) {
      expect(derivative.licensePath).toBe(BLENDER_MCP_MANIFEST_PATHS.license);
      const content = await readFile(path.join(ASSET_ROOT, derivative.path));
      expect(createHash("sha256").update(content).digest("hex")).toBe(derivative.sha256);
    }
  });

  it("verifies the explicit runtime-wrapper root against prefixed derivative provenance", async () => {
    // Given
    const provenance = parseArtifactProvenanceJson(
      await readFile(path.join(ASSET_ROOT, BLENDER_MCP_MANIFEST_PATHS.provenance), "utf8")
    );

    // When / Then
    await expect(verifyDerivativeWrapperAssets({
      wrapperAssetsPath: path.join(ASSET_ROOT, "runtime-wrapper"),
      provenance,
      files: nodeBlenderInstallerFileSystem
    })).resolves.toBeUndefined();
  });

  it("locks the exact wheel-only closure for the sole supported runtime target", async () => {
    const lock = parseWheelLockJson(
      await readFile(path.join(ASSET_ROOT, BLENDER_MCP_MANIFEST_PATHS.wheels), "utf8")
    );
    const requirements = (await readFile(
      path.join(ASSET_ROOT, BLENDER_MCP_MANIFEST_PATHS.requirements),
      "utf8"
    )).trim().split(/\r?\n/u);
    const notices = await readFile(path.join(ASSET_ROOT, BLENDER_MCP_MANIFEST_PATHS.notices), "utf8");

    expect(lock.target).toEqual(BLENDER_MCP_SUPPORTED_TARGET);
    expect(lock.roots).toEqual(["blender-mcp==1.6.4", "mcp[cli]==1.28.1", "httpx==0.28.1"]);
    expect(lock.wheels.map(wheel => `${wheel.name}==${wheel.version}`).sort()).toEqual([...EXPECTED_CLOSURE].sort());
    expect(requirements).toHaveLength(lock.wheels.length);
    expect(requirements.every(line => /^[a-z0-9][a-z0-9._-]*==[0-9]+(?:\.[0-9]+)* --hash=sha256:[a-f0-9]{64}$/u.test(line))).toBe(true);
    for (const wheel of lock.wheels) {
      expect(wheel.filename.endsWith(".whl")).toBe(true);
      expect(wheel.url).toBe(`https://files.pythonhosted.org${new URL(wheel.url).pathname}`);
      expect(requirements).toContain(`${wheel.name}==${wheel.version} --hash=sha256:${wheel.sha256}`);
      expect(notices).toContain(`| ${wheel.name} | ${wheel.version} | ${wheel.license} |`);
    }
  });

  it("rejects floating, source-build, VCS, and unsupported-target lock inputs", () => {
    const wheel = {
      name: "example",
      version: "1.0.0",
      filename: "example-1.0.0-py3-none-any.whl",
      url: "https://files.pythonhosted.org/packages/aa/bb/example-1.0.0-py3-none-any.whl",
      size: 1,
      sha256: "a".repeat(64),
      requiresPython: ">=3.10",
      license: "MIT"
    };
    const valid = {
      schemaVersion: 1,
      target: BLENDER_MCP_SUPPORTED_TARGET,
      roots: ["example==1.0.0"],
      wheels: [wheel]
    };
    const invalidLocks = [
      { ...valid, roots: ["example>=1.0.0"] },
      { ...valid, roots: ["example==*"] },
      { ...valid, roots: ["-e example==1.0.0"] },
      { ...valid, roots: ["example @ https://example.com/example.whl"] },
      { ...valid, wheels: [{ ...wheel, filename: "example-1.0.0.tar.gz" }] },
      { ...valid, wheels: [{ ...wheel, url: "git+https://github.com/example/example.git" }] },
      { ...valid, target: { ...BLENDER_MCP_SUPPORTED_TARGET, python: "3.12" } },
      { ...valid, unexpected: true }
    ];

    for (const invalid of invalidLocks) expect(wheelLockSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects addon provenance that floats away from its recorded commit", () => {
    const invalid = {
      schemaVersion: 1,
      upstream: { repository: "https://github.com/ahujasid/blender-mcp", commit: BLENDER_MCP_ADDON.commit },
      artifacts: [
        BLENDER_MCP_WHEEL,
        { ...BLENDER_MCP_ADDON, url: "https://raw.githubusercontent.com/ahujasid/blender-mcp/main/addon.py" }
      ],
      license: {
        path: "LICENSE",
        spdx: "MIT",
        sourceUrl: "https://raw.githubusercontent.com/ahujasid/blender-mcp/main/LICENSE",
        sha256: "a".repeat(64),
        sourceSha256: "a".repeat(64),
        appliesTo: [BLENDER_MCP_WHEEL.filename, BLENDER_MCP_ADDON.filename]
      },
      derivatives: []
    };

    expect(artifactProvenanceSchema.safeParse(invalid).success).toBe(false);
  });
});
