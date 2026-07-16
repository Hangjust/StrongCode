import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  BlenderInstallError,
  canonicalTargetPath,
  isNodeError,
  pathState,
  syncDirectory
} from "./durable-fs";
import { profileIdSchema } from "./journal-schema";

const lockRecordSchema = z.object({
  token: z.string().uuid(),
  profileId: profileIdSchema,
  pid: z.number().int().positive(),
  createdAt: z.string().datetime()
}).strict().readonly();
const MAX_LOCK_AGE_MS = 24 * 60 * 60 * 1000;

export type BlenderInstallLock = {
  readonly path: string;
  readonly token: string;
  readonly homePath: string;
  readonly profileId: string;
  readonly release: () => Promise<void>;
};

export type BlenderInstallLockInspection =
  | { readonly kind: "absent"; readonly path: string }
  | { readonly kind: "present"; readonly path: string };

function lockPath(lockDirectory: string, profileId: string): string {
  const lockName = createHash("sha256").update(profileId).digest("hex").slice(0, 24);
  return path.join(lockDirectory, `blender-install-${lockName}.lock`);
}

export async function inspectBlenderInstallLock(
  homePath: string,
  profileId: string
): Promise<BlenderInstallLockInspection> {
  const profile = profileIdSchema.parse(profileId);
  const resolvedHome = path.resolve(homePath);
  const homeStats = await lstat(resolvedHome);
  if (homeStats.isSymbolicLink() || !homeStats.isDirectory()) {
    throw new BlenderInstallError("unsafe-path", `StrongCode home must be a real directory: ${resolvedHome}`);
  }
  const lockDirectory = path.join(resolvedHome, "locks");
  let directoryStats;
  try {
    directoryStats = await lstat(lockDirectory);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { kind: "absent", path: lockPath(lockDirectory, profile) };
    throw error;
  }
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new BlenderInstallError("unsafe-path", `Installer lock path is not a real directory: ${lockDirectory}`);
  }
  const candidate = lockPath(lockDirectory, profile);
  try {
    await lstat(candidate);
    return { kind: "present", path: candidate };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { kind: "absent", path: candidate };
    throw error;
  }
}

async function ensureLockDirectory(homePath: string): Promise<string> {
  const resolvedHome = path.resolve(homePath);
  const stats = await lstat(resolvedHome);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new BlenderInstallError("unsafe-path", `StrongCode home must be a real directory: ${resolvedHome}`);
  }
  const lockDirectory = await canonicalTargetPath(path.join(resolvedHome, "locks"));
  const state = await pathState(lockDirectory);
  if (state.kind === "absent") await mkdir(lockDirectory, { mode: 0o700 });
  else if (state.kind !== "directory") throw new BlenderInstallError("unsafe-path", `Installer lock path is not a directory: ${lockDirectory}`);
  if (process.platform !== "win32") await chmod(lockDirectory, 0o700);
  await syncDirectory(resolvedHome);
  return lockDirectory;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error, "ESRCH")) return false;
    if (isNodeError(error, "EPERM")) return true;
    throw error;
  }
}

async function readLock(lockPath: string): Promise<z.infer<typeof lockRecordSchema>> {
  const state = await pathState(lockPath);
  if (state.kind !== "file") throw new BlenderInstallError("conflict", `Installer lock is not a regular file: ${lockPath}`);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(lockPath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new BlenderInstallError("conflict", `Installer lock is malformed: ${lockPath}`);
    throw error;
  }
  const parsed = lockRecordSchema.safeParse(value);
  if (!parsed.success) throw new BlenderInstallError("conflict", `Installer lock is malformed: ${lockPath}`);
  return parsed.data;
}

export async function acquireBlenderInstallLock(homePath: string, profileId: string): Promise<BlenderInstallLock> {
  const profile = profileIdSchema.parse(profileId);
  const lockDirectory = await ensureLockDirectory(homePath);
  const lockFilePath = lockPath(lockDirectory, profile);
  const token = randomUUID();
  const record = { token, profileId: profile, pid: process.pid, createdAt: new Date().toISOString() };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle;
    try {
      handle = await open(lockFilePath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await syncDirectory(lockDirectory);
      return {
        path: lockFilePath,
        token,
        homePath: path.resolve(homePath),
        profileId: profile,
        release: () => releaseBlenderInstallLock(homePath, profile, token)
      };
    } catch (error) {
      await handle?.close();
      if (!isNodeError(error, "EEXIST")) throw error;
      const existing = await readLock(lockFilePath);
      const ageMs = Date.now() - Date.parse(existing.createdAt);
      if (processIsAlive(existing.pid) && ageMs >= 0 && ageMs <= MAX_LOCK_AGE_MS) {
        throw new BlenderInstallError("conflict", `Another Blender installation is already running for ${profile}`);
      }
      const stalePath = path.join(lockDirectory, `.stale-${token}.lock`);
      try {
        await rename(lockFilePath, stalePath);
        await rm(stalePath);
        await syncDirectory(lockDirectory);
      } catch (reclaimError) {
        if (!isNodeError(reclaimError, "ENOENT")) throw reclaimError;
      }
    }
  }
  throw new BlenderInstallError("conflict", `Unable to acquire Blender installer lock for ${profile}`);
}

export async function assertBlenderInstallLock(homePath: string, profileId: string, token: string): Promise<void> {
  const profile = profileIdSchema.parse(profileId);
  const lockDirectory = await ensureLockDirectory(homePath);
  const current = await readLock(lockPath(lockDirectory, profile));
  if (current.token !== token || current.profileId !== profile || current.pid !== process.pid) {
    throw new BlenderInstallError("conflict", `Blender installer lock is not owned by this process for ${profile}`);
  }
}

export async function releaseBlenderInstallLock(homePath: string, profileId: string, token: string): Promise<void> {
  const profile = profileIdSchema.parse(profileId);
  const lockDirectory = await ensureLockDirectory(homePath);
  const lockFilePath = lockPath(lockDirectory, profile);
  const current = await readLock(lockFilePath);
  if (current.token !== token || current.profileId !== profile) {
    throw new BlenderInstallError("conflict", `Installer lock ownership changed: ${lockFilePath}`);
  }
  await rm(lockFilePath);
  await syncDirectory(lockDirectory);
}
