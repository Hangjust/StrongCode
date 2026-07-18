import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { extractSafeArchive } from "./archive";
import { downloadVerifiedArtifacts, officialArtifactClosure, verifyLocalArtifacts, type VerifiedArtifactDownloader } from "./artifacts";
import type { OfficialArtifactCatalog, OfficialWheelLock } from "./official-artifact-manifest";
import { parseOfficialRequirements } from "./official-artifact-parser";
import { validateOfficialProjectArchive } from "./official-project";
import { applyOfficialRuntimeDerivative } from "./official-derivative";
import { nodeEnvironmentFileSystem, nodeEnvironmentProcessAdapter, type EnvironmentFileSystem, type EnvironmentProcessAdapter, type EnvironmentProcessRequest } from "./python-env";
import type { CpythonCandidate } from "./types";

const SENTINEL = "__STRONGCODE_OFFICIAL_BLENDER_RUNTIME_V1__";
const LAUNCHER = "blender-mcp.py";
export const OFFICIAL_BLENDER_LAUNCHER_SOURCE = [
  "from __future__ import annotations",
  "",
  "import sys",
  "",
  "from blmcp import main",
  "from blmcp.tools_helpers.connection import configure_private_config",
  "",
  "",
  "def strongcode_main() -> int:",
  "    flag = '--strongcode-config'",
  "    if sys.argv.count(flag) != 1:",
  "        raise SystemExit('StrongCode private bridge config path is required')",
  "    index = sys.argv.index(flag)",
  "    if index + 1 >= len(sys.argv):",
  "        raise SystemExit('StrongCode private bridge config path is required')",
  "    config_path = sys.argv[index + 1]",
  "    del sys.argv[index:index + 2]",
  "    configure_private_config(config_path)",
  "    return main()",
  "",
  "",
  "if __name__ == '__main__':",
  "    raise SystemExit(strongcode_main())",
  ""
].join("\n");
const healthSchema = z.object({ importable: z.literal(true), distributions: z.array(z.string()) }).strict();

export class OfficialRuntimeError extends Error { readonly name = "OfficialRuntimeError"; }

export type OfficialRuntime = { readonly pythonPath: string; readonly launcherPath: string };

export async function stageOfficialBlenderRuntime(options: {
  readonly python: CpythonCandidate;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly catalog: OfficialArtifactCatalog;
  readonly lock: OfficialWheelLock;
  readonly requirements: string;
  readonly derivativeRootPath: string;
  readonly privateConfigPath: string;
  readonly destination: string;
  readonly downloader?: VerifiedArtifactDownloader;
  readonly process?: EnvironmentProcessAdapter;
  readonly files?: EnvironmentFileSystem;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<OfficialRuntime> {
  requireTarget(options);
  parseOfficialRequirements(options.lock, options.requirements);
  const destination = path.resolve(options.destination);
  const staging = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.staging`);
  const files = options.files ?? nodeEnvironmentFileSystem;
  const processAdapter = options.process ?? nodeEnvironmentProcessAdapter;
  const artifacts = officialArtifactClosure(options.catalog, options.lock);
  const wheelhouse = path.join(staging, "wheelhouse");
  const venv = path.join(staging, "venv");
  const pythonPath = path.join(venv, "Scripts", "python.exe");
  const requirementsPath = path.join(staging, "requirements.lock.txt");
  const launcherPath = path.join(staging, LAUNCHER);
  const environment = isolatedEnvironment(options.env);
  await files.prepare(destination, staging);
  try {
    await files.verifyFile(options.python.executable.canonicalPath, options.python.executable.sha256);
    const downloader = options.downloader ?? { download: (items, directory) => downloadVerifiedArtifacts({ artifacts: items, destination: directory }) };
    await downloader.download(artifacts, wheelhouse);
    await verifyLocalArtifacts(artifacts, wheelhouse, files.read);
    const mcpb = await readFile(path.join(wheelhouse, options.catalog.root.artifact));
    validateOfficialProjectArchive(mcpb, options.catalog);
    const extracted = await extractSafeArchive({ archive: mcpb, parentDirectory: staging, requiredManifest: "pyproject.toml" });
    await applyOfficialRuntimeDerivative({ contentRoot: extracted.contentRoot,
      derivativeRootPath: options.derivativeRootPath });
    await files.write(requirementsPath, options.requirements.endsWith("\n") ? options.requirements : `${options.requirements}\n`);
    await files.write(launcherPath, OFFICIAL_BLENDER_LAUNCHER_SOURCE);
    await runChecked(processAdapter, request(options.python.executable.canonicalPath, ["-I", "-m", "venv", venv], staging, environment));
    await runChecked(processAdapter, request(pythonPath, ["-I", "-m", "pip", "--isolated", "install", "--no-index", "--only-binary=:all:", "--require-hashes", "--no-deps", "--find-links", wheelhouse, "-r", requirementsPath], staging, environment));
    await runChecked(processAdapter, request(pythonPath, ["-I", "-m", "pip", "--isolated", "install", "--no-index", "--no-build-isolation", "--no-deps", path.resolve(extracted.contentRoot)], staging, environment));
    await runChecked(processAdapter, request(pythonPath, ["-I", "-m", "pip", "--isolated", "uninstall", "--yes", "pip", "setuptools"], staging, environment));
    const expected = [...options.lock.dependencies.map(item => `${item.name}==${item.version}`), "blender-mcp==1.0.0"].sort();
    validateOfficialRuntimeHealth(await runChecked(processAdapter, request(pythonPath, ["-I", "-c", healthExpression()], staging, environment)), expected);
    await files.verifyFile(launcherPath, createHash("sha256").update(OFFICIAL_BLENDER_LAUNCHER_SOURCE).digest("hex"));
    await runChecked(processAdapter, request(pythonPath,
      ["-I", launcherPath, "--strongcode-config", options.privateConfigPath, "--help"], staging, environment));
    await files.publish(staging, destination);
    return { pythonPath: path.join(destination, "venv", "Scripts", "python.exe"), launcherPath: path.join(destination, LAUNCHER) };
  } catch (error) {
    await files.removeTree(staging);
    throw error;
  }
}

function requireTarget(options: { readonly python: CpythonCandidate; readonly platform: NodeJS.Platform; readonly architecture: string }): void {
  const item = options.python;
  if (options.platform !== "win32" || options.architecture !== "x64" || item.version.major !== 3 || item.version.minor !== 11
    || item.pointerWidth !== 64 || item.sysconfigPlatform !== "win_amd64" || !path.win32.isAbsolute(item.executable.canonicalPath)) {
    throw new OfficialRuntimeError("Official Blender MCP requires CPython 3.11 win_amd64");
  }
}

function isolatedEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { SystemRoot: source.SystemRoot, WINDIR: source.WINDIR, TEMP: source.TEMP, TMP: source.TMP, PIP_CONFIG_FILE: "NUL", PIP_NO_INDEX: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1", PYTHONNOUSERSITE: "1", PYTHONPATH: "", PYTHONUTF8: "1", DO_NOT_TRACK: "1", SCARF_NO_ANALYTICS: "true", POSTHOG_DISABLED: "true" };
}

function request(executable: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): EnvironmentProcessRequest {
  return { executable, args, cwd, env, timeoutMs: 120_000, maxOutputBytes: 64 * 1024, shell: false };
}

async function runChecked(adapter: EnvironmentProcessAdapter, processRequest: EnvironmentProcessRequest): Promise<string> {
  const result = await adapter.run(processRequest);
  if (result.kind === "failed") throw new OfficialRuntimeError(result.message);
  if (result.exitCode !== 0) throw new OfficialRuntimeError(`Official runtime process exited with code ${result.exitCode}: ${result.stderr}`);
  return result.stdout;
}

function healthExpression(): string {
  return ["import blmcp,importlib.metadata,json,re", "items=sorted(re.sub(r'[-_.]+','-',d.metadata['Name'].lower())+'=='+d.version for d in importlib.metadata.distributions())", `print(${JSON.stringify(SENTINEL)}+json.dumps({'importable':callable(blmcp.main),'distributions':items},separators=(',',':')))`].join(";");
}

function parseHealth(stdout: string): z.infer<typeof healthSchema> {
  const lines = stdout.split(/\r?\n/u).filter(line => line.startsWith(SENTINEL));
  if (lines.length !== 1) throw new OfficialRuntimeError("Official runtime self-test returned no unique record");
  try { return healthSchema.parse(JSON.parse(lines[0]?.slice(SENTINEL.length) ?? "")); }
  catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) throw new OfficialRuntimeError("Official runtime self-test record is invalid");
    throw error;
  }
}

export function validateOfficialRuntimeHealth(stdout: string, expectedDistributions: readonly string[]): void {
  const health = parseHealth(stdout);
  if (health.distributions.join("\n") !== [...expectedDistributions].sort().join("\n")) {
    throw new OfficialRuntimeError("Installed distributions do not exactly match the official lock");
  }
}

export function validateOfficialLauncherSource(source: string): void {
  if (source !== OFFICIAL_BLENDER_LAUNCHER_SOURCE) throw new OfficialRuntimeError("Official Blender MCP launcher was modified");
}
