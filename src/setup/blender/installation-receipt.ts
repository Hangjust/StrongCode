import { BlenderInstallError } from "./durable-fs";
import type { BlenderInstallerFileSystem } from "./install-files";
import { blenderInstallationReceiptSchema, type BlenderInstallationReceipt } from "./installation-receipt-schema";

export {
  BLENDER_INSTALLATION_TARGET_ROLES,
  blenderInstallationReceiptSchema,
  blenderInstallationReceiptV1Schema,
  blenderInstallationReceiptV2Schema,
  blenderInstallationReceiptV3Schema,
  type BlenderInstallationReceipt,
  type BlenderInstallationReceiptV1,
  type BlenderInstallationReceiptV2,
  type BlenderInstallationReceiptV3,
  type BlenderInstallationTargetRole,
  type LegacyBlenderInstallationReceiptV3,
  type OfficialBlenderInstallationReceiptV3
} from "./installation-receipt-schema";
export {
  createInstallationReceiptV3,
  type BlenderInstallationReceiptManagedInput,
  type BlenderInstallationReceiptPredecessor,
  type BlenderInstallationReceiptTargetInput,
  type CreateBlenderInstallationReceiptV3Options,
  type LegacyBlenderInstallationReceiptV3Options,
  type OfficialBlenderInstallationReceiptV3Options
} from "./installation-receipt-create";
export { createInstallationReceipt } from "./installation-receipt-v2-create";
export {
  assertInstallationReceiptOwnership,
  assertInstallationReceiptV3Ownership,
  installationReceiptFlavor,
  installationReceiptMatches,
  installationReceiptV3Matches,
  type InstallationReceiptV3MatchOptions,
  type InstallationReceiptV3OwnershipOptions
} from "./installation-receipt-ownership";

export async function readInstallationReceipt(options: {
  readonly receiptPath: string;
  readonly files: BlenderInstallerFileSystem;
}): Promise<BlenderInstallationReceipt | undefined> {
  const state = await options.files.state(options.receiptPath);
  if (state.kind === "absent") return undefined;
  if (state.kind !== "file") throw new BlenderInstallError("conflict", `Blender ownership receipt is not a file: ${options.receiptPath}`);
  let value: unknown;
  try {
    value = JSON.parse((await options.files.readFile(options.receiptPath)).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new BlenderInstallError("conflict", "Blender ownership receipt is malformed");
    throw error;
  }
  const parsed = blenderInstallationReceiptSchema.safeParse(value);
  if (!parsed.success) throw new BlenderInstallError("conflict", "Blender ownership receipt is invalid");
  return parsed.data;
}
