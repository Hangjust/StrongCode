import path from "node:path";
import {
  inspectPath,
  PathIdentityError,
  readVerifiedRegularFile,
  revalidatePath,
  type PathReceipt
} from "../core/path-identity";

export type TrustedHomeFileReadOptions = {
  readonly automaticHomeReceipt?: PathReceipt;
  readonly maxBytes: bigint;
};

async function readBoundFile(
  filePath: string,
  authorityReceipt: PathReceipt,
  maxBytes: bigint
): Promise<Buffer> {
  await revalidatePath(authorityReceipt);
  const bytes = await readVerifiedRegularFile(filePath, {
    maxBytes,
    requireSingleLink: true
  });
  await revalidatePath(authorityReceipt);
  return bytes;
}

export async function readTrustedHomeFile(
  filePath: string,
  options: TrustedHomeFileReadOptions
): Promise<Buffer | undefined> {
  try {
    if (options.automaticHomeReceipt !== undefined) {
      return await readBoundFile(filePath, options.automaticHomeReceipt, options.maxBytes);
    }
    const homeReceipt = await inspectPath(path.dirname(filePath), { finalKind: "directory" });
    return await readBoundFile(filePath, homeReceipt, options.maxBytes);
  } catch (error) {
    if (error instanceof PathIdentityError && error.reason === "missing-component") return undefined;
    if (options.automaticHomeReceipt === undefined && error instanceof PathIdentityError) return undefined;
    throw error;
  }
}
