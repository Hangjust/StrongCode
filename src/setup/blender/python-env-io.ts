import { createHash } from "node:crypto";
import { cp, lstat, mkdir, opendir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertNoSymlinkPathComponents } from "../../config/save";
import { PythonEnvironmentError, type EnvironmentFileSystem } from "./python-env";

export const nodeEnvironmentFileSystem: EnvironmentFileSystem = {
  async prepare(destination, staging) {
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await assertNoSymlinkPathComponents(destination);
    if (await pathExists(destination)) throw new PythonEnvironmentError(`Runtime destination already exists: ${destination}`);
    const parent = await lstat(path.dirname(staging));
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new PythonEnvironmentError(`Unsafe runtime parent: ${path.dirname(staging)}`);
    await mkdir(staging, { recursive: false, mode: 0o700 });
  },
  async copyDirectory(source, destination) {
    await assertRegularTree(source);
    await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
    await assertRegularTree(destination);
  },
  async write(filePath, content) {
    await writeFile(filePath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  },
  async read(filePath) { return readFile(filePath); },
  async verifyFile(filePath, expectedSha256) {
    await assertNoSymlinkPathComponents(filePath);
    const stats = await lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new PythonEnvironmentError(`Refusing non-regular file: ${filePath}`);
    if (expectedSha256) {
      const actual = createHash("sha256").update(await readFile(filePath)).digest("hex");
      if (actual !== expectedSha256) throw new PythonEnvironmentError(`File changed after selection: ${filePath}`);
    }
  },
  async publish(staging, destination) {
    await assertNoSymlinkPathComponents(destination);
    const stats = await lstat(staging);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new PythonEnvironmentError(`Unsafe staging runtime: ${staging}`);
    if (await pathExists(destination)) throw new PythonEnvironmentError(`Runtime destination already exists: ${destination}`);
    await rename(staging, destination);
  },
  async removeTree(directory) { await rm(directory, { recursive: true, force: true }); }
};

async function assertRegularTree(directoryPath: string): Promise<void> {
  const root = await lstat(directoryPath);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new PythonEnvironmentError(`Unsafe wrapper asset directory: ${directoryPath}`);
  const directory = await opendir(directoryPath);
  for await (const entry of directory) {
    const entryPath = path.join(directoryPath, entry.name);
    const stats = await lstat(entryPath);
    if (stats.isSymbolicLink()) throw new PythonEnvironmentError(`Wrapper assets cannot contain links: ${entryPath}`);
    if (stats.isDirectory()) await assertRegularTree(entryPath);
    else if (!stats.isFile()) throw new PythonEnvironmentError(`Wrapper asset is not a regular file: ${entryPath}`);
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
