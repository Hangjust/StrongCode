import type { BlenderProfileCandidate } from "./types";

export const BLENDER_INTEGRATION_FLAVORS = ["legacy", "official"] as const;
export type BlenderIntegrationFlavor = (typeof BLENDER_INTEGRATION_FLAVORS)[number];

export type BlenderVersion = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
};

type BlenderIntegrationSelectionBase = {
  readonly profile: BlenderProfileCandidate;
  readonly version: BlenderVersion;
};

export type BlenderIntegrationSelection =
  | (BlenderIntegrationSelectionBase & { readonly flavor: "legacy" })
  | (BlenderIntegrationSelectionBase & { readonly flavor: "official" });
export type LegacyBlenderIntegrationSelection = Extract<BlenderIntegrationSelection, { readonly flavor: "legacy" }>;
export type OfficialBlenderIntegrationSelection = Extract<BlenderIntegrationSelection, { readonly flavor: "official" }>;

export type BlenderIntegrationSelectionResult =
  | { readonly kind: "selected"; readonly selection: BlenderIntegrationSelection }
  | { readonly kind: "unsupported"; readonly version: string }
  | { readonly kind: "malformed"; readonly version: string };

const STABLE_BLENDER_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const LEGACY_MINIMUM: BlenderVersion = { major: 4, minor: 2, patch: 0 };
const OFFICIAL_MINIMUM: BlenderVersion = { major: 5, minor: 1, patch: 0 };

function compareVersion(left: BlenderVersion, right: BlenderVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

export function selectBlenderIntegration(profile: BlenderProfileCandidate): BlenderIntegrationSelectionResult {
  const match = STABLE_BLENDER_VERSION.exec(profile.version);
  if (match === null) return { kind: "malformed", version: profile.version };
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    return { kind: "malformed", version: profile.version };
  }
  const version = { major, minor, patch };
  if (compareVersion(version, LEGACY_MINIMUM) < 0) {
    return { kind: "unsupported", version: profile.version };
  }
  return {
    kind: "selected",
    selection: {
      flavor: compareVersion(version, OFFICIAL_MINIMUM) >= 0 ? "official" : "legacy",
      profile,
      version
    }
  };
}
