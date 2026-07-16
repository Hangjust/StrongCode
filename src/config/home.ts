import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  PathIdentityError,
  inspectPath,
  revalidatePath,
  type PathReceipt
} from "../core/path-identity";
import {
  STRONGCODE_HOME_DIRECTORIES,
  STRONGCODE_HOME_LAYOUT_VERSION
} from "./home-layout";
import { createStarterFiles, expandGeneratedFiles } from "./home-files";
import { resolveStrongCodeHome } from "./paths";

export { STRONGCODE_HOME_DIRECTORIES, STRONGCODE_HOME_LAYOUT_VERSION } from "./home-layout";

export interface EnsureStrongCodeHomeOptions {
  homePath?: string;
  expand?: boolean;
}

export interface StrongCodeHomeConflict {
  path: string;
  reason: string;
}

export interface StrongCodeHomeResult {
  path: string;
  createdDirectories: string[];
  existingDirectories: string[];
  createdFiles: string[];
  existingFiles: string[];
  upgradedFiles: string[];
  preservedFiles: string[];
  conflicts: StrongCodeHomeConflict[];
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

async function pathKind(targetPath: string): Promise<"directory" | "file" | "symlink" | "other" | "missing"> {
  try {
    const stats = await lstat(targetPath);
    if (stats.isSymbolicLink()) return "symlink";
    if (stats.isDirectory()) return "directory";
    if (stats.isFile()) return "file";
    return "other";
  } catch (error) {
    if (isCode(error, "ENOENT")) return "missing";
    throw error;
  }
}

function addRootConflict(result: StrongCodeHomeResult, reason: string): void {
  result.conflicts.push({ path: ".", reason });
}

async function inspectHome(homePath: string): Promise<PathReceipt> {
  return await inspectPath(homePath, { allowMissing: true, finalKind: "directory" });
}

async function ensureRoot(homePath: string, result: StrongCodeHomeResult): Promise<PathReceipt | undefined> {
  let receipt: PathReceipt;
  try {
    receipt = await inspectHome(homePath);
  } catch (error) {
    if (error instanceof PathIdentityError) {
      const kind = await pathKind(homePath);
      const reason = error.reason === "linked-component" && error.componentPath === homePath
        ? `StrongCode home is a ${kind}, expected a directory`
        : error.message;
      addRootConflict(result, reason);
      return undefined;
    }
    throw error;
  }
  while (receipt.missingSuffix.length > 0) {
    try {
      await revalidatePath(receipt);
    } catch (error) {
      if (!(error instanceof PathIdentityError)) throw error;
      try {
        receipt = await inspectHome(homePath);
        continue;
      } catch (inspectionError) {
        if (inspectionError instanceof PathIdentityError) {
          addRootConflict(result, inspectionError.message);
          return undefined;
        }
        throw inspectionError;
      }
    }
    const nextPath = path.join(receipt.existingPrefix, receipt.missingSuffix[0] ?? "");
    try {
      await mkdir(nextPath, { mode: 0o700 });
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
    }
    try {
      receipt = await inspectHome(homePath);
    } catch (error) {
      if (error instanceof PathIdentityError) {
        addRootConflict(result, error.message);
        return undefined;
      }
      throw error;
    }
  }
  return receipt;
}

function hasUnavailableAncestor(relativePath: string, unavailableDirectories: ReadonlySet<string>): boolean {
  let ancestor = path.posix.dirname(relativePath.replaceAll("\\", "/"));
  while (ancestor !== ".") {
    if (unavailableDirectories.has(ancestor)) return true;
    ancestor = path.posix.dirname(ancestor);
  }
  return false;
}

async function ensureDirectories(
  homePath: string,
  rootReceipt: PathReceipt,
  result: StrongCodeHomeResult
): Promise<Set<string>> {
  const unavailableDirectories = new Set<string>();
  const directories = [...STRONGCODE_HOME_DIRECTORIES].sort((left, right) => {
    const depth = left.split("/").length - right.split("/").length;
    return depth || left.localeCompare(right);
  });

  for (const relativePath of directories) {
    if (hasUnavailableAncestor(relativePath, unavailableDirectories)) continue;
    const directoryPath = path.join(homePath, relativePath);
    try {
      await revalidatePath(rootReceipt);
      const receipt = await inspectPath(directoryPath, { allowMissing: true, finalKind: "directory" });
      if (receipt.missingSuffix.length === 0) {
        result.existingDirectories.push(relativePath);
        continue;
      }
      if (receipt.missingSuffix.length !== 1) {
        result.conflicts.push({ path: relativePath, reason: "Parent directory is unavailable or conflicted" });
        unavailableDirectories.add(relativePath);
        continue;
      }
      const parentReceipt = await inspectPath(path.dirname(directoryPath), { finalKind: "directory" });
      await revalidatePath(rootReceipt);
      await revalidatePath(parentReceipt);
      await mkdir(directoryPath, { mode: 0o700 });
      await revalidatePath(rootReceipt);
      await revalidatePath(parentReceipt);
      await inspectPath(directoryPath, { finalKind: "directory" });
      result.createdDirectories.push(relativePath);
    } catch (error) {
      if (error instanceof PathIdentityError || isCode(error, "EEXIST") || isCode(error, "ENOENT")) {
        const kind = await pathKind(directoryPath);
        if (isCode(error, "EEXIST") && kind === "directory") {
          result.existingDirectories.push(relativePath);
          continue;
        }
        const reason = kind === "missing"
          ? "Parent directory is unavailable or conflicted"
          : `Expected a directory but found a ${kind}`;
        result.conflicts.push({ path: relativePath, reason });
        unavailableDirectories.add(relativePath);
        continue;
      }
      throw error;
    }
  }
  return unavailableDirectories;
}

function sortResult(result: StrongCodeHomeResult): StrongCodeHomeResult {
  result.createdDirectories.sort();
  result.existingDirectories.sort();
  result.createdFiles.sort();
  result.existingFiles.sort();
  result.upgradedFiles.sort();
  result.preservedFiles.sort();
  result.conflicts.sort((left, right) => left.path.localeCompare(right.path));
  return result;
}

/**
 * Create missing StrongCode home artifacts without modifying existing user files.
 * Set expand only for an explicit upgrade of byte-identical, known generated templates.
 */
export async function ensureStrongCodeHome(options: EnsureStrongCodeHomeOptions = {}): Promise<StrongCodeHomeResult> {
  const homePath = path.resolve(options.homePath ?? resolveStrongCodeHome());
  const result: StrongCodeHomeResult = {
    path: homePath,
    createdDirectories: [],
    existingDirectories: [],
    createdFiles: [],
    existingFiles: [],
    upgradedFiles: [],
    preservedFiles: [],
    conflicts: []
  };

  const rootReceipt = await ensureRoot(homePath, result);
  if (rootReceipt === undefined) return sortResult(result);
  const unavailableDirectories = await ensureDirectories(homePath, rootReceipt, result);
  const context = { homePath, rootReceipt, result };
  const expansionCandidates = await createStarterFiles(context, unavailableDirectories, hasUnavailableAncestor);
  if (options.expand) await expandGeneratedFiles(context, expansionCandidates);
  return sortResult(result);
}
