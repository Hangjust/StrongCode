import type { Stats } from "node:fs";
import { randomBytes } from "node:crypto";
import { lstat, open, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { StrongCodeError } from "../core/errors";
import { inspectPath, verifyOpenFile } from "../core/path-identity";
import {
  isMissingSessionPath,
  type SessionDirectoryReceipts,
  sessionDirectoryReceiptsMatch,
  SessionPathSecurity
} from "./session-path-security";

export type StoreDirectoryStats = {
  readonly dataDir: Stats;
  readonly sessionsDir: Stats;
  readonly receipts: SessionDirectoryReceipts;
};

export type SecuredSessionFile = {
  readonly bytes: Buffer;
  readonly stats: Stats;
};

export type OwnedSessionTempFile = {
  readonly path: string;
  readonly stats: Stats;
  readonly handle: FileHandle;
  readonly directories: StoreDirectoryStats;
};

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function sessionError(message: string): StrongCodeError {
  return new StrongCodeError("SESSION_ERROR", message);
}

export function toSessionError(error: unknown): StrongCodeError {
  if (error instanceof StrongCodeError && error.code === "SESSION_ERROR") return error;
  return sessionError(error instanceof Error ? error.message : String(error));
}

function identityIsAvailable(stats: Stats): boolean {
  return stats.dev !== 0 && stats.ino !== 0;
}

export function identitiesMatch(left: Stats, right: Stats): boolean {
  return identityIsAvailable(left)
    && identityIsAvailable(right)
    && left.dev === right.dev
    && left.ino === right.ino;
}

export class SessionFileSecurity {
  readonly dataDir: string;
  readonly sessionsDir: string;
  private readonly paths: SessionPathSecurity;

  constructor(dataDir: string) {
    this.paths = new SessionPathSecurity(dataDir);
    this.dataDir = this.paths.dataDir;
    this.sessionsDir = this.paths.sessionsDir;
  }

  async prepareStoreForWrite(): Promise<StoreDirectoryStats> {
    const receipts = await this.paths.prepareStoreForWrite();
    return await this.storeDirectoryStats(receipts);
  }

  async storeDirectoryStatsForRead(): Promise<StoreDirectoryStats | undefined> {
    try {
      return await this.assertStoreDirectories();
    } catch (error) {
      if (isMissing(error) || isMissingSessionPath(error)) return undefined;
      throw error;
    }
  }

  async assertStoreDirectories(): Promise<StoreDirectoryStats> {
    return await this.storeDirectoryStats(await this.paths.inspectStore());
  }

  async sessionFileStats(filePath: string): Promise<Stats | undefined> {
    await this.assertStoreDirectories();
    try {
      const stats = await lstat(filePath);
      this.assertRegularFile(stats, filePath);
      return stats;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async readSecuredFile(
    filePath: string,
    directories: StoreDirectoryStats
  ): Promise<SecuredSessionFile | undefined> {
    this.assertDirectoryIdentities(directories, await this.assertStoreDirectories());
    const initialStats = await this.sessionFileStats(filePath);
    this.assertDirectoryIdentities(directories, await this.assertStoreDirectories());
    if (initialStats === undefined) return undefined;
    const handle = await open(filePath, "r");
    try {
      const stats = await this.assertHandleIdentity(handle, filePath, directories);
      const bytes = await handle.readFile();
      const finalStats = await this.assertHandleIdentity(handle, filePath, directories);
      this.assertFileIdentity(stats, finalStats, `Session record changed while reading: ${filePath}`);
      if (finalStats.size !== bytes.length) throw sessionError(`Session record changed while reading: ${filePath}`);
      return { bytes, stats: finalStats };
    } finally {
      await handle.close();
    }
  }

  async createExclusiveTemp(
    filePath: string,
    directories: StoreDirectoryStats,
    maxAttempts: number
  ): Promise<OwnedSessionTempFile> {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const tempPath = path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`
      );
      try {
        this.assertDirectoryIdentities(directories, await this.assertStoreDirectories());
        const handle = await open(tempPath, "wx", 0o600);
        let openedStats: Stats | undefined;
        try {
          openedStats = await handle.stat();
          this.assertRegularFile(openedStats, tempPath);
          this.assertDirectoryIdentities(directories, await this.assertStoreDirectories());
          const stats = await this.assertHandleIdentity(handle, tempPath, directories);
          if (process.platform !== "win32") await handle.chmod(0o600);
          return { path: tempPath, stats, handle, directories };
        } catch (error) {
          await handle.close().catch(() => undefined);
          if (openedStats !== undefined) {
            await this.removeOwnedTemp({
              path: tempPath,
              stats: openedStats,
              handle,
              directories
            }).catch(() => undefined);
          }
          throw error;
        }
      } catch (error) {
        if (isFileSystemError(error, "EEXIST")) continue;
        throw error;
      }
    }
    throw sessionError(`Could not create exclusive checkpoint temp file for: ${filePath}`);
  }

  async removeOwnedTemp(temp: OwnedSessionTempFile): Promise<void> {
    this.assertDirectoryIdentities(temp.directories, await this.assertStoreDirectories());
    let current: Stats;
    try {
      current = await lstat(temp.path);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    this.assertRegularFile(current, temp.path);
    this.assertFileIdentity(temp.stats, current, `Checkpoint temp file changed before cleanup: ${temp.path}`);
    this.assertDirectoryIdentities(temp.directories, await this.assertStoreDirectories());
    await unlink(temp.path);
  }

  assertRegularFile(stats: Stats, label: string): void {
    if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1 || !identityIsAvailable(stats)) {
      throw sessionError(`Refusing to use linked or non-file session record: ${label}`);
    }
  }

  async assertHandleIdentity(
    handle: FileHandle,
    filePath: string,
    expectedDirectories: StoreDirectoryStats
  ): Promise<Stats> {
    this.assertDirectoryIdentities(expectedDirectories, await this.assertStoreDirectories());
    const receipt = await inspectPath(filePath, { finalKind: "regular-file", requireSingleLink: true });
    await verifyOpenFile(handle, receipt);
    const [handleStats, pathStats] = await Promise.all([handle.stat(), lstat(filePath)]);
    this.assertRegularFile(handleStats, filePath);
    this.assertRegularFile(pathStats, filePath);
    this.assertFileIdentity(handleStats, pathStats, `Session record changed while opening: ${filePath}`);
    return handleStats;
  }

  assertDirectoryIdentities(expected: StoreDirectoryStats, current: StoreDirectoryStats): void {
    if (!sessionDirectoryReceiptsMatch(expected.receipts, current.receipts)
      || !identitiesMatch(expected.dataDir, current.dataDir)
      || !identitiesMatch(expected.sessionsDir, current.sessionsDir)) {
      throw sessionError(`Session store changed during use: ${this.sessionsDir}`);
    }
  }

  assertFileIdentity(expected: Stats, current: Stats, message: string): void {
    if (!identitiesMatch(expected, current)) throw sessionError(message);
  }

  private async storeDirectoryStats(receipts: SessionDirectoryReceipts): Promise<StoreDirectoryStats> {
    const [dataDir, sessionsDir] = await Promise.all([lstat(this.dataDir), lstat(this.sessionsDir)]);
    if (!dataDir.isDirectory() || dataDir.isSymbolicLink() || !sessionsDir.isDirectory()
      || sessionsDir.isSymbolicLink() || !identityIsAvailable(dataDir) || !identityIsAvailable(sessionsDir)) {
      throw sessionError(`Refusing to use linked or non-directory session store: ${this.sessionsDir}`);
    }
    await this.paths.revalidate(receipts);
    return Object.freeze({ dataDir, sessionsDir, receipts });
  }
}
