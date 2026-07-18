import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OFFICIAL_ADDON_MODULE, enableOfficialBlenderExtension, probeOfficialBlenderExtension, stageOfficialBlenderAddon } from "../src/setup/blender/official-addon";
import { probeOfficialBlenderMcp, type OfficialMcpProbeAdapter } from "../src/setup/blender/official-mcp-probe";
import { validateOfficialProjectArchive } from "../src/setup/blender/official-project";
import { applyExactReplacement, readOfficialDerivativeIdentity } from "../src/setup/blender/official-derivative";
import { OFFICIAL_BLENDER_LAUNCHER_SOURCE, validateOfficialLauncherSource, validateOfficialRuntimeHealth } from "../src/setup/blender/official-runtime";
import type { ProbeProcessAdapter, ProbeProcessRequest } from "../src/setup/blender/types";
import { buildZip } from "./zip-fixtures";

const pyproject = `[build-system]\nrequires = ["setuptools>=68.0"]\nbuild-backend = "setuptools.build_meta"\n\n[project]\nname = "blender-mcp"\nversion = "1.0.0"\nrequires-python = ">=3.10"\ndependencies = [\n "docutils",\n "mcp[cli]>=1.2.0",\n "pyyaml",\n]\n\n[project.scripts]\nblender-mcp = "blmcp:main"\n`;
const manifest = JSON.stringify({ manifest_version: "0.4", name: "Blender", version: "1.0.0", server: { type: "uv", entry_point: "blmcp/__init__.py" }, compatibility: { runtimes: { python: ">= 3.10" } } });

function project(lock = "official lock", project = pyproject, descriptor = manifest): Buffer {
  return buildZip([{ name: "pyproject.toml", content: project }, { name: "manifest.json", content: descriptor }, { name: "uv.lock", content: lock }, { name: "blmcp/__init__.py", content: "def main(): pass\n" }]);
}

function identity(lock = "official lock") {
  return { lockSource: { path: "uv.lock", size: Buffer.byteLength(lock), sha256: createHash("sha256").update(lock).digest("hex") } };
}

describe("official Blender MCP project validation", () => {
  it("accepts only the locked project, entrypoint, dependency names, runtime, and uv.lock", () => {
    // Given / When
    const verified = validateOfficialProjectArchive(project(), identity());

    // Then
    expect(verified.root).toBe("");
  });

  it.each([
    ["project", project("official lock", pyproject.replace("1.0.0", "1.0.1")), identity(), /pyproject/i],
    ["lock", project("tampered"), identity(), /uv\.lock/i],
    ["manifest", project("official lock", pyproject, manifest.replace('"0.4"', '"0.5"')), identity(), /manifest/i]
  ])("rejects a tampered %s before execution", (_label, archive, catalog, expected) => {
    // When / Then
    expect(() => validateOfficialProjectArchive(archive, catalog)).toThrow(expected);
  });
});

describe("official authenticated derivative", () => {
  it("pins every checked-in derivative asset and exact upstream identity", async () => {
    // Given / When
    const identity = await readOfficialDerivativeIdentity(path.join(process.cwd(), "assets", "blender-mcp", "official-derivative"));

    // Then
    expect(identity.upstream).toMatchObject({ version: "1.0.0", commit: "03004fd0216bfe5e0a3d9ac9b47d5efadc3d78c4" });
  });

  it("rejects missing or ambiguous patch context", () => {
    // Given / When / Then
    expect(() => applyExactReplacement("before and before", { before: "before", after: "after" }))
      .toThrow(/exactly once/iu);
    expect(() => applyExactReplacement("different", { before: "before", after: "after" }))
      .toThrow(/exactly once/iu);
  });
});

class BlenderFixture implements ProbeProcessAdapter {
  request: ProbeProcessRequest | undefined;
  readonly requests: ProbeProcessRequest[] = [];
  constructor(private readonly stdout: string | readonly string[]) {}
  async run(request: ProbeProcessRequest) {
    this.request = request;
    this.requests.push(request);
    const stdout = typeof this.stdout === "string" ? this.stdout : this.stdout[this.requests.length - 1] ?? "";
    return { kind: "completed" as const, exitCode: 0, stdout, stderr: "" };
  }
}

describe("official Blender extension staging", () => {
  it("stages the mcp extension tree and enables the Blender 5.1 module with fixed loopback defaults", async () => {
    // Given
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-official-addon-"));
    const archivePath = path.join(root, "mcp.zip");
    const archive = buildZip([{ name: "blender_manifest.toml", content: 'schema_version = "1.0.0"\nid = "mcp"\nversion = "1.0.0"\nblender_version_min = "5.1.0"\n' }, { name: "__init__.py", content: "" }]);
    await writeFile(archivePath, archive);
    const artifact = { filename: "mcp.zip", url: "https://projects.blender.org/releases/mcp.zip", size: archive.byteLength, sha256: createHash("sha256").update(archive).digest("hex") };
    const preflight = `__STRONGCODE_OFFICIAL_BLENDER_PREFLIGHT_V1__${JSON.stringify({ onlineAccess: true,
      extensionsPath: path.join(root, "extensions"), background: true })}\n`;
    const privateConfigPath = path.join(root, "official.json");
    const record = `__STRONGCODE_OFFICIAL_BLENDER_ADDON_V1__${JSON.stringify({ enabled: true, host: "127.0.0.1", port: 54321,
      profileId: "5.1", configPath: privateConfigPath, running: false,
      onlineAccess: true, useAutostart: true, extensionsPath: path.join(root, "extensions"), background: true })}\n`;
    const processAdapter = new BlenderFixture([preflight, record]);

    // When
    const staged = await stageOfficialBlenderAddon({ archivePath, artifact, temporaryRoot: root,
      derivativeRootPath: root, derivativeApplier: async () => {} });
    await enableOfficialBlenderExtension({ profile: { profileId: "5.1", executable: { canonicalPath: "C:\\Blender\\blender.exe", sha256: "a".repeat(64) }, version: "5.1.0", paths: { resources: { local: root, system: root, user: root }, config: root, scripts: [], extensions: path.join(root, "extensions") }, sources: ["path"] }, temporaryRoot: root, configDirectory: path.join(root, "config"), extensionsDirectory: staged.extensionsDirectory, privateConfigPath, persistedPrivateConfigPath: privateConfigPath, process: processAdapter, env: { SECRET: "no" } });

    // Then
    expect((await stat(path.join(staged.extensionPath, "__init__.py"))).isFile()).toBe(true);
    expect(processAdapter.request?.args.join(" ")).toContain(OFFICIAL_ADDON_MODULE);
    expect(processAdapter.request?.env.SECRET).toBeUndefined();
    expect(processAdapter.request?.env.BLENDER_USER_EXTENSIONS).toBe(staged.extensionsDirectory);
    expect(processAdapter.request?.args.join(" ")).toContain("use_autostart=True");
    expect(processAdapter.requests).toHaveLength(2);
    expect(processAdapter.request?.shell).toBe(false);
  });

  it("rejects a tampered extension artifact and manifest", async () => {
    // Given
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-official-addon-reject-"));
    const archivePath = path.join(root, "mcp.zip");
    const archive = buildZip([{ name: "blender_manifest.toml", content: 'id = "mcp"\nversion = "1.0.1"\nblender_version_min = "5.1.0"\n' }]);
    await writeFile(archivePath, archive);
    const artifact = { filename: "mcp.zip", url: "https://projects.blender.org/releases/mcp.zip", size: archive.byteLength, sha256: createHash("sha256").update(archive).digest("hex") };

    // When / Then
    await expect(stageOfficialBlenderAddon({ archivePath, artifact: { ...artifact, sha256: "0".repeat(64) },
      temporaryRoot: root, derivativeRootPath: root })).rejects.toThrow(/artifact lock/i);
    await expect(stageOfficialBlenderAddon({ archivePath, artifact, temporaryRoot: root,
      derivativeRootPath: root })).rejects.toThrow(/manifest/i);
  });

  it("probes live official preferences without enabling or saving them", async () => {
    // Given
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-official-addon-probe-"));
    const extensions = path.join(root, "extensions");
    const privateConfigPath = path.join(root, "official.json");
    const record = `__STRONGCODE_OFFICIAL_BLENDER_ADDON_V1__${JSON.stringify({ enabled: true, host: "127.0.0.1", port: 54321,
      profileId: "5.1", configPath: privateConfigPath, running: false,
      onlineAccess: true, useAutostart: true, extensionsPath: extensions, background: true })}\n`;
    const processAdapter = new BlenderFixture(record);

    // When
    const enabled = await probeOfficialBlenderExtension({
      profile: { profileId: "5.1", executable: { canonicalPath: "C:\\Blender\\blender.exe", sha256: "a".repeat(64) },
        version: "5.1.0", paths: { resources: { local: root, system: root, user: root }, config: root, scripts: [], extensions }, sources: ["path"] },
      privateConfigPath,
      process: processAdapter,
      env: { SECRET: "no" }
    });

    // Then
    expect(enabled).toBe(true);
    expect(processAdapter.request?.args.join(" ")).not.toMatch(/addon_enable|save_userpref/u);
    expect(processAdapter.request?.env.SECRET).toBeUndefined();
  });

  it("refuses offline enablement before addon mutation and reports actionable guidance", async () => {
    // Given
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-official-addon-offline-"));
    const extensions = path.join(root, "extensions");
    const preflight = `__STRONGCODE_OFFICIAL_BLENDER_PREFLIGHT_V1__${JSON.stringify({ onlineAccess: false,
      extensionsPath: extensions, background: true })}\n`;
    const processAdapter = new BlenderFixture(preflight);

    // When / Then
    await expect(enableOfficialBlenderExtension({ profile: { profileId: "5.1",
      executable: { canonicalPath: "C:\\Blender\\blender.exe", sha256: "a".repeat(64) }, version: "5.1.0",
      paths: { resources: { local: root, system: root, user: root }, config: root, scripts: [], extensions }, sources: ["path"] },
      temporaryRoot: root, configDirectory: path.join(root, "config"), extensionsDirectory: extensions,
      privateConfigPath: path.join(root, "staged-official.json"), persistedPrivateConfigPath: path.join(root, "official.json"),
      process: processAdapter })).rejects.toThrow(/Online Access.*Preferences.*will not enable/iu);
    expect(processAdapter.requests).toHaveLength(1);
    expect(processAdapter.requests[0]?.args.join(" ")).not.toContain("addon_enable");
  });

  it("distinguishes disabled autostart from an otherwise healthy live extension", async () => {
    // Given
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-official-addon-autostart-"));
    const extensions = path.join(root, "extensions");
    const privateConfigPath = path.join(root, "official.json");
    const record = `__STRONGCODE_OFFICIAL_BLENDER_ADDON_V1__${JSON.stringify({ enabled: true, host: "127.0.0.1", port: 54321,
      profileId: "5.1", configPath: privateConfigPath, running: false,
      onlineAccess: true, useAutostart: false, extensionsPath: extensions, background: true })}\n`;

    // When
    const enabled = await probeOfficialBlenderExtension({ profile: { profileId: "5.1",
      executable: { canonicalPath: "C:\\Blender\\blender.exe", sha256: "a".repeat(64) }, version: "5.1.0",
      paths: { resources: { local: root, system: root, user: root }, config: root, scripts: [], extensions }, sources: ["path"] },
      privateConfigPath,
      process: new BlenderFixture(record) });

    // Then
    expect(enabled).toBe(false);
  });

  it("reports offline live health separately from disabled autostart", async () => {
    // Given
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-official-addon-live-offline-"));
    const extensions = path.join(root, "extensions");
    const privateConfigPath = path.join(root, "official.json");
    const record = `__STRONGCODE_OFFICIAL_BLENDER_ADDON_V1__${JSON.stringify({ enabled: true, host: "127.0.0.1", port: 54321,
      profileId: "5.1", configPath: privateConfigPath, running: false,
      onlineAccess: false, useAutostart: true, extensionsPath: extensions, background: true })}\n`;

    // When / Then
    await expect(probeOfficialBlenderExtension({ profile: { profileId: "5.1",
      executable: { canonicalPath: "C:\\Blender\\blender.exe", sha256: "a".repeat(64) }, version: "5.1.0",
      paths: { resources: { local: root, system: root, user: root }, config: root, scripts: [], extensions }, sources: ["path"] },
      privateConfigPath,
      process: new BlenderFixture(record) })).rejects.toThrow(/Online Access is disabled/iu);
  });
});

describe("official MCP stdio health probe", () => {
  it("initializes and lists tools with a scrubbed bounded request without invoking a tool", async () => {
    // Given
    let observed: Parameters<OfficialMcpProbeAdapter["probe"]>[0] | undefined;
    const adapter: OfficialMcpProbeAdapter = { async probe(request) { observed = request; return [{ name: "get_scene_info" }]; } };

    // When
    const tools = await probeOfficialBlenderMcp({ pythonPath: "C:\\runtime\\python.exe", launcherPath: "C:\\runtime\\blender-mcp.py", privateConfigPath: "C:\\profile\\official.json", cwd: "C:\\runtime", adapter, env: { SECRET: "no", SystemRoot: "C:\\Windows" } });

    // Then
    expect(tools).toEqual(["get_scene_info"]);
    expect(observed?.env.SECRET).toBeUndefined();
    expect(observed).toMatchObject({ shell: false, startupTimeoutMs: 15_000, requestTimeoutMs: 15_000 });
    expect(observed?.args).toEqual(["-I", "C:\\runtime\\blender-mcp.py", "--strongcode-config", "C:\\profile\\official.json"]);
  });

  it("rejects a malformed tools-list handshake", async () => {
    // Given
    const adapter: OfficialMcpProbeAdapter = { async probe() { return [{ title: "missing name" }]; } };

    // When / Then
    await expect(probeOfficialBlenderMcp({ pythonPath: "python.exe", launcherPath: "launcher.py",
      privateConfigPath: "official.json", cwd: ".", adapter })).rejects.toThrow(/handshake/i);
  });
});

describe("official runtime health records", () => {
  it("rejects a tampered distribution set and launcher", () => {
    // Given
    const record = `__STRONGCODE_OFFICIAL_BLENDER_RUNTIME_V1__${JSON.stringify({ importable: true, distributions: ["blender-mcp==1.0.0", "wrong==1.0.0"] })}\n`;

    // When / Then
    expect(() => validateOfficialRuntimeHealth(record, ["blender-mcp==1.0.0", "mcp==1.27.0"])).toThrow(/distributions/i);
    expect(() => validateOfficialLauncherSource(`${OFFICIAL_BLENDER_LAUNCHER_SOURCE}# tampered\n`)).toThrow(/launcher/i);
    expect(OFFICIAL_BLENDER_LAUNCHER_SOURCE).not.toMatch(/\.staging|AppData|Temp/iu);
  });
});
