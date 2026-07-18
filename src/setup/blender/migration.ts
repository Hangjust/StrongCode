import path from "node:path";
import { BLENDER_MANAGED_MARKER, planGlobalBlenderConfigMerge, type BlenderMcpLaunch, type BlenderMcpTransitionProof } from "./config-merge";
import { BlenderInstallError, statesEqual } from "./durable-fs";
import type { BlenderInstallerFileSystem } from "./install-files";
import type { BlenderInstallationReceiptPredecessor, BlenderInstallationReceiptTargetInput,
  BlenderInstallationReceiptV2, BlenderInstallationReceiptV3 } from "./installation-receipt";
import type { BlenderInstallTargetPlan } from "./journal";
import type { BlenderIntegrationFlavor } from "./selection";
import type { BlenderProfileCandidate } from "./types";

export type BlenderMigrationPredecessor = {
  readonly receipt: BlenderInstallationReceiptV2 | BlenderInstallationReceiptV3;
  readonly immutableTargets: readonly BlenderInstallationReceiptTargetInput[];
  readonly profile: BlenderProfileCandidate;
  readonly launch: BlenderMcpLaunch;
  readonly transition: BlenderMcpTransitionProof;
  readonly predecessor: BlenderInstallationReceiptPredecessor;
};

export async function inspectBlenderMigrationPredecessor(options: {
  readonly homePath: string;
  readonly receiptPath: string;
  readonly receipt: BlenderInstallationReceiptV3;
  readonly successorFlavor: BlenderIntegrationFlavor;
  readonly files: BlenderInstallerFileSystem;
}): Promise<BlenderMigrationPredecessor> {
  if (options.receipt.flavor === options.successorFlavor) {
    throw new BlenderInstallError("conflict", "Blender migration predecessor must use the other integration flavor");
  }
  const expectedManaged = {
    mcp: path.resolve(options.homePath, "mcp.json"),
    permissions: path.resolve(options.homePath, "strongcode.config.yaml")
  };
  if (options.receipt.managed.mcp.path !== expectedManaged.mcp
    || options.receipt.managed.permissions.path !== expectedManaged.permissions
    || options.receipt.managed.preferences.path !== path.join(options.receipt.blender.configPath, "userpref.blend")) {
    throw new BlenderInstallError("conflict", "Blender migration receipt does not own the exact managed config paths");
  }
  const receiptState = await options.files.state(options.receiptPath);
  if (receiptState.kind !== "file") throw new BlenderInstallError("conflict", "Blender migration receipt is not a regular file");
  await options.files.verifyFile(options.receipt.blender.executablePath, options.receipt.blender.executableSha256);
  await options.files.verifyFile(options.receipt.python.executablePath, options.receipt.python.executableSha256);
  for (const target of options.receipt.immutableTargets) {
    if (!statesEqual(await options.files.state(target.path), target.state)) {
      throw new BlenderInstallError("conflict", `Blender migration predecessor target requires repair: ${target.path}`);
    }
  }
  const launch = predecessorLaunch(options.homePath, options.receipt);
  const merge = await planGlobalBlenderConfigMerge({ homePath: options.homePath, launch });
  if (merge.mcp.changed || merge.permissions.changed
    || merge.mcp.fragmentSha256 !== options.receipt.managed.mcp.fragmentSha256
    || merge.permissions.fragmentSha256 !== options.receipt.managed.permissions.fragmentSha256) {
    throw new BlenderInstallError("conflict", "Blender migration predecessor config requires repair before migration");
  }
  return {
    receipt: options.receipt,
    immutableTargets: options.receipt.immutableTargets,
    profile: migrationPredecessorProfile(options.receipt),
    launch,
    transition: { predecessorFlavor: options.receipt.flavor, proof: BLENDER_MANAGED_MARKER },
    predecessor: { receiptSha256: receiptState.sha256, flavor: options.receipt.flavor, profileId: options.receipt.profileId }
  };
}

export async function inspectLegacyV2MigrationPredecessor(options: {
  readonly homePath: string;
  readonly receiptPath: string;
  readonly receipt: BlenderInstallationReceiptV2;
  readonly files: BlenderInstallerFileSystem;
}): Promise<BlenderMigrationPredecessor> {
  const paths = {
    runtime: path.resolve(options.homePath, "mcps", "blender", "runtime"),
    addon: path.join(options.receipt.blender.userResourcePath, "scripts", "addons", "strongcode_blender_mcp"),
    privateConfig: path.join(options.receipt.blender.configPath, "strongcode_blender_mcp", "config.json"),
    preferences: path.join(options.receipt.blender.configPath, "userpref.blend"),
    mcp: path.resolve(options.homePath, "mcp.json"),
    permissions: path.resolve(options.homePath, "strongcode.config.yaml")
  };
  if (options.receipt.managed.mcp.path !== paths.mcp || options.receipt.managed.permissions.path !== paths.permissions
    || options.receipt.managed.preferences.path !== paths.preferences
    || options.receipt.managed.preferences.profileId !== options.receipt.profileId) {
    throw new BlenderInstallError("conflict", "Legacy v2 migration receipt does not own the exact managed paths");
  }
  const expectedPaths = [paths.privateConfig, paths.addon, paths.runtime].map(pathIdentity).sort();
  if (options.receipt.immutableTargets.map(target => pathIdentity(target.path)).sort().join("\n") !== expectedPaths.join("\n")) {
    throw new BlenderInstallError("conflict", "Legacy v2 migration receipt immutable target paths are not exact");
  }
  const receiptState = await options.files.state(options.receiptPath);
  if (receiptState.kind !== "file") throw new BlenderInstallError("conflict", "Legacy v2 migration receipt is not a regular file");
  await options.files.verifyFile(options.receipt.blender.executablePath, options.receipt.blender.executableSha256);
  for (const target of options.receipt.immutableTargets) {
    if (!statesEqual(await options.files.state(target.path), target.state)) {
      throw new BlenderInstallError("conflict", `Legacy v2 migration predecessor target requires repair: ${target.path}`);
    }
  }
  const launch: BlenderMcpLaunch = { flavor: "legacy", pythonPath: path.join(paths.runtime, "venv", "Scripts", "python.exe"),
    wrapperPath: path.join(paths.runtime, "wrapper", "strongcode-blender-wrapper.py"), privateConfigPath: paths.privateConfig };
  const merge = await planGlobalBlenderConfigMerge({ homePath: options.homePath, launch });
  if (merge.mcp.changed || merge.permissions.changed
    || merge.mcp.fragmentSha256 !== options.receipt.managed.mcp.fragmentSha256
    || merge.permissions.fragmentSha256 !== options.receipt.managed.permissions.fragmentSha256) {
    throw new BlenderInstallError("conflict", "Legacy v2 migration predecessor config requires repair before migration");
  }
  const byPath = new Map(options.receipt.immutableTargets.map(target => [pathIdentity(target.path), target]));
  const immutableTargets = [
    { role: "private-config" as const, path: paths.privateConfig, state: requiredState(byPath, paths.privateConfig) },
    { role: "addon" as const, path: paths.addon, state: requiredState(byPath, paths.addon) },
    { role: "runtime" as const, path: paths.runtime, state: requiredState(byPath, paths.runtime) }
  ];
  return {
    receipt: options.receipt,
    immutableTargets,
    profile: migrationPredecessorProfile(options.receipt),
    launch,
    transition: { predecessorFlavor: "legacy", proof: BLENDER_MANAGED_MARKER },
    predecessor: { receiptSha256: receiptState.sha256, flavor: "legacy", profileId: options.receipt.profileId }
  };
}

export function createBlenderMigrationRemovalPlans(options: {
  readonly predecessor: BlenderMigrationPredecessor;
  readonly successorImmutablePaths: readonly string[];
}): readonly BlenderInstallTargetPlan[] {
  const successor = new Set(options.successorImmutablePaths.map(pathIdentity));
  return options.predecessor.immutableTargets
    .filter(target => !successor.has(pathIdentity(target.path)))
    .map(target => ({
      canonicalPath: target.path,
      activationPhase: "state_active" as const,
      requiredPreState: target.state,
      staged: { kind: "absent" as const }
    }));
}

export function migrationPredecessorProfile(receipt: BlenderInstallationReceiptV2 | BlenderInstallationReceiptV3): BlenderProfileCandidate {
  return {
    profileId: receipt.profileId,
    executable: { canonicalPath: receipt.blender.executablePath, sha256: receipt.blender.executableSha256 },
    version: receipt.blender.version,
    paths: {
      resources: { local: receipt.blender.userResourcePath, system: receipt.blender.userResourcePath,
        user: receipt.blender.userResourcePath },
      config: receipt.blender.configPath,
      scripts: [path.join(receipt.blender.userResourcePath, "scripts")],
      ...(receipt.schemaVersion === 3 && receipt.blender.extensionsPath !== undefined
        ? { extensions: receipt.blender.extensionsPath }
        : {})
    },
    sources: ["association"]
  };
}

function requiredState(targets: ReadonlyMap<string, { readonly state: BlenderInstallationReceiptTargetInput["state"] }>,
  targetPath: string): BlenderInstallationReceiptTargetInput["state"] {
  const target = targets.get(pathIdentity(targetPath));
  if (target === undefined) throw new BlenderInstallError("conflict", `Legacy v2 migration receipt is missing ${targetPath}`);
  return target.state;
}

function predecessorLaunch(homePath: string, receipt: BlenderInstallationReceiptV3): BlenderMcpLaunch {
  const targets = new Map(receipt.immutableTargets.map(target => [target.role, target.path]));
  switch (receipt.flavor) {
    case "legacy": {
      requireExactRoles(targets, ["private-config", "addon", "runtime"]);
      const runtime = requiredTarget(targets, "runtime");
      requirePath(runtime, path.resolve(homePath, "mcps", "blender", "runtime"));
      requirePath(requiredTarget(targets, "addon"), path.join(receipt.blender.userResourcePath, "scripts", "addons", "strongcode_blender_mcp"));
      requirePath(requiredTarget(targets, "private-config"), path.join(receipt.blender.configPath, "strongcode_blender_mcp", "config.json"));
      return { flavor: "legacy", pythonPath: path.join(runtime, "venv", "Scripts", "python.exe"),
        wrapperPath: path.join(runtime, "wrapper", "strongcode-blender-wrapper.py"),
        privateConfigPath: requiredTarget(targets, "private-config") };
    }
    case "official": {
      requireExactRoles(targets, ["addon", "private-config", "runtime"]);
      const runtime = requiredTarget(targets, "runtime");
      requirePath(runtime, path.resolve(homePath, "mcps", "blender", "runtimes", "official-1.0.0-cp311-win_amd64"));
      if (receipt.blender.extensionsPath === undefined) {
        throw new BlenderInstallError("conflict", "Official migration receipt is missing the discovered EXTENSIONS resource path");
      }
      requirePath(requiredTarget(targets, "addon"), path.join(receipt.blender.extensionsPath, "user_default", "mcp"));
      requirePath(requiredTarget(targets, "private-config"),
        path.join(receipt.blender.configPath, "strongcode_blender_mcp", "official.json"));
      const launcherPath = path.join(runtime, "blender-mcp.py");
      if (receipt.integration.launcher.path !== launcherPath) {
        throw new BlenderInstallError("conflict", "Official migration receipt launcher path is outside the owned runtime");
      }
      return { flavor: "official", pythonPath: path.join(runtime, "venv", "Scripts", "python.exe"), launcherPath,
        privateConfigPath: requiredTarget(targets, "private-config") };
    }
    default:
      return unsupportedReceipt(receipt);
  }
}

function requirePath(actual: string, expected: string): void {
  if (pathIdentity(actual) !== pathIdentity(expected)) {
    throw new BlenderInstallError("conflict", "Blender migration receipt target path is outside the exact managed set");
  }
}

function requireExactRoles(targets: ReadonlyMap<string, string>, roles: readonly string[]): void {
  if ([...targets.keys()].sort().join("\n") !== [...roles].sort().join("\n")) {
    throw new BlenderInstallError("conflict", "Blender migration receipt immutable target roles are not exact");
  }
}

function requiredTarget(targets: ReadonlyMap<string, string>, role: string): string {
  const target = targets.get(role);
  if (target === undefined) throw new BlenderInstallError("conflict", `Blender migration receipt is missing ${role}`);
  return target;
}

function pathIdentity(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function unsupportedReceipt(receipt: never): never {
  throw new BlenderInstallError("conflict", `Unsupported Blender migration receipt: ${JSON.stringify(receipt)}`);
}
