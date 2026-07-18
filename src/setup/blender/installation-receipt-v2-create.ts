import path from "node:path";
import type { ArtifactProvenance, WheelLock } from "./artifact-manifest";
import { BlenderInstallError, sha256 } from "./durable-fs";
import { blenderInstallationReceiptV2Schema, type BlenderInstallationReceiptV2 } from "./installation-receipt-schema";
import type { PathState } from "./journal-schema";
import type { BlenderProfileCandidate } from "./types";

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
    addonModule: "strongcode_blender_mcp",
    telemetry: "off",
    installedAt: new Date().toISOString(),
    immutableTargets,
    managed: {
      mcp: { path: path.resolve(options.managed.mcp.path), serverId: "blender", fragmentSha256: options.managed.mcp.fragmentSha256 },
      permissions: { path: path.resolve(options.managed.permissions.path), fragmentSha256: options.managed.permissions.fragmentSha256 },
      preferences: {
        path: path.resolve(options.managed.preferencesPath),
        profileId: options.profile.profileId,
        addonModule: "strongcode_blender_mcp"
      }
    }
  });
}
