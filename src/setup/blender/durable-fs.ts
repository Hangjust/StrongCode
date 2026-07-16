import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm
} from "node:fs/promises";
import path from "node:path";
import type { PathState } from "./journal-schema";

let directorySyncSupported = true;

export class BlenderInstallError extends Error {
  readonly name = "BlenderInstallError";

  constructor(readonly reason: "conflict" | "invalid-journal" | "unsafe-path" | "invalid-transition", message: string) {
    super(message);
  }
}

export function isNodeError(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

export function sha256(source: string | Buffer): string {
  return createHash("sha256").update(source).digest("hex");
}

export function statesEqual(left: PathState, right: PathState): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "absent" || right.kind === "absent") return true;
  return left.sha256 === right.sha256;
}

export async function assertSafeParentComponents(filePath: string): Promise<void> {
  const resolved = path.resolve(filePath);
  const root = path.parse(resolved).root;
  const parent = path.dirname(resolved);
  let current = root;
  for (const segment of path.relative(root, parent).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) throw new BlenderInstallError("unsafe-path", `Refusing symlink or junction path component: ${current}`);
    if (!stats.isDirectory()) throw new BlenderInstallError("unsafe-path", `Refusing non-directory path component: ${current}`);
  }
}

export async function canonicalTargetPath(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  await assertSafeParentComponents(resolved);
  const parent = await realpath(path.dirname(resolved));
  const canonical = path.join(parent, path.basename(resolved));
  let stats;
  try {
    stats = await lstat(canonical);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return canonical;
    throw error;
  }
  if (stats.isSymbolicLink()) throw new BlenderInstallError("unsafe-path", `Refusing symlinked managed target: ${canonical}`);
  return realpath(canonical);
}

async function directoryHash(directoryPath: string): Promise<string> {
  const digest = createHash("sha256");
  for (const name of (await readdir(directoryPath)).sort()) {
    const childPath = path.join(directoryPath, name);
    const child = await pathState(childPath);
    if (child.kind === "absent") throw new BlenderInstallError("unsafe-path", `Directory entry disappeared while hashing: ${childPath}`);
    digest.update(`${Buffer.byteLength(name)}:${name}:${child.kind}:${child.sha256}\n`);
  }
  return digest.digest("hex");
}

export async function pathState(filePath: string): Promise<PathState> {
  let stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { kind: "absent" };
    throw error;
  }
  if (stats.isSymbolicLink()) throw new BlenderInstallError("unsafe-path", `Refusing symlinked path: ${filePath}`);
  if (stats.isFile()) return { kind: "file", sha256: sha256(await readFile(filePath)) };
  if (stats.isDirectory()) return { kind: "directory", sha256: await directoryHash(filePath) };
  throw new BlenderInstallError("unsafe-path", `Refusing unsupported path type: ${filePath}`);
}

export async function syncDirectory(directoryPath: string): Promise<void> {
  if (!directorySyncSupported) return;
  let handle;
  try {
    handle = await open(directoryPath, "r");
    await handle.sync();
  } catch (error) {
    const unsupported = process.platform === "win32"
      && (isNodeError(error, "EPERM") || isNodeError(error, "EISDIR") || isNodeError(error, "EINVAL"));
    if (!unsupported) throw error;
    directorySyncSupported = false;
  } finally {
    await handle?.close();
  }
}

export async function writeDurableFile(filePath: string, content: string | Buffer, mode: number): Promise<void> {
  await assertSafeParentComponents(filePath);
  const handle = await open(filePath, "wx", mode);
  try {
    await handle.writeFile(content);
    if (process.platform !== "win32") await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(filePath));
}

export async function writeDurableJson(filePath: string, value: unknown): Promise<void> {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeDurableFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 0o600);
    const existing = await pathState(filePath);
    if (existing.kind !== "absent" && existing.kind !== "file") {
      throw new BlenderInstallError("unsafe-path", `Refusing to replace non-file journal path: ${filePath}`);
    }
    await rename(temporary, filePath);
    if (process.platform !== "win32") await chmod(filePath, 0o600);
    await syncDirectory(path.dirname(filePath));
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function copyPathDurable(sourcePath: string, destinationPath: string, privateFile = false): Promise<PathState> {
  const source = await pathState(sourcePath);
  if (source.kind === "absent") throw new BlenderInstallError("unsafe-path", `Copy source does not exist: ${sourcePath}`);
  if ((await pathState(destinationPath)).kind !== "absent") throw new BlenderInstallError("conflict", `Copy destination already exists: ${destinationPath}`);
  if (source.kind === "file") {
    await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL);
    await chmod(destinationPath, privateFile ? 0o600 : (await lstat(sourcePath)).mode & 0o777);
    const handle = await open(destinationPath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } else {
    await mkdir(destinationPath, { mode: 0o700 });
    for (const name of (await readdir(sourcePath)).sort()) {
      await copyPathDurable(path.join(sourcePath, name), path.join(destinationPath, name), privateFile);
    }
    await syncDirectory(destinationPath);
  }
  await syncDirectory(path.dirname(destinationPath));
  const copied = await pathState(destinationPath);
  if (!statesEqual(source, copied)) throw new BlenderInstallError("conflict", `Durable copy hash mismatch: ${destinationPath}`);
  return copied;
}

export async function removePath(filePath: string): Promise<void> {
  const state = await pathState(filePath);
  if (state.kind === "absent") return;
  await rm(filePath, { recursive: state.kind === "directory" });
  await syncDirectory(path.dirname(filePath));
}
