import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { StrongCodeError } from "../../core/errors";
import { isSafeAbsoluteWindowsPath } from "../../core/executable";

const HOST_INPUT_LIMIT_BYTES = 1024 * 1024;
const HOST_INPUT_DEADLINE_MS = 10_000;
const POWERSHELL_ARGUMENTS = [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-File"
] as const;

const safeWindowsPathSchema = z.string().min(1).max(32_767).refine(isSafeAbsoluteWindowsPath);
const launchSchema = z.object({
  executable: safeWindowsPathSchema,
  args: z.array(z.string().refine(value => !value.includes("\0"))).max(4096).readonly(),
  cwd: safeWindowsPathSchema,
  env: z.record(
    z.string().min(1).refine(value => !value.includes("\0") && !value.includes("=")),
    z.string().refine(value => !value.includes("\0"))
  )
}).strict().readonly();

export type WindowsJobProcessOptions = z.infer<typeof launchSchema>;

const managedProcesses = new WeakSet<ChildProcess>();
let cachedHostRuntime: {
  readonly powerShell: string;
  readonly system32: string;
  readonly env: Readonly<Record<string, string>>;
} | undefined;

export function spawnWindowsJobProcess(options: WindowsJobProcessOptions): ChildProcess {
  const parsed = launchSchema.safeParse(options);
  if (!parsed.success) throw new StrongCodeError("VALIDATION_ERROR", "Invalid Windows Job host launch specification");
  const payload = Buffer.from(JSON.stringify(parsed.data), "utf8");
  if (payload.length > HOST_INPUT_LIMIT_BYTES) {
    throw new StrongCodeError("VALIDATION_ERROR", `Windows Job host launch specification exceeds ${HOST_INPUT_LIMIT_BYTES} bytes`);
  }

  const hostAsset = path.resolve(__dirname, "..", "..", "..", "assets", "windows-job-host.ps1");
  if (!existsSync(hostAsset)) throw new StrongCodeError("TOOL_ERROR", `Windows Job host asset is missing: ${hostAsset}`);
  const hostRuntime = resolveWindowsHostRuntime();
  const child = spawn(hostRuntime.powerShell, [...POWERSHELL_ARGUMENTS, hostAsset], {
    cwd: hostRuntime.system32,
    env: hostRuntime.env,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  managedProcesses.add(child);

  const inputDeadline = setTimeout(() => {
    child.stdin?.destroy(new StrongCodeError("TOOL_ERROR", "Windows Job host input deadline exceeded"));
    child.kill("SIGKILL");
  }, HOST_INPUT_DEADLINE_MS);
  inputDeadline.unref();
  child.stdin?.once("error", () => {
    clearTimeout(inputDeadline);
    child.kill("SIGKILL");
  });
  child.stdin?.end(payload, () => clearTimeout(inputDeadline));
  return child;
}

export function isManagedWindowsJobProcess(child: ChildProcess): boolean {
  return managedProcesses.has(child);
}

function resolveWindowsHostRuntime(): {
  readonly powerShell: string;
  readonly system32: string;
  readonly env: Readonly<Record<string, string>>;
} {
  if (cachedHostRuntime) return cachedHostRuntime;
  const roots = Object.entries(process.env)
    .filter(([name, value]) => value !== undefined && name.toLowerCase() === "systemroot")
    .map(([, value]) => value)
    .filter((value): value is string => value !== undefined);
  const normalizedRoots = new Set(roots.map(root => path.win32.normalize(root).toLowerCase()));
  if (roots.length === 0 || normalizedRoots.size !== 1 || !path.win32.isAbsolute(roots[0] ?? "")) {
    throw new StrongCodeError("TOOL_ERROR", "A single absolute parent SystemRoot is required for the Windows Job host");
  }
  try {
    const systemRoot = realpathSync(roots[0] ?? "");
    const system32 = realpathSync(path.win32.join(systemRoot, "System32"));
    const powerShell = realpathSync(path.win32.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"));
    const temporaryDirectory = realpathSync(tmpdir());
    if (
      !isSafeAbsoluteWindowsPath(systemRoot)
      || !isSafeAbsoluteWindowsPath(system32)
      || !isSafeAbsoluteWindowsPath(powerShell)
      || !isSafeAbsoluteWindowsPath(temporaryDirectory)
      || !statSync(system32).isDirectory()
      || !statSync(temporaryDirectory).isDirectory()
      || !statSync(powerShell).isFile()
    ) throw new StrongCodeError("TOOL_ERROR", "Windows Job host runtime paths are not trusted absolute paths");
    cachedHostRuntime = {
      powerShell,
      system32,
      env: {
        SystemRoot: systemRoot,
        TEMP: temporaryDirectory,
        TMP: temporaryDirectory
      }
    };
    return cachedHostRuntime;
  } catch (error) {
    if (error instanceof StrongCodeError) throw error;
    if (error instanceof Error) {
      throw new StrongCodeError("TOOL_ERROR", `Unable to resolve the trusted Windows Job host runtime: ${error.message}`);
    }
    throw error;
  }
}
