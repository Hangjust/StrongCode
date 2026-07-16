import { spawn, type ChildProcess } from "node:child_process";
import { access, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const roots = new Set<string>();
const processes = new Set<ChildProcess>();

export type ProcessOutcome = {
  readonly code: number | null;
  readonly stderr: Buffer;
  readonly stdout: Buffer;
};

export async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "strongcode-windows-job-host-"));
  roots.add(root);
  return root;
}

export function trackProcess(child: ChildProcess): ChildProcess {
  processes.add(child);
  return child;
}

export function waitForClose(child: ChildProcess, deadlineMs = 10_000): Promise<ProcessOutcome> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Process close deadline exceeded")), deadlineMs);
    child.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", code => {
      clearTimeout(timer);
      resolve({ code, stderr: Buffer.concat(stderr), stdout: Buffer.concat(stdout) });
    });
  });
}

export async function waitForFile(filename: string, deadlineMs = 10_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      await access(filename);
      return;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${filename}`);
}

export function powerShellPath(): string {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new Error("SystemRoot is required for Windows host tests");
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function nodeEnvironment(): Readonly<Record<string, string>> {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new Error("SystemRoot is required for Node process fixtures");
  return { SystemRoot: systemRoot };
}

export function windowsJobHostAsset(): string {
  return path.resolve(__dirname, "..", "assets", "windows-job-host.ps1");
}

export function spawnRawHost(payload: Buffer): ChildProcess {
  const child = spawn(powerShellPath(), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", windowsJobHostAsset()
  ], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  trackProcess(child);
  child.stdin?.end(payload);
  return child;
}

export async function unsafeLaunchSpecification(
  kind: "relative-executable" | "relative-cwd" | "device-executable" | "control-cwd",
  root: string,
  target: string
): Promise<{
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}> {
  if (kind === "relative-executable") {
    const executable = process.platform === "win32" ? "relative-node.exe" : "relative-node";
    await copyFile(process.execPath, path.join(root, executable));
    return { executable, args: [target], cwd: root, env: nodeEnvironment() };
  }
  if (kind === "relative-cwd") {
    return { executable: process.execPath, args: [target], cwd: ".", env: nodeEnvironment() };
  }
  if (kind === "device-executable") {
    return { executable: `\\\\.\\${process.execPath}`, args: [target], cwd: root, env: nodeEnvironment() };
  }
  return { executable: process.execPath, args: [target], cwd: `${root}\ncontrolled`, env: nodeEnvironment() };
}

export async function cleanupWindowsJobFixtures(): Promise<void> {
  await Promise.all([...processes].map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGKILL");
    await waitForClose(child, 2_000);
  }));
  processes.clear();
  await Promise.all([...roots].map(root => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 20
  })));
  roots.clear();
}
