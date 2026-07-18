import path from "node:path";
import type { ArtifactProvenance, WheelLock } from "./artifact-manifest";
import { BlenderInstallError, sha256 } from "./durable-fs";
import {
  blenderInstallationReceiptV3Schema,
  type BlenderInstallationReceiptV3,
  type BlenderInstallationTargetRole,
  type LegacyBlenderInstallationReceiptV3,
  type OfficialBlenderInstallationReceiptV3
} from "./installation-receipt-schema";
import type { PathState } from "./journal-schema";
import type { OfficialArtifactCatalog, OfficialWheelLock } from "./official-artifact-manifest";
import type { BlenderProfileCandidate, CpythonCandidate } from "./types";

export type BlenderInstallationReceiptPredecessor = {
  readonly receiptSha256: string;
  readonly flavor: "legacy" | "official";
  readonly profileId: string;
};

export type BlenderInstallationReceiptTargetInput = {
  readonly role: BlenderInstallationTargetRole;
  readonly path: string;
  readonly state: PathState;
};

export type BlenderInstallationReceiptManagedInput = {
  readonly mcp: { readonly path: string; readonly fragmentSha256: string };
  readonly permissions: { readonly path: string; readonly fragmentSha256: string };
  readonly preferencesPath: string;
};

type ReceiptV3CommonOptions = {
  readonly profile: BlenderProfileCandidate;
  readonly python: CpythonCandidate;
  readonly immutableTargets: readonly BlenderInstallationReceiptTargetInput[];
  readonly managed: BlenderInstallationReceiptManagedInput;
  readonly predecessor?: BlenderInstallationReceiptPredecessor;
  readonly installedAt?: string;
};

export type LegacyBlenderInstallationReceiptV3Options = ReceiptV3CommonOptions & {
  readonly flavor: "legacy";
  readonly lock: WheelLock;
  readonly provenance: ArtifactProvenance;
  readonly requirements: string;
};

export type OfficialBlenderInstallationReceiptV3Options = ReceiptV3CommonOptions & {
  readonly flavor: "official";
  readonly catalog: OfficialArtifactCatalog;
  readonly lock: OfficialWheelLock;
  readonly requirements: string;
  readonly addonModule: string;
  readonly launcher: { readonly path: string; readonly sha256: string };
};

export type CreateBlenderInstallationReceiptV3Options =
  | LegacyBlenderInstallationReceiptV3Options
  | OfficialBlenderInstallationReceiptV3Options;

export function createInstallationReceiptV3(
  options: LegacyBlenderInstallationReceiptV3Options
): LegacyBlenderInstallationReceiptV3;
export function createInstallationReceiptV3(
  options: OfficialBlenderInstallationReceiptV3Options
): OfficialBlenderInstallationReceiptV3;
export function createInstallationReceiptV3(
  options: CreateBlenderInstallationReceiptV3Options
): BlenderInstallationReceiptV3;
export function createInstallationReceiptV3(
  options: CreateBlenderInstallationReceiptV3Options
): BlenderInstallationReceiptV3 {
  const common = receiptCommon(options);
  switch (options.flavor) {
    case "legacy": {
      const wheel = options.provenance.artifacts[0];
      const addon = options.provenance.artifacts[1];
      requireLegacyIdentity(options, wheel.name, wheel.version);
      return blenderInstallationReceiptV3Schema.parse({
        ...common,
        flavor: "legacy",
        integration: {
          name: "blender-mcp",
          version: "1.6.4",
          repository: options.provenance.upstream.repository,
          commit: options.provenance.upstream.commit,
          wheel: {
            name: wheel.name,
            version: wheel.version,
            filename: wheel.filename,
            url: wheel.url,
            size: wheel.size,
            sha256: wheel.sha256
          },
          addon: {
            filename: addon.filename,
            url: addon.url,
            size: addon.size,
            sha256: addon.sha256,
            commit: addon.commit
          },
          provenanceSha256: sha256(JSON.stringify(options.provenance)),
          lockSha256: sha256(JSON.stringify(options.lock)),
          requirementsSha256: sha256(options.requirements),
          addonModule: "strongcode_blender_mcp"
        }
      });
    }
    case "official":
      return blenderInstallationReceiptV3Schema.parse({
        ...common,
        flavor: "official",
        integration: {
          name: "Blender Lab",
          version: options.catalog.upstream.version,
          repository: options.catalog.upstream.repository,
          commit: options.catalog.upstream.commit,
          releaseAssets: options.catalog.release.assets,
          catalogSha256: sha256(JSON.stringify(options.catalog)),
          wheelLockSha256: sha256(JSON.stringify(options.lock)),
          requirementsSha256: sha256(options.requirements),
          upstreamLockSha256: options.catalog.lockSource.sha256,
          addonId: options.catalog.upstream.addonId,
          addonModule: options.addonModule,
          launcher: { path: path.resolve(options.launcher.path), sha256: options.launcher.sha256 },
          integrity: { authority: "StrongCode", kind: "sha256-pin", upstreamSignature: false }
        }
      });
    default:
      return unsupportedOptions(options);
  }
}

function receiptCommon(options: CreateBlenderInstallationReceiptV3Options) {
  const addonModule = options.flavor === "legacy" ? "strongcode_blender_mcp" : options.addonModule;
  return {
    schemaVersion: 3,
    serverId: "blender",
    profileId: options.profile.profileId,
    blender: {
      executablePath: path.resolve(options.profile.executable.canonicalPath),
      executableSha256: options.profile.executable.sha256,
      version: options.profile.version,
      configPath: path.resolve(options.profile.paths.config),
      userResourcePath: path.resolve(options.profile.paths.resources.user),
      ...(options.profile.paths.extensions === undefined
        ? {}
        : { extensionsPath: path.resolve(options.profile.paths.extensions) })
    },
    python: {
      executablePath: path.resolve(options.python.executable.canonicalPath),
      executableSha256: options.python.executable.sha256,
      implementation: options.python.implementation,
      version: options.python.version,
      pointerWidth: options.python.pointerWidth,
      sysconfigTarget: options.python.sysconfigPlatform
    },
    immutableTargets: options.immutableTargets.map(target => {
      if (target.state.kind === "absent") {
        throw new BlenderInstallError("conflict", `Cannot receipt an absent target: ${target.path}`);
      }
      return { role: target.role, path: path.resolve(target.path), state: target.state };
    }),
    managed: {
      mcp: { path: path.resolve(options.managed.mcp.path), serverId: "blender", fragmentSha256: options.managed.mcp.fragmentSha256 },
      permissions: {
        path: path.resolve(options.managed.permissions.path),
        fragmentSha256: options.managed.permissions.fragmentSha256
      },
      preferences: { path: path.resolve(options.managed.preferencesPath), addonModule }
    },
    telemetry: "off",
    installedAt: options.installedAt ?? new Date().toISOString(),
    ...(options.predecessor === undefined ? {} : { predecessor: options.predecessor })
  };
}

function requireLegacyIdentity(
  options: LegacyBlenderInstallationReceiptV3Options,
  wheelName: string,
  wheelVersion: string
): void {
  const target = options.lock.target;
  if (wheelName !== "blender-mcp" || wheelVersion !== "1.6.4"
    || target.implementation !== "cp" || target.python !== "3.11"
    || target.abi !== "cp311" || target.platform !== "win_amd64") {
    throw new BlenderInstallError("conflict", "Legacy Blender receipt requires blender-mcp 1.6.4 for CPython 3.11 win_amd64");
  }
}

function unsupportedOptions(options: never): never {
  throw new BlenderInstallError("invalid-journal", `Unsupported Blender receipt flavor: ${JSON.stringify(options)}`);
}
