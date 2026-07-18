import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { extractSafeArchive, readSafeZip } from "./archive";
import type { LockedArtifact } from "./artifacts";
import type { BlenderProfileCandidate, ProbeProcessAdapter, ProbeProcessRequest } from "./types";
import { applyOfficialAddonDerivative } from "./official-derivative";

export const OFFICIAL_ADDON_MODULE = "bl_ext.user_default.mcp";
const SENTINEL = "__STRONGCODE_OFFICIAL_BLENDER_ADDON_V1__";
const PREFLIGHT_SENTINEL = "__STRONGCODE_OFFICIAL_BLENDER_PREFLIGHT_V1__";
const preflightSchema = z.object({ onlineAccess: z.boolean(), extensionsPath: z.string().min(1), background: z.literal(true) }).strict();
const probeSchema = z.object({ enabled: z.literal(true), host: z.literal("127.0.0.1"), port: z.number().int().min(49_152).max(65_535),
  profileId: z.string().min(1), configPath: z.string().min(1), running: z.literal(false),
  onlineAccess: z.literal(true), useAutostart: z.literal(true), extensionsPath: z.string().min(1),
  background: z.literal(true) }).strict();
const healthSchema = z.object({ enabled: z.boolean(), host: z.string().nullable(), port: z.number().int().nullable(),
  profileId: z.string().nullable(), configPath: z.string().nullable(), running: z.boolean().nullable(),
  onlineAccess: z.boolean(), useAutostart: z.boolean().nullable(), extensionsPath: z.string().min(1),
  background: z.literal(true) }).strict();

export class OfficialAddonError extends Error { readonly name = "OfficialAddonError"; }

export async function stageOfficialBlenderAddon(options: {
  readonly archivePath: string;
  readonly artifact: LockedArtifact;
  readonly temporaryRoot: string;
  readonly derivativeRootPath: string;
  readonly derivativeApplier?: typeof applyOfficialAddonDerivative;
}): Promise<{ readonly extensionPath: string; readonly extensionsDirectory: string }> {
  const source = await readFile(options.archivePath);
  if (path.basename(options.archivePath) !== options.artifact.filename || source.byteLength !== options.artifact.size
    || createHash("sha256").update(source).digest("hex") !== options.artifact.sha256) {
    throw new OfficialAddonError("Official Blender extension archive does not match its artifact lock");
  }
  const archive = readSafeZip(source);
  const manifest = archive.entries.find(entry => !entry.path.directory && entry.path.value === "blender_manifest.toml")?.content.toString("utf8") ?? "";
  if (!/^id\s*=\s*"mcp"\s*$/mu.test(manifest) || !/^version\s*=\s*"1\.0\.0"\s*$/mu.test(manifest)
    || !/^blender_version_min\s*=\s*"5\.1\.0"\s*$/mu.test(manifest)) throw new OfficialAddonError("Official Blender extension manifest is invalid");
  const extensionsDirectory = path.join(options.temporaryRoot, "extensions");
  const repository = path.join(extensionsDirectory, "user_default");
  const extensionPath = path.join(repository, "mcp");
  await mkdir(repository, { recursive: true, mode: 0o700 });
  let extracted: Awaited<ReturnType<typeof extractSafeArchive>> | undefined;
  try {
    extracted = await extractSafeArchive({ archive: source, parentDirectory: options.temporaryRoot, requiredManifest: "blender_manifest.toml" });
    await rename(extracted.contentRoot, extensionPath);
    await (options.derivativeApplier ?? applyOfficialAddonDerivative)({ extensionPath,
      derivativeRootPath: options.derivativeRootPath });
    if (extracted.contentRoot !== extracted.stagingPath) await rm(extracted.stagingPath, { recursive: true, force: true });
    return { extensionPath, extensionsDirectory };
  } catch (error) {
    await rm(extensionPath, { recursive: true, force: true });
    if (extracted) await rm(extracted.stagingPath, { recursive: true, force: true });
    throw error;
  }
}

export async function enableOfficialBlenderExtension(options: {
  readonly profile: BlenderProfileCandidate;
  readonly temporaryRoot: string;
  readonly configDirectory: string;
  readonly extensionsDirectory: string;
  readonly privateConfigPath: string;
  readonly persistedPrivateConfigPath: string;
  readonly process: ProbeProcessAdapter;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<void> {
  if (!isBlender51(options.profile.version)) throw new OfficialAddonError("Official Blender extension requires Blender 5.1 or newer");
  const extensionsPath = requireExtensionsPath(options.extensionsDirectory);
  const env = { SystemRoot: options.env?.SystemRoot, WINDIR: options.env?.WINDIR, TEMP: options.env?.TEMP,
    TMP: options.env?.TMP, BLENDER_USER_CONFIG: options.configDirectory, BLENDER_USER_EXTENSIONS: extensionsPath,
    DO_NOT_TRACK: "1", SCARF_NO_ANALYTICS: "true", POSTHOG_DISABLED: "true" };
  const preflightExpression = ["import bpy,json", "v={'onlineAccess':bpy.app.online_access,'extensionsPath':bpy.utils.user_resource('EXTENSIONS'),'background':bpy.app.background}",
    `print(${JSON.stringify(PREFLIGHT_SENTINEL)}+json.dumps(v,separators=(',',':')))`].join(";");
  const preflightResult = await options.process.run(request(options.profile.executable.canonicalPath, preflightExpression,
    options.temporaryRoot, env));
  const preflight = parseRecord(preflightResult, PREFLIGHT_SENTINEL, preflightSchema, "Blender extension preflight");
  if (!samePath(preflight.extensionsPath, extensionsPath)) {
    throw new OfficialAddonError("Blender EXTENSIONS resource changed or is inconsistent with the selected profile");
  }
  if (!preflight.onlineAccess) {
    throw new OfficialAddonError("Blender Online Access must be enabled in Preferences before installing the official extension; StrongCode will not enable it globally");
  }
  const expression = ["import bpy,importlib,json", `bpy.ops.preferences.addon_enable(module=${JSON.stringify(OFFICIAL_ADDON_MODULE)})`,
    `p=bpy.context.preferences.addons[${JSON.stringify(OFFICIAL_ADDON_MODULE)}].preferences`,
    `m=importlib.import_module(${JSON.stringify(`${OFFICIAL_ADDON_MODULE}.mcp_to_blender_server`)})`,
    `c=m.configure_private_config(${JSON.stringify(options.privateConfigPath)})`, "p.host=c.host", "p.port=c.port",
    `p.strongcode_config_path=${JSON.stringify(options.persistedPrivateConfigPath)}`,
    "p.use_autostart=True", "bpy.ops.wm.save_userpref()",
    `print(${JSON.stringify(SENTINEL)}+json.dumps({'enabled':${JSON.stringify(OFFICIAL_ADDON_MODULE)} in bpy.context.preferences.addons,'host':p.host,'port':p.port,'profileId':c.profile_id,'configPath':p.strongcode_config_path,'running':m.is_running(),'onlineAccess':bpy.app.online_access,'useAutostart':p.use_autostart,'extensionsPath':bpy.utils.user_resource('EXTENSIONS'),'background':bpy.app.background},separators=(',',':')))`].join(";");
  const result = await options.process.run(request(options.profile.executable.canonicalPath, expression, options.temporaryRoot, env));
  const enabled = parseRecord(result, SENTINEL, probeSchema, "Blender extension preference operation");
  if (!samePath(enabled.extensionsPath, extensionsPath)) {
    throw new OfficialAddonError("Blender EXTENSIONS resource changed during preference persistence");
  }
  if (enabled.profileId !== options.profile.profileId
    || !samePath(enabled.configPath, options.persistedPrivateConfigPath)) {
    throw new OfficialAddonError("Blender authenticated bridge configuration does not match the selected profile");
  }
}

export async function probeOfficialBlenderExtension(options: {
  readonly profile: BlenderProfileCandidate;
  readonly privateConfigPath: string;
  readonly process: ProbeProcessAdapter;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  if (!isBlender51(options.profile.version)) throw new OfficialAddonError("Official Blender extension requires Blender 5.1 or newer");
  const extensionsPath = requireExtensionsPath(options.profile.paths.extensions);
  const environment = { SystemRoot: options.env?.SystemRoot, WINDIR: options.env?.WINDIR, TEMP: options.env?.TEMP,
    TMP: options.env?.TMP, BLENDER_USER_CONFIG: options.profile.paths.config, BLENDER_USER_EXTENSIONS: extensionsPath,
    DO_NOT_TRACK: "1", SCARF_NO_ANALYTICS: "true",
    POSTHOG_DISABLED: "true" };
  const expression = ["import bpy,importlib,json", `a=${JSON.stringify(OFFICIAL_ADDON_MODULE)}`, "enabled=a in bpy.context.preferences.addons",
    "p=bpy.context.preferences.addons[a].preferences if enabled else None",
    `m=importlib.import_module(${JSON.stringify(`${OFFICIAL_ADDON_MODULE}.mcp_to_blender_server`)}) if enabled else None`,
    `c=m.configure_private_config(${JSON.stringify(options.privateConfigPath)}) if m else None`,
    "v={'enabled':enabled,'host':p.host if p else None,'port':p.port if p else None,'profileId':c.profile_id if c else None,'configPath':p.strongcode_config_path if p else None,'running':m.is_running() if m else None,'onlineAccess':bpy.app.online_access,'useAutostart':p.use_autostart if p else None,'extensionsPath':bpy.utils.user_resource('EXTENSIONS'),'background':bpy.app.background}",
    `print(${JSON.stringify(SENTINEL)}+json.dumps(v,separators=(',',':')))`].join(";");
  const result = await options.process.run(request(options.profile.executable.canonicalPath, expression,
    options.profile.paths.config, environment));
  if (result.kind !== "completed" || result.exitCode !== 0) throw new OfficialAddonError(`Blender extension health probe failed: ${result.kind}`);
  const records = result.stdout.split(/\r?\n/u).filter(line => line.startsWith(SENTINEL));
  if (records.length !== 1) throw new OfficialAddonError("Blender extension health probe returned no unique record");
  try {
    const health = healthSchema.parse(JSON.parse(records[0]?.slice(SENTINEL.length) ?? ""));
    if (!samePath(health.extensionsPath, extensionsPath)) {
      throw new OfficialAddonError("Blender EXTENSIONS resource changed or is inconsistent with the ownership receipt");
    }
    if (!health.onlineAccess) {
      throw new OfficialAddonError("Blender Online Access is disabled; enable it in Preferences before using the official extension");
    }
    return health.enabled && health.host === "127.0.0.1" && health.port !== null
      && health.port >= 49_152 && health.port <= 65_535 && health.profileId === options.profile.profileId
      && health.configPath !== null && samePath(health.configPath, options.privateConfigPath)
      && health.running === false && health.useAutostart === true;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) throw new OfficialAddonError("Blender extension health probe was invalid");
    throw error;
  }
}

function parseRecord<T>(result: Awaited<ReturnType<ProbeProcessAdapter["run"]>>, sentinel: string,
  schema: z.ZodType<T>, operation: string): T {
  if (result.kind !== "completed" || result.exitCode !== 0) throw new OfficialAddonError(`${operation} failed: ${result.kind}`);
  const records = result.stdout.split(/\r?\n/u).filter(line => line.startsWith(sentinel));
  if (records.length !== 1) throw new OfficialAddonError(`${operation} returned no unique record`);
  try { return schema.parse(JSON.parse(records[0]?.slice(sentinel.length) ?? "")); }
  catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) throw new OfficialAddonError(`${operation} returned an invalid record`);
    throw error;
  }
}

function requireExtensionsPath(value: string | undefined): string {
  if (value === undefined || !path.isAbsolute(value) || path.resolve(value) !== value
    || /[\u0000-\u001F\u007F]/u.test(value) || value.split(/[\\/]/u).includes("..")) {
    throw new OfficialAddonError("Official Blender extension requires a safe discovered EXTENSIONS resource path");
  }
  return value;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function request(executable: string, expression: string, cwd: string, env: NodeJS.ProcessEnv): ProbeProcessRequest {
  return { executable, args: ["--background", "--python-expr", expression], cwd, env, timeoutMs: 15_000, maxOutputBytes: 64 * 1024, shell: false };
}

function isBlender51(version: string): boolean {
  const match = /^(\d+)\.(\d+)/u.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 5 || (major === 5 && minor >= 1);
}
