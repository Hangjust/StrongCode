import { updateSetupState } from "../state";
import { BLENDER_OFFER_VERSION, type SetupState } from "../types";
import type { BlenderSetupResult } from "./setup";

export async function mergeBlenderSetupResult(homePath: string, result: BlenderSetupResult): Promise<SetupState> {
  switch (result.status) {
    case "installed":
    case "already-installed":
      return updateSetupState(homePath, latest => {
        const current = latest.blender;
        const baseline = result.originalBlender;
        const baselineMatches = current === undefined || baseline === undefined
          ? current === baseline
          : current.flavor === baseline.flavor
            && current.profileId === baseline.profileId
            && current.version === baseline.version
            && current.executablePath === baseline.executablePath
            && current.receiptPath === baseline.receiptPath
            && current.installedAt === baseline.installedAt;
        return {
          ...(baselineMatches ? { blender: result.state.blender } : {}),
          blenderOfferVersion: Math.max(latest.blenderOfferVersion ?? 0, BLENDER_OFFER_VERSION)
        };
      });
    case "declined":
      return updateSetupState(homePath, () => ({ blenderOfferVersion: BLENDER_OFFER_VERSION }));
    case "cancelled":
    case "not-found":
    case "prerequisite-missing":
      return updateSetupState(homePath, latest => ({ blenderOfferVersion: latest.blenderOfferVersion ?? 0 }));
  }
}
