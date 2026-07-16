import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import type { ArtifactProvenance } from "./artifact-manifest";
import {
  BlenderInstallError,
  copyPathDurable,
  isNodeError,
  pathState,
  sha256
} from "./durable-fs";
import type { PathState } from "./journal-schema";

const ADDON_DERIVATIVE_PREFIX = "addon/strongcode_blender_mcp/";
const WRAPPER_DERIVATIVE_PREFIX = "runtime-wrapper/";

export interface BlenderInstallerFileSystem {
  createTemporaryDirectory(homePath: string): Promise<string>;
  ensureParentDirectories(filePaths: readonly string[]): Promise<readonly string[]>;
  copyFileIfPresent(sourcePath: string, destinationPath: string): Promise<boolean>;
  copyDirectory(sourcePath: string, destinationPath: string): Promise<void>;
  readFile(filePath: string): Promise<Buffer>;
  state(filePath: string): Promise<PathState>;
  verifyFile(filePath: string, expectedSha256: string): Promise<void>;
  listRegularFiles(directoryPath: string): Promise<readonly string[]>;
  removeTree(filePath: string): Promise<void>;
  removeEmptyDirectories(directoryPaths: readonly string[]): Promise<void>;
}

export const nodeBlenderInstallerFileSystem: BlenderInstallerFileSystem = {
  async createTemporaryDirectory(homePath) {
    const resolved = path.resolve(homePath);
    const stats = await lstat(resolved);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new BlenderInstallError("unsafe-path", `StrongCode home must be a real directory: ${resolved}`);
    }
    return mkdtemp(path.join(resolved, ".blender-install-"));
  },
  async ensureParentDirectories(filePaths) {
    const created: string[] = [];
    for (const filePath of filePaths) {
      const resolved = path.resolve(path.dirname(filePath));
      const root = path.parse(resolved).root;
      let current = root;
      for (const segment of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        try {
          const stats = await lstat(current);
          if (stats.isSymbolicLink() || !stats.isDirectory()) {
            throw new BlenderInstallError("unsafe-path", `Managed target parent is unsafe: ${current}`);
          }
        } catch (error) {
          if (!isNodeError(error, "ENOENT")) throw error;
          await mkdir(current, { mode: 0o700 });
          created.push(current);
        }
      }
    }
    return created;
  },
  async copyFileIfPresent(sourcePath, destinationPath) {
    const source = await pathState(sourcePath);
    if (source.kind === "absent") return false;
    if (source.kind !== "file") throw new BlenderInstallError("unsafe-path", `Expected a regular file: ${sourcePath}`);
    await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL);
    return true;
  },
  async copyDirectory(sourcePath, destinationPath) {
    const copied = await copyPathDurable(sourcePath, destinationPath);
    if (copied.kind !== "directory") throw new BlenderInstallError("unsafe-path", `Expected an addon directory: ${sourcePath}`);
  },
  readFile,
  state: pathState,
  async verifyFile(filePath, expectedSha256) {
    const state = await pathState(filePath);
    if (state.kind !== "file") throw new BlenderInstallError("unsafe-path", `Expected a regular executable: ${filePath}`);
    if (state.sha256 !== expectedSha256) throw new BlenderInstallError("conflict", `Executable changed after selection: ${filePath}`);
  },
  async listRegularFiles(directoryPath) {
    const files: string[] = [];
    const visit = async (current: string, relative: string): Promise<void> => {
      const stats = await lstat(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new BlenderInstallError("unsafe-path", `Addon asset path is unsafe: ${current}`);
      }
      for (const name of (await readdir(current)).sort()) {
        const child = path.join(current, name);
        const childStats = await lstat(child);
        if (childStats.isSymbolicLink()) throw new BlenderInstallError("unsafe-path", `Addon assets cannot contain links: ${child}`);
        const childRelative = relative ? `${relative}/${name}` : name;
        if (childStats.isDirectory()) await visit(child, childRelative);
        else if (childStats.isFile()) files.push(childRelative);
        else throw new BlenderInstallError("unsafe-path", `Addon asset is not a regular file: ${child}`);
      }
    };
    await visit(directoryPath, "");
    return files;
  },
  async removeTree(filePath) {
    await rm(filePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  },
  async removeEmptyDirectories(directoryPaths) {
    for (const directoryPath of [...directoryPaths].reverse()) {
      try {
        await rmdir(directoryPath);
      } catch (error) {
        if (!isNodeError(error, "ENOENT") && !isNodeError(error, "ENOTEMPTY") && !isNodeError(error, "EEXIST")) throw error;
      }
    }
  }
};

export async function verifyDerivativeAddonAssets(options: {
  readonly addonAssetsPath: string;
  readonly provenance: ArtifactProvenance;
  readonly files: BlenderInstallerFileSystem;
}): Promise<void> {
  const derivatives = options.provenance.derivatives
    .filter(item => item.path.startsWith(ADDON_DERIVATIVE_PREFIX))
    .map(item => ({ ...item, relativePath: item.path.slice(ADDON_DERIVATIVE_PREFIX.length) }));
  await verifyDerivativeTree({ rootPath: options.addonAssetsPath, derivatives, files: options.files, name: "addon" });
}

export async function verifyDerivativeWrapperAssets(options: {
  readonly wrapperAssetsPath: string;
  readonly provenance: ArtifactProvenance;
  readonly files: BlenderInstallerFileSystem;
}): Promise<void> {
  const derivatives = options.provenance.derivatives
    .filter(item => item.path.startsWith(WRAPPER_DERIVATIVE_PREFIX))
    .map(item => ({ ...item, relativePath: item.path.slice(WRAPPER_DERIVATIVE_PREFIX.length) }));
  await verifyDerivativeTree({ rootPath: options.wrapperAssetsPath, derivatives, files: options.files, name: "wrapper" });
}

async function verifyDerivativeTree(options: {
  readonly rootPath: string;
  readonly derivatives: readonly { readonly path: string; readonly relativePath: string; readonly sha256: string }[];
  readonly files: BlenderInstallerFileSystem;
  readonly name: string;
}): Promise<void> {
  if (options.derivatives.length === 0) {
    throw new BlenderInstallError("conflict", `${options.name} provenance contains no StrongCode derivative assets`);
  }
  const actual = await options.files.listRegularFiles(options.rootPath);
  const expected = options.derivatives.map(item => item.relativePath).sort();
  if (actual.join("\n") !== expected.join("\n")) {
    throw new BlenderInstallError("conflict", `Derivative ${options.name} files do not exactly match locked provenance`);
  }
  for (const derivative of options.derivatives) {
    const content = await options.files.readFile(path.join(options.rootPath, ...derivative.relativePath.split("/")));
    if (sha256(content) !== derivative.sha256) {
      throw new BlenderInstallError("conflict", `Derivative ${options.name} hash mismatch: ${derivative.path}`);
    }
  }
}
