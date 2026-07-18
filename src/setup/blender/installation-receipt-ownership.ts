import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ArtifactProvenance, WheelLock } from "./artifact-manifest";
import { BlenderInstallError, sha256, statesEqual } from "./durable-fs";
import type { BlenderInstallerFileSystem } from "./install-files";
import {
  createInstallationReceiptV3,
  type BlenderInstallationReceiptManagedInput,
  type BlenderInstallationReceiptTargetInput,
  type CreateBlenderInstallationReceiptV3Options,
  type LegacyBlenderInstallationReceiptV3Options,
  type OfficialBlenderInstallationReceiptV3Options
} from "./installation-receipt-create";
import type { BlenderInstallationReceipt, BlenderInstallationReceiptV3 } from "./installation-receipt-schema";
import type { BlenderIntegrationFlavor } from "./selection";
import type { BlenderProfileCandidate } from "./types";

type LegacyReceiptOwnershipOptions = {
  readonly receipt: BlenderInstallationReceipt;
  readonly profile: BlenderProfileCandidate;
  readonly immutableTargetPaths: readonly string[];
  readonly legacyTargetPaths: readonly string[];
  readonly mcpPath: string;
  readonly permissionsPath: string;
  readonly preferencesPath: string;
};

export type InstallationReceiptV3OwnershipOptions = {
  readonly receipt: BlenderInstallationReceiptV3;
  readonly flavor: BlenderIntegrationFlavor;
  readonly profile: BlenderProfileCandidate;
  readonly immutableTargets: readonly BlenderInstallationReceiptTargetInput[];
  readonly managed: BlenderInstallationReceiptManagedInput;
};

export function installationReceiptFlavor(receipt: BlenderInstallationReceipt): BlenderIntegrationFlavor {
  switch (receipt.schemaVersion) {
    case 1:
    case 2:
      return "legacy";
    case 3:
      return receipt.flavor;
    default:
      return unsupportedReceipt(receipt);
  }
}

export function assertInstallationReceiptV3Ownership(options: InstallationReceiptV3OwnershipOptions): void {
  const receipt = options.receipt;
  const profileMatches = receipt.flavor === options.flavor
    && receipt.profileId === options.profile.profileId
    && receipt.blender.executablePath === path.resolve(options.profile.executable.canonicalPath)
    && receipt.blender.configPath === path.resolve(options.profile.paths.config)
    && receipt.blender.userResourcePath === path.resolve(options.profile.paths.resources.user);
  if (!profileMatches) {
    throw new BlenderInstallError("conflict", "Blender v3 receipt flavor or profile ownership does not match the selected profile");
  }
  const expectedTargets = options.immutableTargets.map(target => `${target.role}\0${path.resolve(target.path)}`);
  const actualTargets = receipt.immutableTargets.map(target => `${target.role}\0${target.path}`);
  const managedMatches = [...actualTargets].sort().join("\n") === [...expectedTargets].sort().join("\n")
    && receipt.managed.mcp.path === path.resolve(options.managed.mcp.path)
    && receipt.managed.permissions.path === path.resolve(options.managed.permissions.path)
    && receipt.managed.preferences.path === path.resolve(options.managed.preferencesPath);
  if (!managedMatches) {
    throw new BlenderInstallError("conflict", "Blender v3 receipt target roles or managed paths do not match exact ownership");
  }
}

export function assertInstallationReceiptOwnership(
  options: LegacyReceiptOwnershipOptions | InstallationReceiptV3OwnershipOptions
): void {
  const receipt = options.receipt;
  if (receipt.schemaVersion === 3) {
    if (!isV3OwnershipOptions(options)) {
      throw new BlenderInstallError("conflict", "Blender v3 receipt requires flavor-aware ownership evidence");
    }
    assertInstallationReceiptV3Ownership({ ...options, receipt });
    return;
  }
  if (isV3OwnershipOptions(options)) {
    if (options.flavor !== "legacy") {
      throw new BlenderInstallError("conflict", "Legacy Blender receipts cannot own an official integration");
    }
    throw new BlenderInstallError("conflict", "Legacy Blender receipts require legacy ownership paths");
  }
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

type LegacyReceiptMatchOptions = LegacyReceiptOwnershipOptions & {
  readonly provenance: ArtifactProvenance;
  readonly lock: WheelLock;
  readonly requirements: string;
  readonly mcpFragmentSha256: string;
  readonly permissionsFragmentSha256: string;
  readonly files: BlenderInstallerFileSystem;
};

export type InstallationReceiptV3MatchOptions = CreateBlenderInstallationReceiptV3Options & {
  readonly receipt: BlenderInstallationReceiptV3;
  readonly files: BlenderInstallerFileSystem;
};

export async function installationReceiptV3Matches(options: InstallationReceiptV3MatchOptions): Promise<boolean> {
  assertInstallationReceiptV3Ownership({ receipt: options.receipt, flavor: options.flavor, profile: options.profile,
    immutableTargets: options.immutableTargets, managed: options.managed });
  if (!isDeepStrictEqual(options.receipt, createV3ExpectedReceipt(options))) return false;
  for (const target of options.receipt.immutableTargets) {
    if (!statesEqual(await options.files.state(target.path), target.state)) return false;
  }
  return true;
}

export async function installationReceiptMatches(
  options: LegacyReceiptMatchOptions | InstallationReceiptV3MatchOptions
): Promise<boolean> {
  if (options.receipt.schemaVersion === 3) {
    if (!isV3MatchOptions(options)) {
      throw new BlenderInstallError("conflict", "Blender v3 receipt requires flavor-aware matching evidence");
    }
    return installationReceiptV3Matches({ ...options, receipt: options.receipt });
  }
  if (isV3MatchOptions(options)) return false;
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

function samePaths(actual: readonly string[], expected: readonly string[]): boolean {
  return [...actual].sort().join("\n") === expected.map(item => path.resolve(item)).sort().join("\n");
}

function isV3OwnershipOptions(
  options: LegacyReceiptOwnershipOptions | InstallationReceiptV3OwnershipOptions
): options is InstallationReceiptV3OwnershipOptions {
  return "flavor" in options && "immutableTargets" in options && "managed" in options;
}

function isV3MatchOptions(
  options: LegacyReceiptMatchOptions | InstallationReceiptV3MatchOptions
): options is InstallationReceiptV3MatchOptions {
  return "flavor" in options && "python" in options && "managed" in options;
}

function createV3ExpectedReceipt(options: InstallationReceiptV3MatchOptions): BlenderInstallationReceiptV3 {
  const installedAt = options.receipt.installedAt;
  const predecessor = options.receipt.predecessor;
  switch (options.flavor) {
    case "legacy":
      return createInstallationReceiptV3({ ...options, installedAt, predecessor } satisfies LegacyBlenderInstallationReceiptV3Options);
    case "official":
      return createInstallationReceiptV3({ ...options, installedAt, predecessor } satisfies OfficialBlenderInstallationReceiptV3Options);
    default:
      return unsupportedReceipt(options);
  }
}

function unsupportedReceipt(value: never): never {
  throw new BlenderInstallError("invalid-journal", `Unsupported Blender receipt: ${JSON.stringify(value)}`);
}
