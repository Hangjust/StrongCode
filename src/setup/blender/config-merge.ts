import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { assertNoSymlinkPathComponents } from "../../config/save";
import { mcpFragmentSha256, planBlenderMcpSource } from "./config-merge-mcp";
import { permissionsFragmentSha256, planBlenderPermissionsSource } from "./config-merge-permissions";
import {
  blenderConfigConflict,
  MAX_BLENDER_CONFIG_BYTES,
  type SourceMergePlan
} from "./config-merge-shared";
import type {
  BlenderManagedPaths,
  BlenderMcpLaunch,
  BlenderMcpTransitionProof
} from "./mcp-launch";

export { planBlenderMcpSource } from "./config-merge-mcp";
export { planBlenderPermissionsSource } from "./config-merge-permissions";
export { BLENDER_MANAGED_MARKER } from "./mcp-launch";
export type {
  BlenderManagedPaths,
  BlenderMcpLaunch,
  BlenderMcpTransitionProof
} from "./mcp-launch";
export type { SourceMergePlan } from "./config-merge-shared";

export type FileMergePlan = SourceMergePlan & {
  readonly filePath: string;
  readonly expectedSourceHash: string;
  readonly fragmentSha256: string;
};

export type GlobalBlenderConfigMergePlan = {
  readonly mcp: FileMergePlan;
  readonly permissions: FileMergePlan;
};

type DescriptorMergeOptions = {
  readonly homePath: string;
  readonly launch: BlenderMcpLaunch;
  readonly transition?: BlenderMcpTransitionProof;
};

type LegacyCompatibilityMergeOptions = BlenderManagedPaths & {
  readonly homePath: string;
  readonly launch?: never;
  readonly transition?: never;
};

export type GlobalBlenderConfigMergeOptions = DescriptorMergeOptions | LegacyCompatibilityMergeOptions;

async function readConfig(filePath: string): Promise<{ readonly source: string; readonly hash: string }> {
  await assertNoSymlinkPathComponents(filePath);
  let stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw blenderConfigConflict(`Required global config does not exist: ${filePath}`);
    }
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw blenderConfigConflict(`Refusing non-regular or symlinked global config: ${filePath}`);
  }
  if (stats.size > MAX_BLENDER_CONFIG_BYTES) {
    throw blenderConfigConflict(`Global config exceeds ${MAX_BLENDER_CONFIG_BYTES} bytes: ${filePath}`);
  }
  const content = await readFile(filePath);
  return {
    source: content.toString("utf8"),
    hash: createHash("sha256").update(content).digest("hex")
  };
}

export async function planGlobalBlenderConfigMerge(
  options: GlobalBlenderConfigMergeOptions
): Promise<GlobalBlenderConfigMergePlan> {
  const homePath = path.resolve(options.homePath);
  const mcpPath = path.join(homePath, "mcp.json");
  const permissionsPath = path.join(homePath, "strongcode.config.yaml");
  const mcpSource = await readConfig(mcpPath);
  const permissionsSource = await readConfig(permissionsPath);
  const launch = options.launch ?? {
    flavor: "legacy",
    pythonPath: options.pythonPath,
    wrapperPath: options.wrapperPath,
    privateConfigPath: options.privateConfigPath
  };
  const transition = options.transition;
  const mcpPlan = planBlenderMcpSource(mcpSource.source, launch, transition);
  const permissionsPlan = planBlenderPermissionsSource(permissionsSource.source, launch, transition);
  return {
    mcp: {
      filePath: mcpPath,
      expectedSourceHash: mcpSource.hash,
      fragmentSha256: mcpFragmentSha256(mcpPlan.content),
      ...mcpPlan
    },
    permissions: {
      filePath: permissionsPath,
      expectedSourceHash: permissionsSource.hash,
      fragmentSha256: permissionsFragmentSha256(permissionsPlan.content),
      ...permissionsPlan
    }
  };
}
