import path from "node:path";
import { probeInstalledBlenderAddon } from "./blender-preferences";
import type { GlobalBlenderConfigMergePlan } from "./config-merge";
import type { BlenderInstallerFileSystem } from "./install-files";
import type { LegacyInstallBlenderIntegrationOptions } from "./install";
import type { ManagedBlenderPaths } from "./install-plan";
import {
  assertInstallationReceiptOwnership,
  assertInstallationReceiptV3Ownership,
  installationReceiptMatches,
  type BlenderInstallationReceipt
} from "./installation-receipt";
import type { ProbeProcessAdapter } from "./types";

export async function legacyInstallationHealthy(options: {
  readonly install: LegacyInstallBlenderIntegrationOptions;
  readonly paths: ManagedBlenderPaths;
  readonly merge: GlobalBlenderConfigMergePlan;
  readonly receipt: BlenderInstallationReceipt;
  readonly files: BlenderInstallerFileSystem;
  readonly blenderProcess: ProbeProcessAdapter;
}): Promise<boolean> {
  const install = options.install;
  const profile = install.selection.profile;
  let matches: boolean;
  if (options.receipt.schemaVersion === 3) {
    if (options.receipt.flavor !== "legacy") return false;
    const immutableTargets = [
      { role: "private-config" as const, path: options.paths.privateConfig,
        state: await options.files.state(options.paths.privateConfig) },
      { role: "addon" as const, path: options.paths.addon, state: await options.files.state(options.paths.addon) },
      { role: "runtime" as const, path: options.paths.runtime, state: await options.files.state(options.paths.runtime) }
    ];
    const managed = {
      mcp: { path: options.merge.mcp.filePath, fragmentSha256: options.merge.mcp.fragmentSha256 },
      permissions: { path: options.merge.permissions.filePath, fragmentSha256: options.merge.permissions.fragmentSha256 },
      preferencesPath: options.paths.preferences
    };
    assertInstallationReceiptV3Ownership({ receipt: options.receipt, flavor: "legacy", profile, immutableTargets, managed });
    if (immutableTargets.some(target => target.state.kind === "absent")) return false;
    matches = await installationReceiptMatches({
      flavor: "legacy",
      profile,
      python: install.python,
      lock: install.lock,
      provenance: install.provenance,
      requirements: install.requirements,
      immutableTargets,
      managed,
      receipt: options.receipt,
      files: options.files
    });
  } else {
    const immutableTargetPaths = [options.paths.privateConfig, options.paths.addon, options.paths.runtime];
    const legacyTargetPaths = [options.paths.privateConfig, options.paths.addon, options.paths.preferences,
      options.merge.permissions.filePath, options.merge.mcp.filePath, options.paths.runtime];
    const ownership = { receipt: options.receipt, profile, immutableTargetPaths, legacyTargetPaths,
      mcpPath: options.merge.mcp.filePath, permissionsPath: options.merge.permissions.filePath,
      preferencesPath: options.paths.preferences };
    assertInstallationReceiptOwnership(ownership);
    matches = await installationReceiptMatches({ ...ownership, provenance: install.provenance,
      lock: install.lock, requirements: install.requirements, mcpFragmentSha256: options.merge.mcp.fragmentSha256,
      permissionsFragmentSha256: options.merge.permissions.fragmentSha256, files: options.files });
  }
  if (!matches || options.merge.mcp.changed || options.merge.permissions.changed) return false;
  return probeInstalledBlenderAddon({ profile, privateProfilePath: path.dirname(options.paths.privateConfig),
    process: options.blenderProcess, ...(install.env ? { env: install.env } : {}) });
}
