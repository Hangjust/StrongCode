import { z } from "zod";

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const VERSION = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*$/u;
const PACKAGE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;
const EXACT_REQUIREMENT = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:\[[a-z0-9]+(?:,[a-z0-9]+)*\])?==(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*$/u;
const WHEEL_FILENAME = /^[A-Za-z0-9_.]+-[A-Za-z0-9_.]+-[A-Za-z0-9_.-]+\.whl$/u;
const PYPI_WHEEL_URL = /^https:\/\/files\.pythonhosted\.org\/packages\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{60}\/[A-Za-z0-9_.-]+\.whl$/u;
const PYPI_METADATA_URL = /^https:\/\/pypi\.org\/pypi\/[a-z0-9._-]+\/(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*\/json$/u;
const RAW_GITHUB_URL = /^https:\/\/raw\.githubusercontent\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[a-f0-9]{40}\/[A-Za-z0-9_.\/-]+$/u;

export const BLENDER_MCP_MANIFEST_PATHS = {
  provenance: "provenance.json",
  requirements: "requirements.lock.txt",
  wheels: "wheels.lock.json",
  notices: "THIRD_PARTY_NOTICES.md",
  license: "LICENSE"
} as const;

export const BLENDER_MCP_SUPPORTED_TARGET = {
  implementation: "cp",
  python: "3.11",
  abi: "cp311",
  platform: "win_amd64"
} as const;

const artifactWheelSchema = z.object({
  kind: z.literal("wheel"),
  name: z.string().regex(PACKAGE),
  version: z.string().regex(VERSION),
  filename: z.string().regex(WHEEL_FILENAME),
  url: z.string().regex(PYPI_WHEEL_URL),
  size: z.number().int().positive(),
  sha256: z.string().regex(SHA256),
  metadataUrl: z.string().regex(PYPI_METADATA_URL)
}).strict().superRefine((wheel, context) => {
  if (!wheel.url.endsWith(`/${wheel.filename}`)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "wheel URL must end with its filename" });
  }
  if (!wheel.filename.startsWith(`${wheel.name.replace(/-/gu, "_")}-${wheel.version}-`)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["filename"], message: "wheel filename must match its exact package and version" });
  }
});

const artifactAddonSchema = z.object({
  kind: z.literal("addon"),
  filename: z.literal("addon.py"),
  commit: z.string().regex(COMMIT),
  url: z.string().regex(RAW_GITHUB_URL),
  size: z.number().int().positive(),
  sha256: z.string().regex(SHA256)
}).strict().superRefine((addon, context) => {
  if (!addon.url.includes(`/${addon.commit}/`) || !addon.url.endsWith(`/${addon.filename}`)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "addon URL must contain its commit and filename" });
  }
});

const derivativeSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(SHA256),
  licensePath: z.string().min(1)
}).strict();

export const artifactProvenanceSchema = z.object({
  schemaVersion: z.literal(1),
  upstream: z.object({
    repository: z.literal("https://github.com/ahujasid/blender-mcp"),
    commit: z.string().regex(COMMIT)
  }).strict(),
  artifacts: z.tuple([artifactWheelSchema, artifactAddonSchema]),
  license: z.object({
    path: z.literal("LICENSE"),
    spdx: z.literal("MIT"),
    sourceUrl: z.string().regex(RAW_GITHUB_URL),
    sha256: z.string().regex(SHA256),
    sourceSha256: z.string().regex(SHA256),
    appliesTo: z.tuple([z.string().min(1), z.string().min(1)])
  }).strict(),
  derivatives: z.array(derivativeSchema)
}).strict().superRefine((manifest, context) => {
  const addon = manifest.artifacts[1];
  if (manifest.upstream.commit !== addon.commit) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["upstream", "commit"], message: "upstream and addon commits must match" });
  }
  if (!manifest.license.sourceUrl.includes(`/${manifest.upstream.commit}/`)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["license", "sourceUrl"], message: "license URL must use the upstream commit" });
  }
  const artifactNames = manifest.artifacts.map(artifact => artifact.filename).sort();
  const coveredNames = [...manifest.license.appliesTo].sort();
  if (artifactNames.join("\n") !== coveredNames.join("\n")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["license", "appliesTo"], message: "license must cover every upstream artifact exactly once" });
  }
});

const targetSchema = z.object({
  implementation: z.literal(BLENDER_MCP_SUPPORTED_TARGET.implementation),
  python: z.literal(BLENDER_MCP_SUPPORTED_TARGET.python),
  abi: z.literal(BLENDER_MCP_SUPPORTED_TARGET.abi),
  platform: z.literal(BLENDER_MCP_SUPPORTED_TARGET.platform)
}).strict();

const wheelSchema = z.object({
  name: z.string().regex(PACKAGE),
  version: z.string().regex(VERSION),
  filename: z.string().regex(WHEEL_FILENAME),
  url: z.string().regex(PYPI_WHEEL_URL),
  size: z.number().int().positive(),
  sha256: z.string().regex(SHA256),
  requiresPython: z.string().min(1).max(128),
  license: z.string().min(1).max(128)
}).strict().superRefine((wheel, context) => {
  if (!wheel.url.endsWith(`/${wheel.filename}`)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "wheel URL must end with its filename" });
  }
  if (!wheel.filename.startsWith(`${wheel.name.replace(/-/gu, "_")}-${wheel.version}-`)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["filename"], message: "wheel filename must match its exact package and version" });
  }
});

export const wheelLockSchema = z.object({
  schemaVersion: z.literal(1),
  target: targetSchema,
  roots: z.array(z.string().regex(EXACT_REQUIREMENT)).min(1),
  wheels: z.array(wheelSchema).min(1)
}).strict().superRefine((lock, context) => {
  const wheelNames = lock.wheels.map(wheel => wheel.name);
  if (new Set(wheelNames).size !== wheelNames.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["wheels"], message: "wheel package names must be unique" });
  }
  for (const [index, root] of lock.roots.entries()) {
    const rootName = root.slice(0, root.indexOf("==")).replace(/\[[a-z0-9,]+\]$/u, "");
    if (!wheelNames.includes(rootName)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["roots", index], message: "every root must have a locked wheel" });
    }
  }
});

export type ArtifactProvenance = z.infer<typeof artifactProvenanceSchema>;
export type WheelLock = z.infer<typeof wheelLockSchema>;

export const BLENDER_MCP_WHEEL = {
  kind: "wheel",
  name: "blender-mcp",
  version: "1.6.4",
  filename: "blender_mcp-1.6.4-py3-none-any.whl",
  url: "https://files.pythonhosted.org/packages/17/0f/e6a51f58d8e6af9dbcb8a8e9f446a647809fab7ae727c9c4ffc4cef31328/blender_mcp-1.6.4-py3-none-any.whl",
  size: 26431,
  sha256: "2e935cc3f78df5d2be12192b970f92753a00b3a50c442b6338c3100102a133c5",
  metadataUrl: "https://pypi.org/pypi/blender-mcp/1.6.4/json"
} as const;

export const BLENDER_MCP_ADDON = {
  kind: "addon",
  filename: "addon.py",
  commit: "6641189231caf3752302ae20591bc87fda85fc4e",
  url: "https://raw.githubusercontent.com/ahujasid/blender-mcp/6641189231caf3752302ae20591bc87fda85fc4e/addon.py",
  size: 118487,
  sha256: "bba60831f5f89a74deda0294b131668a086cf46eb35a6a01abbd0d21d9e92630"
} as const;

export function parseArtifactProvenanceJson(json: string): ArtifactProvenance {
  const value: unknown = JSON.parse(json);
  return artifactProvenanceSchema.parse(value);
}

export function parseWheelLockJson(json: string): WheelLock {
  const value: unknown = JSON.parse(json);
  return wheelLockSchema.parse(value);
}
