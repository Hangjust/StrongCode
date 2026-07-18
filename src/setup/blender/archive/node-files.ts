import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { writeDurableFile } from "../durable-fs";
import { ArchiveValidationError } from "./errors";
import type { SafeArchiveFileSystem } from "./types";

export const nodeSafeArchiveFileSystem: SafeArchiveFileSystem = {
  async createStagingDirectory(parentDirectory) {
    const resolved = path.resolve(parentDirectory);
    const stats = await lstat(resolved);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new ArchiveValidationError("filesystem", `Archive staging parent must be a real directory: ${resolved}`);
    }
    const canonical = await realpath(resolved);
    return mkdtemp(path.join(canonical, ".strongcode-archive-"));
  },
  async createDirectory(directoryPath) {
    await mkdir(directoryPath, { mode: 0o700 });
  },
  async writeExclusive(filePath, content) {
    await writeDurableFile(filePath, content, 0o600);
  },
  async removeTree(filePath) {
    await rm(filePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
};
