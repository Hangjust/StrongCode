import type { ConfigSourceMetadata } from "../config/load";
import { StrongCodeError } from "../core/errors";
import { revalidatePath, type PathReceipt } from "../core/path-identity";

export type ConfigTrustDecision = {
  readonly automaticHomeReceipt: PathReceipt | undefined;
  readonly implicitProject: boolean;
  readonly trustedConfig: boolean;
  readonly trustedProjectInstructions: boolean;
  readonly useCurrentWorkingDirectory: boolean;
};

export async function deriveConfigTrust(
  source: ConfigSourceMetadata,
  environmentTrust: boolean
): Promise<ConfigTrustDecision> {
  switch (source.kind) {
    case "automatic-home":
      await revalidatePath(source.receipt);
      return Object.freeze({
        automaticHomeReceipt: source.receipt,
        implicitProject: false,
        trustedConfig: true,
        trustedProjectInstructions: environmentTrust,
        useCurrentWorkingDirectory: true
      });
    case "automatic-project":
      return Object.freeze({
        automaticHomeReceipt: undefined,
        implicitProject: true,
        trustedConfig: environmentTrust,
        trustedProjectInstructions: environmentTrust,
        useCurrentWorkingDirectory: false
      });
    case "explicit":
      return Object.freeze({
        automaticHomeReceipt: undefined,
        implicitProject: false,
        trustedConfig: true,
        trustedProjectInstructions: environmentTrust || !source.atHomePath,
        useCurrentWorkingDirectory: false
      });
    default:
      return assertNeverSource(source);
  }
}

function assertNeverSource(source: never): never {
  throw new StrongCodeError("CONFIG_ERROR", `Unknown config source: ${String(source)}`);
}
