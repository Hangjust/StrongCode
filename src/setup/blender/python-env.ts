import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { runProcess } from "../../tools/builtin/run-process";
import type { ArtifactProvenance, WheelLock } from "./artifact-manifest";
import {
  downloadVerifiedArtifacts,
  lockedArtifactClosure,
  verifyLocalArtifacts,
  type LockedArtifact,
  type VerifiedArtifactDownloader
} from "./artifacts";
import type { CpythonCandidate } from "./types";
import { nodeEnvironmentFileSystem } from "./python-env-io";

export { nodeEnvironmentFileSystem } from "./python-env-io";

const PROCESS_TIMEOUT_MS = 120_000;
const PROCESS_OUTPUT_BYTES = 64 * 1024;
const WRAPPER_ENTRY_FILE = "strongcode-blender-wrapper.py";

export const DISTRIBUTIONS_SENTINEL = "__STRONGCODE_BLENDER_DISTRIBUTIONS_V1__";
export const TOOLS_SENTINEL = "__STRONGCODE_BLENDER_TOOLS_V1__";
export const BLENDER_WRAPPER_TOOLS = [
  "get_scene_info",
  "get_object_info",
  "get_viewport_screenshot",
  "execute_blender_code"
] as const;

const distributionSchema = z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]*==[0-9]+(?:\.[0-9]+)*$/u));
const toolsSchema = z.tuple([
  z.literal(BLENDER_WRAPPER_TOOLS[0]),
  z.literal(BLENDER_WRAPPER_TOOLS[1]),
  z.literal(BLENDER_WRAPPER_TOOLS[2]),
  z.literal(BLENDER_WRAPPER_TOOLS[3])
]);

export type EnvironmentProcessRequest = {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly shell: false;
};

export type EnvironmentProcessResult =
  | { readonly kind: "completed"; readonly exitCode: number; readonly stdout: string; readonly stderr: string }
  | { readonly kind: "failed"; readonly message: string };

export interface EnvironmentProcessAdapter {
  run(request: EnvironmentProcessRequest): Promise<EnvironmentProcessResult>;
}

export interface EnvironmentFileSystem {
  prepare(destination: string, staging: string): Promise<void>;
  copyDirectory(source: string, destination: string): Promise<void>;
  write(filePath: string, content: string): Promise<void>;
  read(filePath: string): Promise<Uint8Array>;
  verifyFile(filePath: string, expectedSha256: string | undefined): Promise<void>;
  publish(staging: string, destination: string): Promise<void>;
  removeTree(directory: string): Promise<void>;
}

export class PythonEnvironmentError extends Error {
  readonly name = "PythonEnvironmentError";
}

export const nodeEnvironmentProcessAdapter: EnvironmentProcessAdapter = {
  async run(request) {
    const result = await runProcess({
      command: request.executable,
      args: request.args,
      cwd: request.cwd,
      env: request.env,
      timeoutMs: request.timeoutMs,
      maxOutputBytes: request.maxOutputBytes
    });
    if (!result.ok) return { kind: "failed", message: result.error.message };
    return { kind: "completed", exitCode: 0, stdout: result.value.content, stderr: "" };
  }
};

export async function stageBlenderPythonEnvironment(options: {
  readonly python: CpythonCandidate;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly lock: WheelLock;
  readonly provenance: ArtifactProvenance;
  readonly requirements: string;
  readonly wrapperAssetsPath: string;
  readonly destination: string;
  readonly downloader?: VerifiedArtifactDownloader;
  readonly process?: EnvironmentProcessAdapter;
  readonly files?: EnvironmentFileSystem;
  readonly wrapperVerifier?: (stagedWrapperPath: string) => Promise<void>;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<{ readonly pythonPath: string; readonly wrapperPath: string }> {
  requireSupportedTarget(options);
  const artifacts = lockedArtifactClosure(options.lock, options.provenance);
    parseLockedRequirements(options.lock, options.requirements);
  const destination = path.resolve(options.destination);
  const staging = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.staging`);
  const files = options.files ?? nodeEnvironmentFileSystem;
  const processAdapter = options.process ?? nodeEnvironmentProcessAdapter;
  const downloader = options.downloader ?? { download: (items, directory) =>
    downloadVerifiedArtifacts({ artifacts: items, destination: directory }) };
  const wheelhouse = path.join(staging, "wheelhouse");
  const requirementsPath = path.join(staging, "requirements.lock.txt");
  const venvPath = path.join(staging, "venv");
  const stagedPython = path.join(venvPath, "Scripts", "python.exe");
  const wrapperPath = path.join(staging, "wrapper", WRAPPER_ENTRY_FILE);
  const childEnv = isolatedEnvironment(options.env);

  await files.prepare(destination, staging);
  try {
    await files.verifyFile(options.python.executable.canonicalPath, options.python.executable.sha256);
    await downloader.download(artifacts, wheelhouse);
    await verifyLocalArtifacts(artifacts, wheelhouse, files.read);
    await files.copyDirectory(options.wrapperAssetsPath, path.join(staging, "wrapper"));
    await options.wrapperVerifier?.(path.join(staging, "wrapper"));
    await files.write(requirementsPath, options.requirements.endsWith("\n") ? options.requirements : `${options.requirements}\n`);
    await files.write(path.join(staging, "wheels.lock.json"), `${JSON.stringify(options.lock, null, 2)}\n`);
    await files.write(path.join(staging, "provenance.json"), `${JSON.stringify(options.provenance, null, 2)}\n`);

    await runChecked(processAdapter, processRequest(options.python.executable.canonicalPath,
      ["-I", "-m", "venv", venvPath], staging, childEnv));
    await runChecked(processAdapter, processRequest(stagedPython, [
      "-I", "-m", "pip", "--isolated", "install", "--no-index", "--only-binary=:all:",
      "--require-hashes", "--no-deps", "--find-links", wheelhouse, "-r", requirementsPath
    ], staging, childEnv));
    await runChecked(processAdapter, processRequest(stagedPython,
      ["-I", "-m", "pip", "--isolated", "uninstall", "--yes", "pip", "setuptools"], staging, childEnv));

    const distributions = parseSentinel(await runChecked(processAdapter, processRequest(stagedPython,
      ["-I", "-c", distributionExpression()], staging, childEnv)), DISTRIBUTIONS_SENTINEL, distributionSchema);
    const expectedDistributions = options.lock.wheels.map(wheel => `${wheel.name}==${wheel.version}`).sort();
    if (distributions.join("\n") !== expectedDistributions.join("\n")) {
      throw new PythonEnvironmentError("Installed distributions do not exactly match the wheel lock");
    }
    await options.wrapperVerifier?.(path.join(staging, "wrapper"));
    await files.verifyFile(wrapperPath, undefined);
    parseSentinel(await runChecked(processAdapter, processRequest(stagedPython,
      ["-I", wrapperPath, "--self-test"], staging, childEnv)), TOOLS_SENTINEL, toolsSchema);

    await files.publish(staging, destination);
    return {
      pythonPath: path.join(destination, "venv", "Scripts", "python.exe"),
      wrapperPath: path.join(destination, "wrapper", WRAPPER_ENTRY_FILE)
    };
  } catch (error) {
    await files.removeTree(staging);
    throw error;
  }
}

function requireSupportedTarget(options: {
  readonly python: CpythonCandidate;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly lock: WheelLock;
}): void {
  const target = options.lock.target;
  const absolute = options.platform === "win32"
    ? path.win32.isAbsolute(options.python.executable.canonicalPath)
    : path.isAbsolute(options.python.executable.canonicalPath);
  if (options.python.implementation !== "cpython"
    || options.python.version.major !== 3 || options.python.version.minor !== 11
    || options.python.pointerWidth !== 64 || options.python.sysconfigPlatform !== "win_amd64"
    || options.platform !== "win32" || options.architecture !== "x64"
    || target.implementation !== "cp" || target.python !== "3.11"
    || target.abi !== "cp311" || target.platform !== "win_amd64" || !absolute) {
    throw new PythonEnvironmentError("Blender MCP runtime requires resolved CPython 3.11 for win_amd64");
  }
}

export function parseLockedRequirements(lock: WheelLock, source: string): string {
  const actual = source.trim().split(/\r?\n/u).sort();
  const expected = lock.wheels.map(wheel => `${wheel.name}==${wheel.version} --hash=sha256:${wheel.sha256}`).sort();
  if (actual.join("\n") !== expected.join("\n")) {
    throw new PythonEnvironmentError("Requirements file does not exactly match the wheel lock");
  }
  return source;
}

function isolatedEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    SystemRoot: source.SystemRoot,
    WINDIR: source.WINDIR,
    TEMP: source.TEMP,
    TMP: source.TMP,
    PIP_CONFIG_FILE: "NUL",
    PIP_NO_INDEX: "1",
    PIP_ONLY_BINARY: ":all:",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PYTHONNOUSERSITE: "1",
    PYTHONPATH: "",
    PYTHONUTF8: "1",
    DO_NOT_TRACK: "1",
    SCARF_NO_ANALYTICS: "true",
    POSTHOG_DISABLED: "true"
  };
}

function processRequest(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): EnvironmentProcessRequest {
  return { executable, args, cwd, env, timeoutMs: PROCESS_TIMEOUT_MS, maxOutputBytes: PROCESS_OUTPUT_BYTES, shell: false };
}

async function runChecked(adapter: EnvironmentProcessAdapter, request: EnvironmentProcessRequest): Promise<string> {
  const result = await adapter.run(request);
  if (result.kind === "failed") throw new PythonEnvironmentError(result.message);
  if (result.exitCode !== 0) throw new PythonEnvironmentError(`${request.executable} exited with code ${result.exitCode}: ${result.stderr}`);
  return result.stdout;
}

function parseSentinel<T>(stdout: string, sentinel: string, schema: z.ZodType<T>): T {
  const lines = stdout.split(/\r?\n/u).filter(line => line.startsWith(sentinel));
  if (lines.length !== 1) throw new PythonEnvironmentError(`Expected one ${sentinel} self-test record`);
  const payload = lines[0]?.slice(sentinel.length);
  if (!payload) throw new PythonEnvironmentError(`Empty ${sentinel} self-test record`);
  try {
    return schema.parse(JSON.parse(payload));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new PythonEnvironmentError(`Invalid ${sentinel} self-test record`);
    }
    throw error;
  }
}

function distributionExpression(): string {
  return [
    "import importlib.metadata,json,re",
    "items=sorted(re.sub(r'[-_.]+','-',d.metadata['Name'].lower())+'=='+d.version for d in importlib.metadata.distributions())",
    `print(${JSON.stringify(DISTRIBUTIONS_SENTINEL)}+json.dumps(items,separators=(',',':')))`
  ].join(";");
}
