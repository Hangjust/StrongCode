import type { BigIntStats } from "node:fs";
import { constants as bufferConstants } from "node:buffer";
import { lstat, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
export type PathIdentityReason =
  | "identity-changed"
  | "identity-unavailable"
  | "linked-component"
  | "missing-component"
  | "multiple-links" | "non-directory-ancestor" | "size-limit" | "wrong-final-kind";
type IdentityBase = {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
};
type PathComponentIdentity =
  | (IdentityBase & { readonly kind: "directory" })
  | (IdentityBase & { readonly kind: "other" })
  | (IdentityBase & {
    readonly kind: "regular-file";
    readonly nlink: bigint;
    readonly size: bigint;
    readonly mtimeNs: bigint;
    readonly ctimeNs: bigint;
  });
type FinalKind = "directory" | "regular-file";
const receiptBrand: unique symbol = Symbol("PathReceipt");
export type PathReceipt = {
  readonly [receiptBrand]: true;
  readonly targetPath: string;
  readonly existingPrefix: string;
  readonly missingSuffix: readonly string[];
  readonly components: readonly PathComponentIdentity[];
  readonly allowMissing: boolean;
  readonly finalKind: FinalKind | undefined;
  readonly requireSingleLink: boolean;
};
export type InspectPathOptions = {
  readonly allowMissing?: boolean;
  readonly finalKind?: FinalKind;
  readonly requireSingleLink?: boolean;
};
export type ReadVerifiedRegularFileOptions = { readonly maxBytes?: bigint; readonly requireSingleLink?: boolean };
export type VerifiedRegularFileMetadata = {
  readonly modifiedAtMs: number;
  readonly linkCount: number;
};
export class PathIdentityError extends Error {
  readonly name = "PathIdentityError";
  constructor(
    readonly reason: PathIdentityReason,
    readonly componentPath: string,
    message: string
  ) {
    super(message);
  }
}
function failure(reason: PathIdentityReason, componentPath: string, message: string): PathIdentityError {
  return new PathIdentityError(reason, componentPath, message);
}
function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function observe(componentPath: string, stats: BigIntStats): PathComponentIdentity {
  if (stats.isSymbolicLink()) {
    throw failure("linked-component", componentPath, `Refusing linked path component: ${componentPath}`);
  }
  if (stats.dev === 0n || stats.ino === 0n) {
    throw failure("identity-unavailable", componentPath, `Filesystem identity is unavailable: ${componentPath}`);
  }
  const identity = { path: componentPath, dev: stats.dev, ino: stats.ino };
  if (stats.isDirectory()) return Object.freeze({ ...identity, kind: "directory" });
  if (!stats.isFile()) return Object.freeze({ ...identity, kind: "other" });
  return Object.freeze({
    ...identity,
    kind: "regular-file",
    nlink: stats.nlink,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs
  });
}
function assertSingleLink(component: PathComponentIdentity): void {
  if (component.kind === "regular-file" && component.nlink !== 1n) {
    throw failure("multiple-links", component.path, `Refusing hardlinked regular file: ${component.path}`);
  }
}
function freezeReceipt(
  targetPath: string,
  components: readonly PathComponentIdentity[],
  missingSuffix: readonly string[],
  options: InspectPathOptions
): PathReceipt {
  const existing = components.at(-1);
  if (existing === undefined) {
    throw failure("missing-component", targetPath, `Filesystem root does not exist: ${targetPath}`);
  }
  return Object.freeze<PathReceipt>({
    [receiptBrand]: true,
    targetPath,
    existingPrefix: existing.path,
    missingSuffix: Object.freeze([...missingSuffix]),
    components: Object.freeze([...components]),
    allowMissing: options.allowMissing ?? false,
    finalKind: options.finalKind,
    requireSingleLink: options.requireSingleLink ?? false
  });
}
/**
 * Node exposes no portable descriptor-relative component walk on Windows or POSIX.
 * These checks fail closed around operations but cannot eliminate an active kernel namespace race.
 */
export async function inspectPath(targetPath: string, options: InspectPathOptions = {}): Promise<PathReceipt> {
  const resolved = path.resolve(targetPath);
  const root = path.parse(resolved).root;
  const segments = path.relative(root, resolved).split(path.sep).filter(Boolean);
  const components: PathComponentIdentity[] = [];
  let current = root;
  for (let index = 0; index <= segments.length; index += 1) {
    if (index > 0) current = path.join(current, segments[index - 1] ?? "");
    let stats: BigIntStats;
    try {
      stats = await lstat(current, { bigint: true });
    } catch (error) {
      if (!isMissing(error)) throw error;
      if (!(options.allowMissing ?? false) || components.length === 0) {
        throw failure("missing-component", current, `Path component does not exist: ${current}`);
      }
      return freezeReceipt(resolved, components, segments.slice(index - 1), options);
    }
    const component = observe(current, stats);
    const final = index === segments.length;
    if (!final && component.kind !== "directory") {
      throw failure("non-directory-ancestor", current, `Path ancestor is not a directory: ${current}`);
    }
    if (final && options.finalKind !== undefined && component.kind !== options.finalKind) {
      throw failure("wrong-final-kind", current, `Path has the wrong final type: ${current}`);
    }
    if (final && (options.requireSingleLink ?? false)) assertSingleLink(component);
    components.push(component);
  }
  return freezeReceipt(resolved, components, [], options);
}
function componentsMatch(expected: PathComponentIdentity, current: PathComponentIdentity): boolean {
  if (expected.kind !== current.kind || expected.dev !== current.dev || expected.ino !== current.ino) return false;
  if (expected.kind !== "regular-file" || current.kind !== "regular-file") return true;
  return expected.nlink === current.nlink
    && expected.size === current.size
    && expected.mtimeNs === current.mtimeNs
    && expected.ctimeNs === current.ctimeNs;
}
export async function revalidatePath(receipt: PathReceipt): Promise<void> {
  const current = await inspectPath(receipt.targetPath, {
    allowMissing: receipt.allowMissing,
    finalKind: receipt.finalKind,
    requireSingleLink: receipt.requireSingleLink
  });
  if (receipt.missingSuffix.length !== current.missingSuffix.length
    || receipt.components.length !== current.components.length) {
    throw failure("identity-changed", receipt.targetPath, `Path structure changed: ${receipt.targetPath}`);
  }
  for (let index = 0; index < receipt.components.length; index += 1) {
    const expected = receipt.components[index];
    const observed = current.components[index];
    if (expected === undefined || observed === undefined || !componentsMatch(expected, observed)) {
      const changedPath = expected?.path ?? receipt.targetPath;
      throw failure("identity-changed", changedPath, `Path identity changed: ${changedPath}`);
    }
  }
  if (receipt.missingSuffix.some((segment, index) => segment !== current.missingSuffix[index])) {
    throw failure("identity-changed", receipt.targetPath, `Missing path suffix changed: ${receipt.targetPath}`);
  }
}
function finalRegularFile(receipt: PathReceipt): Extract<PathComponentIdentity, { readonly kind: "regular-file" }> {
  const component = receipt.components.at(-1);
  if (component?.kind !== "regular-file" || receipt.missingSuffix.length > 0) {
    throw failure("wrong-final-kind", receipt.targetPath, `Expected an existing regular file: ${receipt.targetPath}`);
  }
  return component;
}
export function verifiedRegularFileMetadata(receipt: PathReceipt): VerifiedRegularFileMetadata {
  const component = finalRegularFile(receipt);
  return Object.freeze({
    modifiedAtMs: Number(component.mtimeNs) / 1_000_000,
    linkCount: Number(component.nlink)
  });
}
export async function verifyOpenFile(handle: FileHandle, receipt: PathReceipt): Promise<void> {
  await revalidatePath(receipt);
  const expected = finalRegularFile(receipt);
  const opened = observe(receipt.targetPath, await handle.stat({ bigint: true }));
  if (receipt.requireSingleLink) assertSingleLink(opened);
  if (!componentsMatch(expected, opened)) {
    throw failure("identity-changed", receipt.targetPath, `Opened file identity changed: ${receipt.targetPath}`);
  }
}
export async function readVerifiedRegularFile(
  targetPath: string,
  options: ReadVerifiedRegularFileOptions = {}
): Promise<Buffer> {
  const receipt = await inspectPath(targetPath, {
    finalKind: "regular-file",
    requireSingleLink: options.requireSingleLink
  });
  const expected = finalRegularFile(receipt);
  if (expected.size > BigInt(bufferConstants.MAX_LENGTH)
    || (options.maxBytes !== undefined && expected.size > options.maxBytes)) {
    throw failure("size-limit", receipt.targetPath, `Regular file exceeds the read limit: ${receipt.targetPath}`);
  }
  const handle = await open(receipt.targetPath, "r");
  try {
    await verifyOpenFile(handle, receipt);
    const bytes = Buffer.allocUnsafe(Number(expected.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const trailing = await handle.read(Buffer.allocUnsafe(1), 0, 1, bytes.length);
    await verifyOpenFile(handle, receipt);
    if (offset !== bytes.length || trailing.bytesRead !== 0) {
      throw failure("identity-changed", receipt.targetPath,
        `Regular file changed while reading: ${receipt.targetPath}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}
