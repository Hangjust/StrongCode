import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { spawnContainedProcess, terminateProcessTree } from "../../tools/builtin/run-process";
import { hashExecutable, trustExecutablePath } from "./executables";
import type {
  BlenderProfileCandidate,
  CpythonCandidate,
  ProbeProcessAdapter,
  ProbeProcessRequest,
  ProbeProcessResult,
  TrustedExecutableCandidate
} from "./types";

export const BLENDER_PROBE_SENTINEL = "__STRONGCODE_BLENDER_PROBE_V1__";
export const CPYTHON_PROBE_SENTINEL = "__STRONGCODE_CPYTHON_PROBE_V1__";

const absolutePathSchema = z.string().min(1).max(4096).refine(value =>
  path.isAbsolute(value)
  && !/[\u0000-\u001F\u007F]/u.test(value)
  && !value.split(/[\\/]/u).includes("..")
);
const blenderPayloadSchema = z.object({
  version: z.string().regex(/^\d+\.\d+(?:\.\d+)?(?:[-+._A-Za-z0-9]*)?$/u).max(64),
  resourcePaths: z.object({
    local: absolutePathSchema,
    system: absolutePathSchema,
    user: absolutePathSchema
  }).strict(),
  configPath: absolutePathSchema,
  scriptsPaths: z.array(absolutePathSchema).max(32)
}).strict();
const pythonPayloadSchema = z.object({
  implementation: z.literal("cpython"),
  version: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative()]),
  executable: absolutePathSchema,
  prefix: absolutePathSchema,
  pointerWidth: z.union([z.literal(32), z.literal(64)]),
  sysconfigPlatform: z.string().regex(/^[a-z0-9_]+$/u).max(64)
}).strict();

const BLENDER_EXPRESSION = [
  "import bpy,json",
  `print(${JSON.stringify(BLENDER_PROBE_SENTINEL)}+json.dumps({`,
  "'version':bpy.app.version_string,",
  "'resourcePaths':{k.lower():bpy.utils.resource_path(k) for k in ('LOCAL','SYSTEM','USER')},",
  "'configPath':bpy.utils.user_resource('CONFIG'),",
  "'scriptsPaths':bpy.utils.script_paths()",
  "},separators=(',',':')))"
].join("");
const PYTHON_EXPRESSION = [
  "import json,re,struct,sys,sysconfig;",
  `print(${JSON.stringify(CPYTHON_PROBE_SENTINEL)}+json.dumps({`,
  "'implementation':sys.implementation.name,",
  "'version':list(sys.version_info[:3]),",
  "'executable':sys.executable,",
  "'prefix':sys.prefix,",
  "'pointerWidth':struct.calcsize('P')*8,",
  "'sysconfigPlatform':re.sub(r'[-.]','_',sysconfig.get_platform().lower())",
  "},separators=(',',':')))"
].join("");

export const nodeProbeProcessAdapter: ProbeProcessAdapter = {
  async run(request: ProbeProcessRequest): Promise<ProbeProcessResult> {
    return new Promise(resolve => {
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let stopResult: { readonly kind: "timeout" } | { readonly kind: "overflow" } | undefined;
      let child;
      try {
        child = spawnContainedProcess({
          executable: request.executable,
          args: request.args,
          cwd: request.cwd,
          env: request.env
        });
      } catch (error) {
        resolve({
          kind: "spawn-error",
          message: error instanceof Error ? error.message : String(error)
        });
        return;
      }
      const finish = (result: ProbeProcessResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      };
      const requestStop = (result: { readonly kind: "timeout" } | { readonly kind: "overflow" }): void => {
        if (stopResult || settled) return;
        stopResult = result;
        void terminateProcessTree(child).then(
          () => finish(result),
          error => finish({
            kind: "spawn-error",
            message: error instanceof Error ? error.message : String(error)
          })
        );
      };
      const append = (
        current: Buffer<ArrayBufferLike>,
        chunk: Buffer<ArrayBufferLike>
      ): Buffer<ArrayBufferLike> | undefined => {
        if (current.length + chunk.length > request.maxOutputBytes) {
          requestStop({ kind: "overflow" });
          return undefined;
        }
        return Buffer.concat([current, chunk]);
      };
      child.stdout?.on("data", chunk => {
        const next = append(stdout, Buffer.from(chunk));
        if (next) stdout = next;
      });
      child.stderr?.on("data", chunk => {
        const next = append(stderr, Buffer.from(chunk));
        if (next) stderr = next;
      });
      child.once("error", error => {
        if (!stopResult) finish({ kind: "spawn-error", message: error.message });
      });
      child.once("close", code => {
        if (stopResult) return;
        finish({
          kind: "completed",
          exitCode: code,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8")
        });
      });
      timer = setTimeout(() => requestStop({ kind: "timeout" }), request.timeoutMs);
      timer.unref();
    });
  }
};

function sentinelPayload(stdout: string, sentinel: string, maxOutputBytes: number): unknown | undefined {
  if (Buffer.byteLength(stdout, "utf8") > maxOutputBytes) return undefined;
  const matches = stdout.split(/\r?\n/u).filter(line => line.startsWith(sentinel));
  if (matches.length !== 1) return undefined;
  const payload = matches[0]?.slice(sentinel.length);
  if (!payload) return undefined;
  try {
    return JSON.parse(payload);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function completedPayload(
  processAdapter: ProbeProcessAdapter,
  request: ProbeProcessRequest,
  sentinel: string
): Promise<unknown | undefined> {
  const result = await processAdapter.run(request);
  if (result.kind !== "completed" || result.exitCode !== 0) return undefined;
  if (Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8") > request.maxOutputBytes) return undefined;
  return sentinelPayload(result.stdout, sentinel, request.maxOutputBytes);
}

export async function probeBlender(
  candidate: TrustedExecutableCandidate,
  options: {
    readonly workspace: string;
    readonly process: ProbeProcessAdapter;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
  }
): Promise<BlenderProfileCandidate | undefined> {
  const payload = await completedPayload(options.process, {
    executable: candidate.canonicalPath,
    args: ["--background", "--factory-startup", "--python-expr", BLENDER_EXPRESSION],
    cwd: options.workspace,
    env: candidate.env,
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
    shell: false
  }, BLENDER_PROBE_SENTINEL);
  const parsed = blenderPayloadSchema.safeParse(payload);
  if (!parsed.success) return undefined;
  const executableHash = await hashExecutable(candidate.canonicalPath);
  if (!executableHash) return undefined;
  const profileIdentity = createHash("sha256").update(JSON.stringify({
    executable: candidate.canonicalPath,
    executableHash,
    version: parsed.data.version,
    config: parsed.data.configPath,
    scripts: parsed.data.scriptsPaths
  })).digest("hex");
  return {
    profileId: `blender-${profileIdentity.slice(0, 24)}`,
    executable: { canonicalPath: candidate.canonicalPath, sha256: executableHash },
    version: parsed.data.version,
    paths: {
      resources: parsed.data.resourcePaths,
      config: parsed.data.configPath,
      scripts: parsed.data.scriptsPaths
    },
    sources: candidate.sources
  };
}

export async function probeCpython(
  candidate: TrustedExecutableCandidate,
  options: {
    readonly workspace: string;
    readonly platform: NodeJS.Platform;
    readonly process: ProbeProcessAdapter;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
  }
): Promise<CpythonCandidate | undefined> {
  const payload = await completedPayload(options.process, {
    executable: candidate.canonicalPath,
    args: ["-I", "-S", "-c", PYTHON_EXPRESSION],
    cwd: options.workspace,
    env: candidate.env,
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
    shell: false
  }, CPYTHON_PROBE_SENTINEL);
  const parsed = pythonPayloadSchema.safeParse(payload);
  if (!parsed.success
    || parsed.data.version[0] !== 3
    || parsed.data.version[1] !== 11
    || parsed.data.pointerWidth !== 64
    || parsed.data.sysconfigPlatform !== "win_amd64") return undefined;
  const trusted = await trustExecutablePath({
    candidate: parsed.data.executable,
    kind: "python",
    workspace: options.workspace,
    env: candidate.env,
    platform: options.platform
  });
  if (!trusted) return undefined;
  const executableHash = await hashExecutable(trusted.canonicalPath);
  if (!executableHash) return undefined;
  return {
    executable: { canonicalPath: trusted.canonicalPath, sha256: executableHash },
    implementation: "cpython",
    version: {
      major: parsed.data.version[0],
      minor: parsed.data.version[1],
      patch: parsed.data.version[2]
    },
    prefix: parsed.data.prefix,
    pointerWidth: 64,
    sysconfigPlatform: "win_amd64"
  };
}
