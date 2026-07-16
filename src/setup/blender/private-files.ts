import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  BlenderInstallError,
  canonicalTargetPath,
  pathState,
  sha256,
  statesEqual,
  syncDirectory,
  writeDurableFile
} from "./durable-fs";

export type PrivateFileProcessRequest = {
  readonly executable: string;
  readonly args: readonly string[];
  readonly shell: false;
};

export type PrivateFileProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export interface PrivateFileProcessAdapter {
  run(request: PrivateFileProcessRequest): Promise<PrivateFileProcessResult>;
}

export type PrivateFileProtectionOptions = {
  readonly platform?: NodeJS.Platform;
  readonly systemRoot?: string;
  readonly process?: PrivateFileProcessAdapter;
};

const nativeProcess: PrivateFileProcessAdapter = {
  run: request => new Promise((resolve, reject) => {
    execFile(request.executable, [...request.args], {
      shell: false,
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 64 * 1024
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") {
        reject(error);
        return;
      }
      resolve({ exitCode: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
    });
  })
};

function windowsSystemRoot(value: string | undefined): string {
  const candidate = value ?? process.env.SystemRoot ?? "C:\\Windows";
  if (!path.win32.isAbsolute(candidate)) throw new BlenderInstallError("unsafe-path", "Windows system root must be absolute");
  return path.win32.normalize(candidate);
}

function currentSid(output: string): string {
  const match = output.match(/S-\d+(?:-\d+)+/u);
  if (!match) throw new BlenderInstallError("conflict", "whoami did not return a Windows user SID");
  return match[0];
}

async function protectPosix(filePath: string): Promise<void> {
  await chmod(filePath, 0o600);
  const stats = await lstat(filePath);
  const getuid = process.getuid;
  if (!getuid) throw new BlenderInstallError("conflict", "POSIX user ID is unavailable");
  if ((stats.mode & 0o777) !== 0o600 || stats.uid !== getuid()) {
    throw new BlenderInstallError("conflict", `Private file ownership or mode is unsafe: ${filePath}`);
  }
}

async function protectWindows(filePath: string, options: PrivateFileProtectionOptions): Promise<void> {
  if (options.systemRoot !== undefined && options.process === undefined) {
    throw new BlenderInstallError("unsafe-path", "Windows system root override requires an injected process adapter");
  }
  const root = windowsSystemRoot(options.systemRoot);
  const adapter = options.process ?? nativeProcess;
  const whoami = path.win32.join(root, "System32", "whoami.exe");
  const icacls = path.win32.join(root, "System32", "icacls.exe");
  const identity = await adapter.run({ executable: whoami, args: ["/user", "/fo", "csv", "/nh"], shell: false });
  if (identity.exitCode !== 0) throw new BlenderInstallError("conflict", `Unable to identify Windows credential owner: ${identity.stderr.trim()}`);
  const sid = currentSid(identity.stdout);
  const reset = await adapter.run({ executable: icacls, args: [filePath, "/reset"], shell: false });
  if (reset.exitCode !== 0) throw new BlenderInstallError("conflict", `Unable to reset private file ACL: ${reset.stderr.trim()}`);
  const acl = await adapter.run({
    executable: icacls,
    args: [filePath, "/inheritance:r", "/grant:r", `*${sid}:(F)`],
    shell: false
  });
  if (acl.exitCode !== 0) throw new BlenderInstallError("conflict", `Unable to protect private file ACL: ${acl.stderr.trim()}`);
}

export async function protectPrivateFile(filePath: string, options: PrivateFileProtectionOptions = {}): Promise<void> {
  const canonical = await canonicalTargetPath(filePath);
  const state = await pathState(canonical);
  if (state.kind !== "file") throw new BlenderInstallError("unsafe-path", `Private path must be a regular file: ${canonical}`);
  if ((options.platform ?? process.platform) === "win32") await protectWindows(canonical, options);
  else await protectPosix(canonical);
}

export async function writePrivateFile(
  filePath: string,
  content: string | Buffer,
  options: PrivateFileProtectionOptions = {}
): Promise<void> {
  const canonical = await canonicalTargetPath(filePath);
  const existing = await pathState(canonical);
  if (existing.kind !== "absent" && existing.kind !== "file") {
    throw new BlenderInstallError("unsafe-path", `Refusing private-file path type change: ${canonical}`);
  }
  const temporary = path.join(path.dirname(canonical), `.${path.basename(canonical)}.${process.pid}.${randomUUID()}.private.tmp`);
  try {
    await writeDurableFile(temporary, content, 0o600);
    await protectPrivateFile(temporary, options);
    const latest = await pathState(canonical);
    if (latest.kind !== existing.kind || (latest.kind === "file" && existing.kind === "file" && latest.sha256 !== existing.sha256)) {
      throw new BlenderInstallError("conflict", `Private file changed before replacement: ${canonical}`);
    }
    await rename(temporary, canonical);
    await syncDirectory(path.dirname(canonical));
  } finally {
    const temporaryState = await pathState(temporary);
    if (statesEqual(temporaryState, { kind: "file", sha256: sha256(content) })) await rm(temporary, { force: true });
  }
}
