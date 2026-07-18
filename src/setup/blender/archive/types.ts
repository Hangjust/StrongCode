export type ZipMethod = 0 | 8;

export type ArchivePath = {
  readonly value: string;
  readonly segments: readonly string[];
  readonly collisionKey: string;
  readonly directory: boolean;
};

export type SafeZipEntry = {
  readonly path: ArchivePath;
  readonly content: Buffer;
  readonly method: ZipMethod;
  readonly crc32: number;
};

export type SafeZipArchive = {
  readonly entries: readonly SafeZipEntry[];
};

export type RequiredArchiveManifest = "blender_manifest.toml" | "pyproject.toml";

export interface SafeArchiveFileSystem {
  createStagingDirectory(parentDirectory: string): Promise<string>;
  createDirectory(directoryPath: string): Promise<void>;
  writeExclusive(filePath: string, content: Buffer): Promise<void>;
  removeTree(filePath: string): Promise<void>;
}
