import { z } from "zod";

const SHA256 = /^[a-f0-9]{64}$/u;
const PACKAGE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;
const VERSION = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*$/u;
const WHEEL_FILENAME = /^[A-Za-z0-9_.]+-[A-Za-z0-9_.]+-[A-Za-z0-9_.-]+\.whl$/u;
const PYTHONHOSTED_WHEEL_URL = /^https:\/\/files\.pythonhosted\.org\/packages\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{60}\/[A-Za-z0-9_.-]+\.whl$/u;

export const OFFICIAL_BLENDER_MCP_PATHS = {
  catalog: "official-catalog.json",
  wheels: "official-wheels.lock.json",
  requirements: "official-requirements.lock.txt",
  notices: "OFFICIAL_THIRD_PARTY_NOTICES.md",
  license: "OFFICIAL_LICENSE.md"
} as const;

export const OFFICIAL_BLENDER_MCP_TARGET = {
  implementation: "cp",
  python: "3.11",
  abi: "cp311",
  platform: "win_amd64"
} as const;

export const OFFICIAL_BLENDER_MCP_RELEASE = {
  version: "1.0.0",
  tag: "v1.0.0",
  assets: [
    {
      kind: "addon",
      addonId: "mcp",
      filename: "mcp-1.0.0.zip",
      url: "https://projects.blender.org/lab/blender_mcp/releases/download/v1.0.0/mcp-1.0.0.zip",
      size: 16765,
      sha256: "838c3449f01015c861290658ae67f122f0846f7882f60a5dfda0ef7e6a9b8403"
    },
    {
      kind: "mcpb",
      filename: "blender-1.0.0.mcpb",
      url: "https://projects.blender.org/lab/blender_mcp/releases/download/v1.0.0/blender-1.0.0.mcpb",
      size: 5553447,
      sha256: "93b070b1df82f57b1e7678b88b6bae28d06f105cd23ff6a4e0cc5f538bee2450"
    }
  ]
} as const;

const addonAssetSchema = z.object({
  kind: z.literal("addon"),
  addonId: z.literal("mcp"),
  filename: z.literal(OFFICIAL_BLENDER_MCP_RELEASE.assets[0].filename),
  url: z.literal(OFFICIAL_BLENDER_MCP_RELEASE.assets[0].url),
  size: z.literal(OFFICIAL_BLENDER_MCP_RELEASE.assets[0].size),
  sha256: z.literal(OFFICIAL_BLENDER_MCP_RELEASE.assets[0].sha256)
}).strict();

const mcpbAssetSchema = z.object({
  kind: z.literal("mcpb"),
  filename: z.literal(OFFICIAL_BLENDER_MCP_RELEASE.assets[1].filename),
  url: z.literal(OFFICIAL_BLENDER_MCP_RELEASE.assets[1].url),
  size: z.literal(OFFICIAL_BLENDER_MCP_RELEASE.assets[1].size),
  sha256: z.literal(OFFICIAL_BLENDER_MCP_RELEASE.assets[1].sha256)
}).strict();

export const officialArtifactCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  upstream: z.object({
    repository: z.literal("https://projects.blender.org/lab/blender_mcp"),
    commit: z.literal("03004fd0216bfe5e0a3d9ac9b47d5efadc3d78c4"),
    tag: z.literal("v1.0.0"),
    version: z.literal("1.0.0"),
    addonId: z.literal("mcp"),
    license: z.literal("GPL-3.0-or-later")
  }).strict(),
  release: z.object({
    version: z.literal("1.0.0"),
    tag: z.literal("v1.0.0"),
    assets: z.tuple([addonAssetSchema, mcpbAssetSchema])
  }).strict(),
  root: z.object({
    name: z.literal("blender-mcp"),
    version: z.literal("1.0.0"),
    source: z.literal("verified-mcpb"),
    artifact: z.literal("blender-1.0.0.mcpb")
  }).strict(),
  lockSource: z.object({
    artifact: z.literal("blender-1.0.0.mcpb"),
    path: z.literal("uv.lock"),
    size: z.literal(162146),
    sha256: z.literal("f6859224cf648af55274f309c56141bbbca089e04601290e0ac9891c44aad470")
  }).strict(),
  integrity: z.object({
    authority: z.literal("StrongCode"),
    upstreamSignatures: z.literal(false),
    notice: z.string().regex(/StrongCode-maintained SHA-256 pins.*not upstream signatures/iu)
  }).strict(),
  license: z.object({
    path: z.literal(OFFICIAL_BLENDER_MCP_PATHS.license),
    spdx: z.literal("GPL-3.0-or-later"),
    sha256: z.string().regex(SHA256)
  }).strict()
}).strict();

const targetSchema = z.object({
  implementation: z.literal(OFFICIAL_BLENDER_MCP_TARGET.implementation),
  python: z.literal(OFFICIAL_BLENDER_MCP_TARGET.python),
  abi: z.literal(OFFICIAL_BLENDER_MCP_TARGET.abi),
  platform: z.literal(OFFICIAL_BLENDER_MCP_TARGET.platform)
}).strict();

const dependencyWheelSchema = z.object({
  name: z.string().regex(PACKAGE),
  version: z.string().regex(VERSION),
  filename: z.string().regex(WHEEL_FILENAME),
  url: z.string().regex(PYTHONHOSTED_WHEEL_URL),
  size: z.number().int().positive(),
  sha256: z.string().regex(SHA256),
  requiresPython: z.string().min(1).max(128).nullable(),
  license: z.string().min(1).max(128)
}).strict().superRefine((wheel, context) => {
  if (!wheel.url.endsWith(`/${wheel.filename}`)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "wheel URL must end with its filename" });
  }
  if (!wheel.filename.startsWith(`${wheel.name.replace(/-/gu, "_")}-${wheel.version}-`)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["filename"], message: "wheel filename must match its package and version" });
  }
});

export const officialWheelLockSchema = z.object({
  schemaVersion: z.literal(1),
  target: targetSchema,
  roots: z.tuple([
    z.literal("docutils==0.22.4"),
    z.literal("mcp[cli]==1.27.0"),
    z.literal("pyyaml==6.0.3")
  ]),
  dependencies: z.array(dependencyWheelSchema).length(40)
}).strict().superRefine((lock, context) => {
  const names = lock.dependencies.map(dependency => dependency.name);
  if (new Set(names).size !== names.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["dependencies"], message: "dependency names must be unique" });
  }
  if (names.includes("blender-mcp")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["dependencies"], message: "the official root must come only from the verified MCPB" });
  }
  for (const [index, root] of lock.roots.entries()) {
    const separator = root.indexOf("==");
    const name = root.slice(0, separator).replace(/\[[a-z0-9,]+\]$/u, "");
    const version = root.slice(separator + 2);
    if (!lock.dependencies.some(dependency => dependency.name === name && dependency.version === version)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["roots", index], message: "every direct root must match a dependency wheel" });
    }
  }
});

export type OfficialArtifactCatalog = z.infer<typeof officialArtifactCatalogSchema>;
export type OfficialWheelLock = z.infer<typeof officialWheelLockSchema>;
