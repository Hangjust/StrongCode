import path from "node:path";
import { z } from "zod";
import { BlenderInstallError } from "./durable-fs";
import type { BlenderProfileCandidate, ProbeProcessAdapter, ProbeProcessRequest } from "./types";

const PROCESS_TIMEOUT_MS = 15_000;
const PROCESS_OUTPUT_BYTES = 64 * 1024;
const ADDON_MODULE = "strongcode_blender_mcp";
const PROFILE_ENV = "STRONGCODE_BLENDER_MCP_PROFILE";

export const BLENDER_ADDON_PROBE_SENTINEL = "__STRONGCODE_BLENDER_ADDON_PROBE_V1__";

const probeSchema = z.object({
  addonEnabled: z.boolean(),
  background: z.literal(true),
  rendezvousExists: z.boolean()
}).strict().readonly();

const enableExpression = [
  "import bpy",
  `bpy.ops.preferences.addon_enable(module=${JSON.stringify(ADDON_MODULE)})`,
  "bpy.ops.wm.save_userpref()"
].join(";");

const probeExpression = [
  "import bpy,json,os,pathlib",
  `p=pathlib.Path(os.environ[${JSON.stringify(PROFILE_ENV)}])/'rendezvous.json'`,
  `v={'addonEnabled':${JSON.stringify(ADDON_MODULE)} in bpy.context.preferences.addons,'background':bpy.app.background,'rendezvousExists':p.exists()}`,
  `print(${JSON.stringify(BLENDER_ADDON_PROBE_SENTINEL)}+json.dumps(v,separators=(',',':'),sort_keys=True))`
].join(";");

export async function generateBlenderPreferences(options: {
  readonly profile: BlenderProfileCandidate;
  readonly temporaryRoot: string;
  readonly configDirectory: string;
  readonly scriptsDirectory: string;
  readonly privateProfilePath: string;
  readonly process: ProbeProcessAdapter;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const environment = blenderEnvironment(options);
  await runCompleted(options.process, request(options.profile.executable.canonicalPath, enableExpression,
    options.temporaryRoot, environment));
  const result = await probe(options.process, request(options.profile.executable.canonicalPath, probeExpression,
    options.temporaryRoot, environment));
  requireSafeBackgroundProbe(result);
}

export async function probeInstalledBlenderAddon(options: {
  readonly profile: BlenderProfileCandidate;
  readonly privateProfilePath: string;
  readonly process: ProbeProcessAdapter;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const scriptsDirectory = path.join(options.profile.paths.resources.user, "scripts");
  const result = await probe(options.process, request(
    options.profile.executable.canonicalPath,
    probeExpression,
    options.profile.paths.config,
    blenderEnvironment({
      ...options,
      configDirectory: options.profile.paths.config,
      scriptsDirectory
    })
  ));
  return result.addonEnabled && !result.rendezvousExists;
}

function blenderEnvironment(options: {
  readonly configDirectory: string;
  readonly scriptsDirectory: string;
  readonly privateProfilePath: string;
  readonly env?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  return {
    SystemRoot: options.env?.SystemRoot,
    WINDIR: options.env?.WINDIR,
    TEMP: options.env?.TEMP,
    TMP: options.env?.TMP,
    LANG: options.env?.LANG,
    LC_ALL: options.env?.LC_ALL,
    BLENDER_USER_CONFIG: options.configDirectory,
    BLENDER_USER_SCRIPTS: options.scriptsDirectory,
    [PROFILE_ENV]: options.privateProfilePath,
    DO_NOT_TRACK: "1",
    SCARF_NO_ANALYTICS: "true",
    POSTHOG_DISABLED: "true"
  };
}

function request(executable: string, expression: string, cwd: string, env: NodeJS.ProcessEnv): ProbeProcessRequest {
  return {
    executable,
    args: ["--background", "--python-expr", expression],
    cwd,
    env,
    timeoutMs: PROCESS_TIMEOUT_MS,
    maxOutputBytes: PROCESS_OUTPUT_BYTES,
    shell: false
  };
}

async function probe(process: ProbeProcessAdapter, processRequest: ProbeProcessRequest): Promise<z.infer<typeof probeSchema>> {
  const stdout = await runCompleted(process, processRequest);
  const lines = stdout.split(/\r?\n/u).filter(line => line.startsWith(BLENDER_ADDON_PROBE_SENTINEL));
  if (lines.length !== 1) throw new BlenderInstallError("conflict", "Blender background probe returned no unique addon record");
  const payload = lines[0]?.slice(BLENDER_ADDON_PROBE_SENTINEL.length);
  if (!payload) throw new BlenderInstallError("conflict", "Blender background probe returned an empty addon record");
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch (error) {
    if (error instanceof SyntaxError) throw new BlenderInstallError("conflict", "Blender background probe returned invalid JSON");
    throw error;
  }
  const parsed = probeSchema.safeParse(value);
  if (!parsed.success) throw new BlenderInstallError("conflict", "Blender background probe returned an invalid addon record");
  return parsed.data;
}

async function runCompleted(process: ProbeProcessAdapter, processRequest: ProbeProcessRequest): Promise<string> {
  const result = await process.run(processRequest);
  if (result.kind !== "completed" || result.exitCode !== 0) {
    throw new BlenderInstallError("conflict", `Blender background operation failed: ${result.kind}`);
  }
  return result.stdout;
}

function requireSafeBackgroundProbe(result: z.infer<typeof probeSchema>): void {
  if (!result.addonEnabled) throw new BlenderInstallError("conflict", "Blender addon was not enabled in generated preferences");
  if (result.rendezvousExists) throw new BlenderInstallError("conflict", "Blender background verification created or observed a rendezvous listener");
}
