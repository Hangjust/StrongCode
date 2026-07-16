import { createHash } from "node:crypto";
import { link, lstat, mkdtemp, readFile, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureStrongCodeHome } from "../src/config/home";
import { loadConfig, type ConfigSourceMetadata } from "../src/config/load";
import { inspectPath } from "../src/core/path-identity";
import { deriveConfigTrust } from "../src/runtime/config-trust";
import { requireRuntime } from "../src/runtime/factory";

type RuntimeEnvironment = {
  readonly homePath: string;
  readonly workspace: string;
};

async function inRuntimeEnvironment<T>(
  environment: RuntimeEnvironment,
  run: () => Promise<T>
): Promise<T> {
  const previousHome = process.env.STRONGCODE_HOME;
  const previousTrust = process.env.STRONGCODE_TRUST_PROJECT_CONFIG;
  const previousCwd = process.cwd();
  try {
    process.env.STRONGCODE_HOME = environment.homePath;
    delete process.env.STRONGCODE_TRUST_PROJECT_CONFIG;
    process.chdir(environment.workspace);
    return await run();
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.STRONGCODE_HOME;
    else process.env.STRONGCODE_HOME = previousHome;
    if (previousTrust === undefined) delete process.env.STRONGCODE_TRUST_PROJECT_CONFIG;
    else process.env.STRONGCODE_TRUST_PROJECT_CONFIG = previousTrust;
  }
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe.sequential("automatic home config provenance", () => {
  it("records selection cause and carries only automatic-home receipts into runtime context", async () => {
    // Given
    const homePath = await mkdtemp(path.join(tmpdir(), "strongcode-source-home-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "strongcode-source-workspace-"));
    await ensureStrongCodeHome({ homePath });
    const configPath = path.join(homePath, "strongcode.config.yaml");

    await inRuntimeEnvironment({ homePath, workspace }, async () => {
      // When
      const automatic = await loadConfig();
      const automaticRuntime = await requireRuntime();
      const explicit = await loadConfig(configPath);
      const explicitRuntime = await requireRuntime(configPath);
      await writeFile(path.join(workspace, "strongcode.config.yaml"), await readFile(configPath));
      const project = await loadConfig();

      // Then
      expect(automatic).toMatchObject({ ok: true, value: { source: { kind: "automatic-home" } } });
      if (!automatic.ok || automatic.value.source.kind !== "automatic-home") return;
      expect(Object.isFrozen(automatic.value.source)).toBe(true);
      expect(Object.isFrozen(automatic.value.source.receipt)).toBe(true);
      expect(automaticRuntime.context.automaticHomeReceipt?.targetPath).toBe(configPath);
      expect(explicit).toMatchObject({ ok: true, value: { source: { kind: "explicit", atHomePath: true } } });
      expect(explicitRuntime.context.automaticHomeReceipt).toBeUndefined();
      expect(project).toMatchObject({ ok: true, value: { source: { kind: "automatic-project" } } });
    });
  });

  it("rejects a linked home root while preserving explicit trust", async () => {
    // Given
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-linked-home-"));
    const realHome = path.join(root, "real-home");
    const linkedHome = path.join(root, "linked-home");
    const workspace = await mkdtemp(path.join(tmpdir(), "strongcode-linked-workspace-"));
    await ensureStrongCodeHome({ homePath: realHome });
    await symlink(realHome, linkedHome, process.platform === "win32" ? "junction" : "dir");

    await inRuntimeEnvironment({ homePath: linkedHome, workspace }, async () => {
      // When / Then
      await expect(requireRuntime()).rejects.toThrow("linked path component");
      await expect(requireRuntime(path.join(linkedHome, "strongcode.config.yaml")))
        .resolves.toMatchObject({ trustedConfig: true, trustedProjectInstructions: false });
    });
  });

  it("rejects a linked ancestor above the home root", async () => {
    // Given
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-linked-ancestor-"));
    const external = path.join(root, "external");
    const realHome = path.join(external, "home");
    const linkedAncestor = path.join(root, "linked-ancestor");
    const workspace = await mkdtemp(path.join(tmpdir(), "strongcode-ancestor-workspace-"));
    await ensureStrongCodeHome({ homePath: realHome });
    await symlink(external, linkedAncestor, process.platform === "win32" ? "junction" : "dir");

    await inRuntimeEnvironment({ homePath: path.join(linkedAncestor, "home"), workspace }, async () => {
      // When / Then
      await expect(requireRuntime()).rejects.toThrow("linked path component");
    });
  });

  it("rejects a hardlinked automatic config without changing its external source", async () => {
    // Given
    const homePath = await mkdtemp(path.join(tmpdir(), "strongcode-hardlinked-home-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "strongcode-hardlinked-workspace-"));
    await ensureStrongCodeHome({ homePath });
    const configPath = path.join(homePath, "strongcode.config.yaml");
    const externalSource = path.join(path.dirname(homePath), `${path.basename(homePath)}-source.yaml`);
    const sourceBytes = await readFile(configPath);
    await writeFile(externalSource, sourceBytes);
    await unlink(configPath);
    await link(externalSource, configPath);
    const before = digest(await readFile(externalSource));
    expect((await lstat(configPath, { bigint: true })).nlink).toBe(2n);

    await inRuntimeEnvironment({ homePath, workspace }, async () => {
      // When / Then
      await expect(requireRuntime()).rejects.toThrow("hardlinked regular file");
      await expect(requireRuntime(configPath)).resolves.toMatchObject({ trustedConfig: true });
    });
    expect(digest(await readFile(externalSource))).toBe(before);
  });

  it("applies the receipt policy to automatic-home model catalogs only", async () => {
    // Given
    const homePath = await mkdtemp(path.join(tmpdir(), "strongcode-hardlinked-models-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "strongcode-model-workspace-"));
    await ensureStrongCodeHome({ homePath });
    const configPath = path.join(homePath, "strongcode.config.yaml");
    const catalogPath = path.join(homePath, "models.json");
    const externalSource = path.join(path.dirname(homePath), `${path.basename(homePath)}-models.json`);
    await writeFile(externalSource, await readFile(catalogPath));
    await unlink(catalogPath);
    await link(externalSource, catalogPath);
    expect((await lstat(catalogPath, { bigint: true })).nlink).toBe(2n);

    await inRuntimeEnvironment({ homePath, workspace }, async () => {
      // When / Then
      await expect(requireRuntime()).rejects.toThrow("hardlinked regular file");
      await expect(requireRuntime(configPath)).resolves.toMatchObject({ trustedConfig: true });
    });
  });

  it("derives every trust-matrix row from source cause", async () => {
    // Given
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-trust-matrix-"));
    const configPath = path.join(root, "strongcode.config.yaml");
    await writeFile(configPath, "version: 1\n", "utf8");
    const receipt = await inspectPath(configPath, { finalKind: "regular-file", requireSingleLink: true });
    const automaticHome: ConfigSourceMetadata = { kind: "automatic-home", receipt };
    const automaticProject: ConfigSourceMetadata = { kind: "automatic-project" };
    const explicitHome: ConfigSourceMetadata = { kind: "explicit", atHomePath: true };
    const explicitProject: ConfigSourceMetadata = { kind: "explicit", atHomePath: false };
    const rows = [
      [automaticHome, false, true, false],
      [automaticHome, true, true, true],
      [automaticProject, false, false, false],
      [automaticProject, true, true, true],
      [explicitHome, false, true, false],
      [explicitProject, false, true, true],
      [explicitHome, true, true, true]
    ] as const;

    // When
    const decisions = await Promise.all(rows.map(row => deriveConfigTrust(row[0], row[1])));

    // Then
    expect(decisions.map(decision => [decision.trustedConfig, decision.trustedProjectInstructions]))
      .toEqual(rows.map(row => [row[2], row[3]]));
  });

  it("revalidates an automatic-home receipt immediately before granting trust", async () => {
    // Given
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-trust-revalidate-"));
    const configPath = path.join(root, "strongcode.config.yaml");
    await writeFile(configPath, "version: 1\n", "utf8");
    const receipt = await inspectPath(configPath, { finalKind: "regular-file", requireSingleLink: true });
    await rename(configPath, path.join(root, "original.yaml"));
    await writeFile(configPath, "version: 2\n", "utf8");

    // When / Then
    await expect(deriveConfigTrust({ kind: "automatic-home", receipt }, false))
      .rejects.toMatchObject({ reason: "identity-changed" });
  });
});
