import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OfficialInstallBlenderIntegrationOptions } from "../src/setup/blender/install";
import { nodeBlenderInstallerFileSystem } from "../src/setup/blender/install-files";
import { parseOfficialArtifactCatalogJson, parseOfficialWheelLockJson } from "../src/setup/blender/official-artifact-parser";
import type { OfficialMcpProbeAdapter, OfficialMcpProbeRequest } from "../src/setup/blender/official-mcp-probe";
import { OFFICIAL_BLENDER_LAUNCHER_SOURCE } from "../src/setup/blender/official-runtime";
import type { EnvironmentProcessAdapter } from "../src/setup/blender/python-env";

const roots = new Set<string>();
const hash = (source: string | Buffer): string => createHash("sha256").update(source).digest("hex");
const assetRoot = path.join(process.cwd(), "assets", "blender-mcp");

export const officialMcpSource = `${JSON.stringify({
  version: 1,
  defaults: { autoStart: false, timeout: { startupMs: 15000, requestMs: 60000 }, environment: { inherit: false, allowlist: ["PATH"] } },
  mcpServers: {},
  webSearch: { providers: [] },
  templates: { user: { preserved: true } }
}, null, 2)}\n`;

export const officialYamlSource = `# preserved heading
version: 1
workspace: .
dataDir: .strongcode
defaultAgent: tesla
agents:
  tesla:
    model: mock
    tools: [read_file]
models:
  mock:
    provider: mock
permissions:
  tools:
    read_file: allow # preserved rule
`;

export type OfficialInstallFixture = {
  readonly root: string;
  readonly homePath: string;
  readonly options: OfficialInstallBlenderIntegrationOptions;
  readonly runtimeStages: string[];
  readonly addonStages: string[];
  readonly probes: OfficialMcpProbeRequest[];
};

export async function cleanupOfficialInstallFixtures(): Promise<void> {
  await Promise.all([...roots].map(root => rm(root, { recursive: true, force: true })));
  roots.clear();
}

export async function officialInstallFixture(): Promise<OfficialInstallFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "strongcode-official-install-"));
  roots.add(root);
  const homePath = path.join(root, "home");
  const configPath = path.join(root, "Blender", "5.1", "config");
  const userResourcePath = path.join(root, "Blender", "5.1", "user");
  const extensionsPath = path.join(root, "Blender", "5.1", "extensions");
  const blenderPath = path.join(root, "Blender", "blender.exe");
  const pythonPath = path.join(root, "Python311", "python.exe");
  await Promise.all([
    mkdir(path.join(homePath, "mcps", "blender"), { recursive: true }),
    mkdir(configPath, { recursive: true }),
    mkdir(path.join(userResourcePath, "scripts"), { recursive: true }),
    mkdir(path.dirname(blenderPath), { recursive: true }),
    mkdir(path.dirname(pythonPath), { recursive: true })
  ]);
  await Promise.all([
    writeFile(path.join(homePath, "mcp.json"), officialMcpSource, "utf8"),
    writeFile(path.join(homePath, "strongcode.config.yaml"), officialYamlSource, "utf8"),
    writeFile(path.join(configPath, "userpref.blend"), "user preferences\n", "utf8"),
    writeFile(blenderPath, "official blender", "utf8"),
    writeFile(pythonPath, "cpython 3.11", "utf8")
  ]);
  const [catalogSource, lockSource, requirements] = await Promise.all([
    readFile(path.join(assetRoot, "official-catalog.json"), "utf8"),
    readFile(path.join(assetRoot, "official-wheels.lock.json"), "utf8"),
    readFile(path.join(assetRoot, "official-requirements.lock.txt"), "utf8")
  ]);
  const catalog = parseOfficialArtifactCatalogJson(catalogSource);
  const runtimeStages: string[] = [];
  const addonStages: string[] = [];
  const probes: OfficialMcpProbeRequest[] = [];
  const mcpProbe: OfficialMcpProbeAdapter = {
    async probe(request) {
      probes.push(request);
      return [{ name: "get_scene_info" }, { name: "execute_blender_code" }];
    }
  };
  const environmentProcess: EnvironmentProcessAdapter = {
    async run() { return { kind: "completed", exitCode: 0, stdout: "", stderr: "" }; }
  };
  const options: OfficialInstallBlenderIntegrationOptions = {
    homePath,
    selection: {
      flavor: "official",
      profile: {
        profileId: "blender-5-1",
        executable: { canonicalPath: blenderPath, sha256: hash("official blender") },
        version: "5.1.0",
        paths: { resources: { local: root, system: root, user: userResourcePath }, config: configPath,
          extensions: extensionsPath,
          scripts: [path.join(userResourcePath, "scripts")] },
        sources: ["association"]
      },
      version: { major: 5, minor: 1, patch: 0 }
    },
    python: {
      executable: { canonicalPath: pythonPath, sha256: hash("cpython 3.11") },
      implementation: "cpython",
      version: { major: 3, minor: 11, patch: 9 },
      prefix: path.dirname(pythonPath),
      pointerWidth: 64,
      sysconfigPlatform: "win_amd64"
    },
    platform: "win32",
    architecture: "x64",
    catalog,
    lock: parseOfficialWheelLockJson(lockSource),
    requirements,
    derivativeAssetsPath: path.join(assetRoot, "official-derivative"),
    files: nodeBlenderInstallerFileSystem,
    environmentProcess,
    mcpProbe,
    runtimeStager: async stage => {
      runtimeStages.push(stage.destination);
      const launcherPath = path.join(stage.destination, "blender-mcp.py");
      await Promise.all([
        mkdir(path.join(stage.destination, "venv", "Scripts"), { recursive: true }),
        mkdir(path.join(stage.destination, "wheelhouse"), { recursive: true })
      ]);
      await Promise.all([
        writeFile(path.join(stage.destination, "venv", "Scripts", "python.exe"), "private python", "utf8"),
        writeFile(launcherPath, OFFICIAL_BLENDER_LAUNCHER_SOURCE, "utf8"),
        writeFile(path.join(stage.destination, "wheelhouse", catalog.release.assets[0].filename), "unused", "utf8")
      ]);
      return { pythonPath: path.join(stage.destination, "venv", "Scripts", "python.exe"), launcherPath };
    },
    addonStager: async stage => {
      addonStages.push(stage.temporaryRoot);
      const extensionsDirectory = path.join(stage.temporaryRoot, "extensions");
      const extensionPath = path.join(extensionsDirectory, "user_default", "mcp");
      await mkdir(extensionPath, { recursive: true });
      await writeFile(path.join(extensionPath, "__init__.py"), "official addon", "utf8");
      return { extensionPath, extensionsDirectory };
    },
    extensionEnabler: async stage => {
      await mkdir(stage.configDirectory, { recursive: true });
      const preferences = path.join(stage.configDirectory, "userpref.blend");
      if ((await nodeBlenderInstallerFileSystem.state(preferences)).kind === "absent") {
        await writeFile(preferences, "official preferences\n", "utf8");
      }
    },
    extensionProbe: async () => true
  };
  return { root, homePath, options, runtimeStages, addonStages, probes };
}

export function officialInstallTargets(value: OfficialInstallFixture) {
  const runtime = path.join(value.homePath, "mcps", "blender", "runtimes", "official-1.0.0-cp311-win_amd64");
  return { runtime, launcher: path.join(runtime, "blender-mcp.py"),
    privateConfig: path.join(value.options.selection.profile.paths.config, "strongcode_blender_mcp", "official.json"),
    addon: path.join(value.options.selection.profile.paths.extensions ?? "missing-extensions", "user_default", "mcp"),
    preferences: path.join(value.options.selection.profile.paths.config, "userpref.blend"),
    receipt: path.join(value.homePath, "mcps", "blender", "installation.json"),
    mcp: path.join(value.homePath, "mcp.json"), permissions: path.join(value.homePath, "strongcode.config.yaml") };
}

export async function officialInstallTreeSnapshot(root: string): Promise<readonly string[]> {
  const result: string[] = [];
  const visit = async (current: string, relative: string): Promise<void> => {
    const stats = await lstat(current);
    if (!stats.isDirectory()) { result.push(`${relative}:file:${hash(await readFile(current))}`); return; }
    result.push(`${relative}:directory`);
    for (const name of (await readdir(current)).sort()) await visit(path.join(current, name), relative ? `${relative}/${name}` : name);
  };
  await visit(root, "");
  return result;
}
