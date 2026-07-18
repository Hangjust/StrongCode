import type { OfficialArtifactCatalog, OfficialWheelLock } from "./official-artifact-manifest";
import { officialArtifactCatalogSchema, officialWheelLockSchema } from "./official-artifact-manifest";

export class OfficialArtifactManifestError extends Error {
  readonly name = "OfficialArtifactManifestError";
}

export function parseOfficialArtifactCatalogJson(json: string): OfficialArtifactCatalog {
  const value: unknown = JSON.parse(json);
  return officialArtifactCatalogSchema.parse(value);
}

export function parseOfficialWheelLockJson(json: string): OfficialWheelLock {
  const value: unknown = JSON.parse(json);
  return officialWheelLockSchema.parse(value);
}

export function parseOfficialRequirements(lock: OfficialWheelLock, source: string): readonly string[] {
  const actual = source.trim().split(/\r?\n/u);
  const expected = lock.dependencies
    .map(dependency => `${dependency.name}==${dependency.version} --hash=sha256:${dependency.sha256}`)
    .sort();
  if ([...actual].sort().join("\n") !== expected.join("\n")) {
    throw new OfficialArtifactManifestError("Official requirements do not exactly match the dependency wheel lock");
  }
  return actual;
}
