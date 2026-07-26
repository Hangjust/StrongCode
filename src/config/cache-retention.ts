import { opendir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  inspectPath,
  PathIdentityError,
  readVerifiedRegularFile,
  revalidatePath,
  verifiedRegularFileMetadata,
  type PathReceipt
} from "../core/path-identity";

const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_CACHE_DAYS = 30;
const RETENTION_POLICY_LIMIT_BYTES = 64n * 1_024n;
const MAX_CACHE_ENTRIES_PER_RUN = 10_000;
const MAX_CACHE_DEPTH = 64;
const MAX_RECORDED_PATHS = 256;
const RECOVERABLE_CACHE_ERROR_CODES = new Set([
  "EACCES", "EBUSY", "ELOOP", "EMFILE", "ENFILE", "ENOENT", "ENOTEMPTY", "EPERM"
]);
const retentionPolicySchema = z.object({
  version: z.literal(1),
  cacheDays: z.number().int().nonnegative().nullable()
}).passthrough().readonly();

export interface CacheRetentionResult {
  readonly removedFiles: readonly string[];
  readonly removedDirectories: readonly string[];
  readonly skippedPaths: readonly string[];
}

type MutableCacheRetentionResult = {
  readonly removedFiles: string[];
  readonly removedDirectories: string[];
  readonly skippedPaths: string[];
  readonly skippedPathSet: Set<string>;
};

type CleanupContext = {
  readonly homePath: string;
  readonly cacheReceipt: PathReceipt;
  readonly cutoffMs: number;
  readonly result: MutableCacheRetentionResult;
  remainingEntries: number;
};

function isCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function relativeToHome(homePath: string, targetPath: string): string {
  return path.relative(homePath, targetPath).split(path.sep).join("/");
}

function skip(result: MutableCacheRetentionResult, relativePath: string): void {
  if (result.skippedPathSet.has(relativePath)) return;
  result.skippedPathSet.add(relativePath);
  if (result.skippedPaths.length < MAX_RECORDED_PATHS) result.skippedPaths.push(relativePath);
}

function record(target: string[], relativePath: string): void {
  if (target.length < MAX_RECORDED_PATHS) target.push(relativePath);
}

function isRecoverableCacheError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error) || typeof error.code !== "string") return false;
  return RECOVERABLE_CACHE_ERROR_CODES.has(error.code);
}

async function cacheDays(homePath: string, result: MutableCacheRetentionResult): Promise<number | null | undefined> {
  const policyPath = path.join(homePath, "config", "retention.json");
  let source: Buffer;
  try {
    source = await readVerifiedRegularFile(policyPath, {
      maxBytes: RETENTION_POLICY_LIMIT_BYTES,
      requireSingleLink: true
    });
  } catch (error) {
    if (isCode(error, "ENOENT")) return DEFAULT_CACHE_DAYS;
    if (error instanceof PathIdentityError && error.reason === "missing-component") return DEFAULT_CACHE_DAYS;
    if (error instanceof PathIdentityError || isRecoverableCacheError(error)) {
      skip(result, "config/retention.json");
      return undefined;
    }
    throw error;
  }
  try {
    const parsed = retentionPolicySchema.safeParse(JSON.parse(source.toString("utf8")));
    if (parsed.success) return parsed.data.cacheDays;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  skip(result, "config/retention.json");
  return undefined;
}

async function removeExpiredFile(context: CleanupContext, filePath: string): Promise<boolean> {
  const relativePath = relativeToHome(context.homePath, filePath);
  try {
    const receipt = await inspectPath(filePath, { finalKind: "regular-file", requireSingleLink: true });
    const metadata = verifiedRegularFileMetadata(receipt);
    if (metadata.linkCount !== 1 || metadata.modifiedAtMs > context.cutoffMs) return false;
    await revalidatePath(context.cacheReceipt);
    await revalidatePath(receipt);
    await rm(filePath);
    record(context.result.removedFiles, relativePath);
    return true;
  } catch (error) {
    if (error instanceof PathIdentityError || isRecoverableCacheError(error)) {
      skip(context.result, relativePath);
      return false;
    }
    throw error;
  }
}

async function cleanDirectory(
  context: CleanupContext,
  directoryPath: string,
  receipt: PathReceipt,
  depth: number
): Promise<boolean> {
  const relativeDirectory = relativeToHome(context.homePath, directoryPath);
  if (depth > MAX_CACHE_DEPTH) {
    skip(context.result, relativeDirectory);
    return false;
  }
  let removed = false;
  try {
    await revalidatePath(context.cacheReceipt);
    await revalidatePath(receipt);
    const directory = await opendir(directoryPath);
    for await (const entry of directory) {
      if (context.remainingEntries === 0) {
        skip(context.result, "cache");
        break;
      }
      context.remainingEntries -= 1;
      const entryPath = path.join(directoryPath, entry.name);
      const relativePath = relativeToHome(context.homePath, entryPath);
      if (entry.isSymbolicLink()) {
        skip(context.result, relativePath);
        continue;
      }
      if (!entry.isDirectory()) {
        removed = await removeExpiredFile(context, entryPath) || removed;
        continue;
      }
      try {
        const childReceipt = await inspectPath(entryPath, { finalKind: "directory" });
        const childRemoved = await cleanDirectory(context, entryPath, childReceipt, depth + 1);
        removed = childRemoved || removed;
        if (!childRemoved || relativePath.split("/").length <= 2) continue;
        await revalidatePath(context.cacheReceipt);
        await revalidatePath(childReceipt);
        await rmdir(entryPath);
        record(context.result.removedDirectories, relativePath);
      } catch (error) {
        if (error instanceof PathIdentityError || isRecoverableCacheError(error)) {
          skip(context.result, relativePath);
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    if (error instanceof PathIdentityError || isRecoverableCacheError(error)) {
      skip(context.result, relativeDirectory || "cache");
      return removed;
    }
    throw error;
  }
  return removed;
}

export async function enforceHomeCacheRetention(homePathInput: string, nowMs = Date.now()): Promise<CacheRetentionResult> {
  const homePath = path.resolve(homePathInput);
  const result: MutableCacheRetentionResult = {
    removedFiles: [],
    removedDirectories: [],
    skippedPaths: [],
    skippedPathSet: new Set()
  };
  const days = await cacheDays(homePath, result);
  if (days === null || days === undefined) return result;
  const cachePath = path.join(homePath, "cache");
  try {
    const cacheReceipt = await inspectPath(cachePath, { finalKind: "directory" });
    await cleanDirectory({
      homePath,
      cacheReceipt,
      cutoffMs: nowMs - days * DAY_MS,
      result,
      remainingEntries: MAX_CACHE_ENTRIES_PER_RUN
    }, cachePath, cacheReceipt, 0);
  } catch (error) {
    if (error instanceof PathIdentityError || isRecoverableCacheError(error)) {
      skip(result, "cache");
      return result;
    }
    throw error;
  }
  result.removedFiles.sort();
  result.removedDirectories.sort();
  result.skippedPaths.sort();
  return result;
}
