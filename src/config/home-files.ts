import { createHash, randomUUID } from "node:crypto";
import { link, lstat, open, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { StrongCodeError } from "../core/errors";
import {
  PathIdentityError, inspectPath, readVerifiedRegularFile, revalidatePath, verifyOpenFile,
  type PathReceipt
} from "../core/path-identity";
import {
  STRONGCODE_HOME_LEGACY_HASHES, STRONGCODE_HOME_STARTER_FILES,
  type StrongCodeHomeStarterFile
} from "./home-layout";
import type { StrongCodeHomeResult } from "./home";
type HomeContext = {
  readonly homePath: string;
  readonly rootReceipt: PathReceipt;
  readonly result: StrongCodeHomeResult;
};
type PublicationContext = HomeContext & {
  readonly parentReceipt: PathReceipt;
  readonly targetPath: string;
  readonly targetReceipt: PathReceipt;
};
type OwnedFile = HomeContext & {
  readonly handle: FileHandle;
  readonly parentReceipt: PathReceipt;
  readonly path: string;
};
function isCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
async function revalidateParents(context: HomeContext & { readonly parentReceipt: PathReceipt }): Promise<void> {
  await revalidatePath(context.rootReceipt);
  await revalidatePath(context.parentReceipt);
}
async function inspectOwnedFile(owned: OwnedFile): Promise<PathReceipt> {
  const receipt = await inspectPath(owned.path, { finalKind: "regular-file" });
  await revalidateParents(owned);
  await verifyOpenFile(owned.handle, receipt);
  return receipt;
}
async function cleanupOwnedFile(owned: OwnedFile): Promise<void> {
  let receipt: PathReceipt | undefined;
  try {
    receipt = await inspectOwnedFile(owned);
  } catch (error) {
    await owned.handle.close();
    if (error instanceof PathIdentityError || isCode(error, "ENOENT")) return;
    throw error;
  }
  await owned.handle.close();
  try {
    await revalidateParents(owned);
    await revalidatePath(receipt);
    await rm(owned.path);
  } catch (error) {
    if (error instanceof PathIdentityError || isCode(error, "ENOENT")) return;
    throw error;
  }
}
async function createOwnedFile(context: PublicationContext, content: string, mode: number): Promise<OwnedFile> {
  await revalidateParents(context);
  await revalidatePath(context.targetReceipt);
  const handle = await open(context.targetPath, "wx", mode);
  const owned = { ...context, path: context.targetPath, handle };
  try {
    await inspectOwnedFile(owned);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await inspectOwnedFile(owned);
    return owned;
  } catch (error) {
    await cleanupOwnedFile(owned);
    throw error;
  }
}
async function missingFileContext(context: HomeContext, targetPath: string): Promise<PublicationContext> {
  const parentReceipt = await inspectPath(path.dirname(targetPath), { finalKind: "directory" });
  const targetReceipt = await inspectPath(targetPath, { allowMissing: true, finalKind: "regular-file" });
  if (targetReceipt.missingSuffix.length > 1) {
    throw new PathIdentityError("missing-component", targetPath, `Parent directory is unavailable: ${targetPath}`);
  }
  return { ...context, parentReceipt, targetPath, targetReceipt };
}
async function existingTargetStatus(targetPath: string): Promise<"conflict" | "existing"> {
  try {
    await inspectPath(targetPath, { finalKind: "regular-file" });
    return "existing";
  } catch (error) {
    if (error instanceof PathIdentityError) return "conflict";
    throw error;
  }
}
async function publishMissingFile(
  context: PublicationContext,
  file: StrongCodeHomeStarterFile
): Promise<"conflict" | "created" | "existing"> {
  const tempPath = path.join(path.dirname(context.targetPath),
    `.${path.basename(context.targetPath)}.${process.pid}.${randomUUID()}.tmp`);
  const tempContext = await missingFileContext(context, tempPath);
  const owned = await createOwnedFile(tempContext, file.content, file.mode ?? 0o644);
  try {
    await inspectOwnedFile(owned);
    await revalidateParents(context);
    try {
      await revalidatePath(context.targetReceipt);
    } catch (error) {
      if (!(error instanceof PathIdentityError)) throw error;
      return await existingTargetStatus(context.targetPath);
    }
    try {
      await link(tempPath, context.targetPath);
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      return await existingTargetStatus(context.targetPath);
    }
    const published = await inspectPath(context.targetPath, { finalKind: "regular-file" });
    await verifyOpenFile(owned.handle, published);
    await revalidateParents(context);
    return "created";
  } finally {
    await cleanupOwnedFile(owned);
  }
}
function addFileConflict(result: StrongCodeHomeResult, relativePath: string, reason: string): void {
  result.conflicts.push({ path: relativePath, reason });
}
export async function createStarterFiles(
  context: HomeContext,
  unavailableDirectories: ReadonlySet<string>,
  hasUnavailableAncestor: (relativePath: string, unavailable: ReadonlySet<string>) => boolean
): Promise<readonly string[]> {
  const candidates: string[] = [];
  for (const [relativePath, file] of Object.entries(STRONGCODE_HOME_STARTER_FILES)) {
    if (hasUnavailableAncestor(relativePath, unavailableDirectories)) continue;
    const targetPath = path.join(context.homePath, relativePath);
    try {
      await revalidatePath(context.rootReceipt);
      const inspected = await inspectPath(targetPath, { allowMissing: true, finalKind: "regular-file" });
      if (inspected.missingSuffix.length === 0) {
        context.result.existingFiles.push(relativePath);
        candidates.push(relativePath);
        continue;
      }
      const publication = await missingFileContext(context, targetPath);
      const status = await publishMissingFile(publication, file);
      if (status === "created") context.result.createdFiles.push(relativePath);
      else if (status === "existing") {
        context.result.existingFiles.push(relativePath);
        candidates.push(relativePath);
      } else addFileConflict(context.result, relativePath, "Expected a regular file but found another path type");
    } catch (error) {
      if (error instanceof PathIdentityError) {
        addFileConflict(context.result, relativePath, error.message);
        continue;
      }
      throw error;
    }
  }
  return candidates;
}
async function acquireExpansionLock(context: HomeContext): Promise<OwnedFile> {
  const lockPath = path.join(context.homePath, ".home-expand.lock");
  try {
    const publication = await missingFileContext(context, lockPath);
    return await createOwnedFile(publication, `${process.pid}\n`, 0o600);
  } catch (error) {
    if (isCode(error, "EEXIST") || (error instanceof PathIdentityError && error.componentPath === lockPath)) {
      throw new StrongCodeError("CONFIG_ERROR", `Another StrongCode home expansion is already running: ${lockPath}`);
    }
    throw error;
  }
}
async function replaceKnownTemplate(
  context: PublicationContext,
  content: string,
  mode: number
): Promise<boolean> {
  const tempPath = path.join(
    path.dirname(context.targetPath),
    `.${path.basename(context.targetPath)}.${process.pid}.${randomUUID()}.upgrade.tmp`
  );
  const owned = await createOwnedFile(await missingFileContext(context, tempPath), content, mode);
  try {
    await inspectOwnedFile(owned);
    await revalidateParents(context);
    await revalidatePath(context.targetReceipt);
    await rename(tempPath, context.targetPath);
    const published = await inspectPath(context.targetPath, {
      finalKind: "regular-file",
      requireSingleLink: true
    });
    await verifyOpenFile(owned.handle, published);
    await revalidateParents(context);
    return true;
  } catch (error) {
    if (error instanceof PathIdentityError) return false;
    throw error;
  } finally {
    await cleanupOwnedFile(owned);
  }
}
export async function expandGeneratedFiles(context: HomeContext, candidates: readonly string[]): Promise<void> {
  const lock = await acquireExpansionLock(context);
  try {
    for (const relativePath of candidates) {
      const file = STRONGCODE_HOME_STARTER_FILES[relativePath];
      const legacyHashes = STRONGCODE_HOME_LEGACY_HASHES[relativePath];
      if (!file || file.merge !== "upgrade-generated" || !legacyHashes?.length) continue;
      const targetPath = path.join(context.homePath, relativePath);
      try {
        const parentReceipt = await inspectPath(path.dirname(targetPath), { finalKind: "directory" });
        const targetReceipt = await inspectPath(targetPath, {
          finalKind: "regular-file",
          requireSingleLink: true
        });
        await revalidateParents({ ...context, parentReceipt });
        const source = await readVerifiedRegularFile(targetPath, { requireSingleLink: true });
        await revalidatePath(targetReceipt);
        const sourceHash = sha256(source);
        if (sourceHash === sha256(file.content)) continue;
        if (!legacyHashes.includes(sourceHash)) {
          context.result.preservedFiles.push(relativePath);
          continue;
        }
        const stats = await lstat(targetPath);
        await revalidatePath(targetReceipt);
        const replaced = await replaceKnownTemplate(
          { ...context, parentReceipt, targetPath, targetReceipt },
          file.content,
          stats.mode & 0o777
        );
        if (replaced) context.result.upgradedFiles.push(relativePath);
        else context.result.preservedFiles.push(relativePath);
      } catch (error) {
        if (error instanceof PathIdentityError) {
          addFileConflict(context.result, relativePath, error.message);
          continue;
        }
        throw error;
      }
    }
  } finally {
    await cleanupOwnedFile(lock);
  }
}
