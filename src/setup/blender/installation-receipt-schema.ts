import path from "node:path";
import { z } from "zod";
import { OFFICIAL_BLENDER_MCP_RELEASE } from "./official-artifact-manifest";

const LEGACY_ADDON_MODULE = "strongcode_blender_mcp";
const absolutePathSchema = z.string().min(1).refine(value => path.isAbsolute(value) && path.resolve(value) === value);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const addonModuleSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.]{0,255}$/u);
const presentPathStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), sha256: sha256Schema }).strict(),
  z.object({ kind: z.literal("directory"), sha256: sha256Schema }).strict()
]);
const legacyTargetSchema = z.object({
  path: absolutePathSchema,
  state: presentPathStateSchema
}).strict().readonly();
const blenderSchema = z.object({
  executablePath: absolutePathSchema,
  executableSha256: sha256Schema,
  version: z.string().min(1),
  configPath: absolutePathSchema,
  userResourcePath: absolutePathSchema,
  extensionsPath: absolutePathSchema.optional()
}).strict().readonly();
const legacyArtifactsSchema = z.object({
  upstreamCommit: commitSchema,
  wheelSha256: sha256Schema,
  addonSha256: sha256Schema,
  lockSha256: sha256Schema,
  requirementsSha256: sha256Schema,
  target: z.literal("cp311-win_amd64")
}).strict().readonly();
const legacyReceiptCommonShape = {
  profileId: z.string().min(1),
  blender: blenderSchema,
  artifacts: legacyArtifactsSchema,
  addonModule: z.literal(LEGACY_ADDON_MODULE),
  telemetry: z.literal("off"),
  installedAt: z.string().datetime()
};

export const blenderInstallationReceiptV1Schema = z.object({
  schemaVersion: z.literal(1),
  ...legacyReceiptCommonShape,
  targets: z.array(legacyTargetSchema).min(1).readonly()
}).strict().readonly();

export const blenderInstallationReceiptV2Schema = z.object({
  schemaVersion: z.literal(2),
  ...legacyReceiptCommonShape,
  immutableTargets: z.array(legacyTargetSchema).length(3).readonly(),
  managed: z.object({
    mcp: z.object({ path: absolutePathSchema, serverId: z.literal("blender"), fragmentSha256: sha256Schema }).strict().readonly(),
    permissions: z.object({ path: absolutePathSchema, fragmentSha256: sha256Schema }).strict().readonly(),
    preferences: z.object({ path: absolutePathSchema, profileId: z.string().min(1), addonModule: z.literal(LEGACY_ADDON_MODULE) })
      .strict().readonly()
  }).strict().readonly()
}).strict().readonly();

export const BLENDER_INSTALLATION_TARGET_ROLES = ["private-config", "addon", "runtime"] as const;
const v3TargetSchema = z.object({
  role: z.enum(BLENDER_INSTALLATION_TARGET_ROLES),
  path: absolutePathSchema,
  state: presentPathStateSchema
}).strict().readonly();
const pythonSchema = z.object({
  executablePath: absolutePathSchema,
  executableSha256: sha256Schema,
  implementation: z.literal("cpython"),
  version: z.object({
    major: z.literal(3),
    minor: z.literal(11),
    patch: z.number().int().nonnegative()
  }).strict().readonly(),
  pointerWidth: z.literal(64),
  sysconfigTarget: z.literal("win_amd64")
}).strict().readonly();
const predecessorSchema = z.object({
  receiptSha256: sha256Schema,
  flavor: z.enum(["legacy", "official"]),
  profileId: z.string().min(1)
}).strict().readonly();
const managedSchema = z.object({
  mcp: z.object({
    path: absolutePathSchema,
    serverId: z.literal("blender"),
    fragmentSha256: sha256Schema
  }).strict().readonly(),
  permissions: z.object({ path: absolutePathSchema, fragmentSha256: sha256Schema }).strict().readonly(),
  preferences: z.object({ path: absolutePathSchema, addonModule: addonModuleSchema }).strict().readonly()
}).strict().readonly();
const artifactIdentityShape = {
  filename: z.string().min(1),
  url: z.string().url(),
  size: z.number().int().positive(),
  sha256: sha256Schema
};
const legacyIntegrationSchema = z.object({
  name: z.literal("blender-mcp"),
  version: z.literal("1.6.4"),
  repository: z.literal("https://github.com/ahujasid/blender-mcp"),
  commit: commitSchema,
  wheel: z.object({
    ...artifactIdentityShape,
    name: z.literal("blender-mcp"),
    version: z.literal("1.6.4")
  }).strict().readonly(),
  addon: z.object({ ...artifactIdentityShape, commit: commitSchema }).strict().readonly(),
  provenanceSha256: sha256Schema,
  lockSha256: sha256Schema,
  requirementsSha256: sha256Schema,
  addonModule: z.literal(LEGACY_ADDON_MODULE)
}).strict().readonly();
const officialAddonAsset = OFFICIAL_BLENDER_MCP_RELEASE.assets[0];
const officialMcpbAsset = OFFICIAL_BLENDER_MCP_RELEASE.assets[1];
const officialIntegrationSchema = z.object({
  name: z.literal("Blender Lab"),
  version: z.literal("1.0.0"),
  repository: z.literal("https://projects.blender.org/lab/blender_mcp"),
  commit: z.literal("03004fd0216bfe5e0a3d9ac9b47d5efadc3d78c4"),
  releaseAssets: z.tuple([
    z.object({
      kind: z.literal("addon"),
      addonId: z.literal("mcp"),
      filename: z.literal(officialAddonAsset.filename),
      url: z.literal(officialAddonAsset.url),
      size: z.literal(officialAddonAsset.size),
      sha256: z.literal(officialAddonAsset.sha256)
    }).strict().readonly(),
    z.object({
      kind: z.literal("mcpb"),
      filename: z.literal(officialMcpbAsset.filename),
      url: z.literal(officialMcpbAsset.url),
      size: z.literal(officialMcpbAsset.size),
      sha256: z.literal(officialMcpbAsset.sha256)
    }).strict().readonly()
  ]),
  catalogSha256: sha256Schema,
  wheelLockSha256: sha256Schema,
  requirementsSha256: sha256Schema,
  upstreamLockSha256: sha256Schema,
  addonId: z.literal("mcp"),
  addonModule: addonModuleSchema,
  launcher: z.object({ path: absolutePathSchema, sha256: sha256Schema }).strict().readonly(),
  integrity: z.object({
    authority: z.literal("StrongCode"),
    kind: z.literal("sha256-pin"),
    upstreamSignature: z.literal(false)
  }).strict().readonly()
}).strict().readonly();
const v3CommonShape = {
  schemaVersion: z.literal(3),
  serverId: z.literal("blender"),
  profileId: z.string().min(1),
  blender: blenderSchema,
  python: pythonSchema,
  immutableTargets: z.array(v3TargetSchema).min(1).readonly(),
  managed: managedSchema,
  telemetry: z.literal("off"),
  installedAt: z.string().datetime(),
  predecessor: predecessorSchema.optional()
};

export const blenderInstallationReceiptV3Schema = z.discriminatedUnion("flavor", [
  z.object({ ...v3CommonShape, flavor: z.literal("legacy"), integration: legacyIntegrationSchema }).strict(),
  z.object({ ...v3CommonShape, flavor: z.literal("official"), integration: officialIntegrationSchema }).strict()
]).superRefine((receipt, context) => {
  const roles = receipt.immutableTargets.map(target => target.role);
  const paths = receipt.immutableTargets.map(target => target.path);
  const expectedRoles = ["addon", "private-config", "runtime"];
  if ([...roles].sort().join("\n") !== expectedRoles.join("\n")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["immutableTargets"],
      message: `${receipt.flavor} target roles must exactly match the managed set` });
  }
  if (new Set(paths).size !== paths.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["immutableTargets"], message: "target paths must be unique" });
  }
  if (receipt.managed.preferences.addonModule !== receipt.integration.addonModule) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["managed", "preferences", "addonModule"],
      message: "managed preferences must identify the integration addon module" });
  }
  if (receipt.flavor === "official" && receipt.blender.extensionsPath === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["blender", "extensionsPath"],
      message: "official receipts require the discovered EXTENSIONS resource path" });
  }
}).readonly();

export const blenderInstallationReceiptSchema = z.union([
  blenderInstallationReceiptV1Schema,
  blenderInstallationReceiptV2Schema,
  blenderInstallationReceiptV3Schema
]);

export type BlenderInstallationReceipt = z.infer<typeof blenderInstallationReceiptSchema>;
export type BlenderInstallationReceiptV1 = z.infer<typeof blenderInstallationReceiptV1Schema>;
export type BlenderInstallationReceiptV2 = z.infer<typeof blenderInstallationReceiptV2Schema>;
export type BlenderInstallationReceiptV3 = z.infer<typeof blenderInstallationReceiptV3Schema>;
export type LegacyBlenderInstallationReceiptV3 = Extract<BlenderInstallationReceiptV3, { readonly flavor: "legacy" }>;
export type OfficialBlenderInstallationReceiptV3 = Extract<BlenderInstallationReceiptV3, { readonly flavor: "official" }>;
export type BlenderInstallationTargetRole = (typeof BLENDER_INSTALLATION_TARGET_ROLES)[number];
