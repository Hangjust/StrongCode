import path from "node:path";
import { z } from "zod";
import type { ArtifactProvenance, WheelLock } from "./artifact-manifest";
import { BlenderInstallError, sha256, statesEqual } from "./durable-fs";
import type { BlenderInstallerFileSystem } from "./install-files";
import type { PathState } from "./journal-schema";
import type { BlenderProfileCandidate } from "./types";

const ADDON_MODULE = "strongcode_blender_mcp";
const absolutePathSchema = z.string().min(1).refine(value => path.isAbsolute(value) && path.resolve(value) === value);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const targetSchema = z.object({
  path: absolutePathSchema,
  state: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("file"), sha256: sha256Schema }).strict(),
    z.object({ kind: z.literal("directory"), sha256: sha256Schema }).strict()
  ])
}).strict().readonly();
const blenderSchema = z.object({
  executablePath: absolutePathSchema,
  executableSha256: sha256Schema,
  version: z.string().min(1),
  configPath: absolutePathSchema,
  userResourcePath: absolutePathSchema
}).strict().readonly();
const artifactsSchema = z.object({
  upstreamCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  wheelSha256: sha256Schema,
  addonSha256: sha256Schema,
  lockSha256: sha256Schema,
  requirementsSha256: sha256Schema,
  target: z.literal("cp311-win_amd64")
}).strict().readonly();
const receiptCommonShape = {
  profileId: z.string().min(1),
  blender: blenderSchema,
  artifacts: artifactsSchema,
  addonModule: z.literal(ADDON_MODULE),
  telemetry: z.literal("off"),
  installedAt: z.string().datetime()
};

export const blenderInstallationReceiptV1Schema = z.object({
  schemaVersion: z.literal(1),
  ...receiptCommonShape,
  targets: z.array(targetSchema).min(1).readonly()
}).strict().readonly();

export const blenderInstallationReceiptV2Schema = z.object({
  schemaVersion: z.literal(2),
  ...receiptCommonShape,
  immutableTargets: z.array(targetSchema).length(3).readonly(),
  managed: z.object({
    mcp: z.object({ path: absolutePathSchema, serverId: z.literal("blender"), fragmentSha256: sha256Schema }).strict().readonly(),
    permissions: z.object({ path: absolutePathSchema, fragmentSha256: sha256Schema }).strict().readonly(),
    preferences: z.object({ path: absolutePathSchema, profileId: z.string().min(1), addonModule: z.literal(ADDON_MODULE) })
      .strict().readonly()
  }).strict().readonly()
}).strict().readonly();

export const blenderInstallationReceiptSchema = z.union([
  blenderInstallationReceiptV1Schema,
  blenderInstallationReceiptV2Schema
]);

export type BlenderInstallationReceipt = z.infer<typeof blenderInstallationReceiptSchema>;
export type BlenderInstallationReceiptV2 = z.infer<typeof blenderInstallationReceiptV2Schema>;

export async function readInstallationReceipt(options: {
  readonly receiptPath: string;
  readonly files: BlenderInstallerFileSystem;
}): Promise<BlenderInstallationReceipt | undefined> {
  const state = await options.files.state(options.receiptPath);
  if (state.kind === "absent") return undefined;
  if (state.kind !== "file") throw new BlenderInstallError("conflict", `Blender ownership receipt is not a file: ${options.receiptPath}`);
  let value: unknown;
  try {
    value = JSON.parse((await options.files.readFile(options.receiptPath)).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new BlenderInstallError("conflict", "Blender ownership receipt is malformed");
    throw error;
  }
  const parsed = blenderInstallationReceiptSchema.safeParse(value);
  if (!parsed.success) throw new BlenderInstallError("conflict", "Blender ownership receipt is invalid");
  return parsed.data;
}

export function createInstallationReceipt(options: {
  readonly profile: BlenderProfileCandidate;
  readonly lock: WheelLock;
  readonly provenance: ArtifactProvenance;
  readonly requirements: string;
  readonly immutableTargets: readonly { readonly path: string; readonly state: PathState }[];
  readonly managed: {
    readonly mcp: { readonly path: string; readonly fragmentSha256: string };
    readonly permissions: { readonly path: string; readonly fragmentSha256: string };
    readonly preferencesPath: string;
  };
}): BlenderInstallationReceiptV2 {
  const wheel = options.provenance.artifacts[0];
  const addon = options.provenance.artifacts[1];
  const target = options.lock.target;
  if (target.python !== "3.11" || target.abi !== "cp311" || target.platform !== "win_amd64") {
    throw new BlenderInstallError("conflict", "Blender ownership receipt requires the locked CPython 3.11 win_amd64 target");
  }
  const immutableTargets = options.immutableTargets.map(item => {
    if (item.state.kind === "absent") throw new BlenderInstallError("conflict", `Cannot receipt an absent target: ${item.path}`);
    return { path: path.resolve(item.path), state: item.state };
  });
  return blenderInstallationReceiptV2Schema.parse({
    schemaVersion: 2,
    profileId: options.profile.profileId,
    blender: {
      executablePath: path.resolve(options.profile.executable.canonicalPath),
      executableSha256: options.profile.executable.sha256,
      version: options.profile.version,
      configPath: path.resolve(options.profile.paths.config),
      userResourcePath: path.resolve(options.profile.paths.resources.user)
    },
    artifacts: {
      upstreamCommit: options.provenance.upstream.commit,
      wheelSha256: wheel.sha256,
      addonSha256: addon.sha256,
      lockSha256: sha256(JSON.stringify(options.lock)),
      requirementsSha256: sha256(options.requirements),
      target: "cp311-win_amd64"
    },
    addonModule: ADDON_MODULE,
    telemetry: "off",
    installedAt: new Date().toISOString(),
    immutableTargets,
    managed: {
      mcp: { path: path.resolve(options.managed.mcp.path), serverId: "blender", fragmentSha256: options.managed.mcp.fragmentSha256 },
      permissions: { path: path.resolve(options.managed.permissions.path), fragmentSha256: options.managed.permissions.fragmentSha256 },
      preferences: { path: path.resolve(options.managed.preferencesPath), profileId: options.profile.profileId, addonModule: ADDON_MODULE }
    }
  });
}

type ReceiptOwnershipOptions = {
  readonly receipt: BlenderInstallationReceipt;
  readonly profile: BlenderProfileCandidate;
  readonly immutableTargetPaths: readonly string[];
  readonly legacyTargetPaths: readonly string[];
  readonly mcpPath: string;
  readonly permissionsPath: string;
  readonly preferencesPath: string;
};

function samePaths(actual: readonly string[], expected: readonly string[]): boolean {
  return [...actual].sort().join("\n") === expected.map(item => path.resolve(item)).sort().join("\n");
}

function unsupportedReceipt(receipt: never): never {
  throw new BlenderInstallError("invalid-journal", `Unsupported Blender receipt: ${JSON.stringify(receipt)}`);
}

export function assertInstallationReceiptOwnership(options: ReceiptOwnershipOptions): void {
  const receipt = options.receipt;
  const sameProfilePaths = receipt.profileId === options.profile.profileId
    && receipt.blender.executablePath === path.resolve(options.profile.executable.canonicalPath)
    && receipt.blender.configPath === path.resolve(options.profile.paths.config)
    && receipt.blender.userResourcePath === path.resolve(options.profile.paths.resources.user);
  if (!sameProfilePaths) throw new BlenderInstallError("conflict", "Blender receipt ownership does not match the selected profile paths");
  switch (receipt.schemaVersion) {
    case 1:
      if (!samePaths(receipt.targets.map(target => target.path), options.legacyTargetPaths)) {
        throw new BlenderInstallError("conflict", "Legacy Blender receipt target paths do not match the exact expected paths");
      }
      return;
    case 2: {
      const managedPathsMatch = samePaths(receipt.immutableTargets.map(target => target.path), options.immutableTargetPaths)
        && receipt.managed.mcp.path === path.resolve(options.mcpPath)
        && receipt.managed.permissions.path === path.resolve(options.permissionsPath)
        && receipt.managed.preferences.path === path.resolve(options.preferencesPath)
        && receipt.managed.preferences.profileId === options.profile.profileId;
      if (!managedPathsMatch) throw new BlenderInstallError("conflict", "Blender receipt target paths do not match the exact expected paths");
      return;
    }
    default:
      return unsupportedReceipt(receipt);
  }
}

export async function installationReceiptMatches(options: ReceiptOwnershipOptions & {
  readonly provenance: ArtifactProvenance;
  readonly lock: WheelLock;
  readonly requirements: string;
  readonly mcpFragmentSha256: string;
  readonly permissionsFragmentSha256: string;
  readonly files: BlenderInstallerFileSystem;
}): Promise<boolean> {
  assertInstallationReceiptOwnership(options);
  const receipt = options.receipt;
  switch (receipt.schemaVersion) {
    case 1:
      return false;
    case 2: {
      const metadataMatches = receipt.blender.executableSha256 === options.profile.executable.sha256
        && receipt.blender.version === options.profile.version
        && receipt.artifacts.upstreamCommit === options.provenance.upstream.commit
        && receipt.artifacts.wheelSha256 === options.provenance.artifacts[0].sha256
        && receipt.artifacts.addonSha256 === options.provenance.artifacts[1].sha256
        && receipt.artifacts.lockSha256 === sha256(JSON.stringify(options.lock))
        && receipt.artifacts.requirementsSha256 === sha256(options.requirements)
        && receipt.managed.mcp.fragmentSha256 === options.mcpFragmentSha256
        && receipt.managed.permissions.fragmentSha256 === options.permissionsFragmentSha256;
      if (!metadataMatches) return false;
      for (const target of receipt.immutableTargets) {
        if (!statesEqual(await options.files.state(target.path), target.state)) return false;
      }
      return true;
    }
    default:
      return unsupportedReceipt(receipt);
  }
}
