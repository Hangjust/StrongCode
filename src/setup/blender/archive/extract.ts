import path from "node:path";
import { ArchiveValidationError } from "./errors";
import { nodeSafeArchiveFileSystem } from "./node-files";
import { readSafeZip } from "./reader";
import { resolveArchiveRoot } from "./root";
import type { RequiredArchiveManifest, SafeArchiveFileSystem, SafeZipArchive } from "./types";

export type ExtractSafeArchiveOptions = {
  readonly archive: Buffer;
  readonly parentDirectory: string;
  readonly requiredManifest: RequiredArchiveManifest;
  readonly files?: SafeArchiveFileSystem;
};

export type ExtractedSafeArchive = {
  readonly stagingPath: string;
  readonly contentRoot: string;
};

export async function extractSafeArchive(options: ExtractSafeArchiveOptions): Promise<ExtractedSafeArchive> {
  const archive = readSafeZip(options.archive);
  const root = resolveArchiveRoot(archive, options.requiredManifest);
  const files = options.files ?? nodeSafeArchiveFileSystem;
  const stagingPath = await files.createStagingDirectory(options.parentDirectory);
  try {
    await materializeArchive(archive, stagingPath, files);
    return { stagingPath, contentRoot: root ? path.join(stagingPath, root) : stagingPath };
  } catch (error) {
    try {
      await files.removeTree(stagingPath);
    } catch (cleanupError) {
      if (cleanupError instanceof Error) {
        throw new ArchiveValidationError("filesystem", `Failed to clean archive staging directory: ${stagingPath}`, { cause: cleanupError });
      }
      throw cleanupError;
    }
    throw error;
  }
}

async function materializeArchive(archive: SafeZipArchive, stagingPath: string, files: SafeArchiveFileSystem): Promise<void> {
  const directories = new Map<string, readonly string[]>();
  for (const entry of archive.entries) {
    const parentLength = entry.path.directory ? entry.path.segments.length : entry.path.segments.length - 1;
    for (let length = 1; length <= parentLength; length += 1) {
      const segments = entry.path.segments.slice(0, length);
      directories.set(segments.join("/"), segments);
    }
  }
  const ordered = [...directories.values()].sort((left, right) => left.length - right.length || left.join("/").localeCompare(right.join("/")));
  for (const segments of ordered) await files.createDirectory(path.join(stagingPath, ...segments));
  for (const entry of archive.entries) {
    if (!entry.path.directory) await files.writeExclusive(path.join(stagingPath, ...entry.path.segments), entry.content);
  }
}
