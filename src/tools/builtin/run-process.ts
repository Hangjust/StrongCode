import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { StrongCodeError } from "../../core/errors";
import { err, ok, type Result } from "../../core/result";
import type { ToolResult } from "../tool";
import { spawnWindowsJobProcess } from "./windows-job-process";
import { terminateWindowsProcessTree } from "./windows-process-tree";

const PROCESS_KILL_GRACE_MS = 200;
const PROCESS_CLOSE_DEADLINE_MS = 2_000;

export interface ProcessOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}

export type ContainedProcessOptions = {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
};

type StopReason =
  | { readonly kind: "cancelled" }
  | { readonly kind: "timeout" };

export function spawnContainedProcess(options: ContainedProcessOptions): ChildProcess {
  if (!path.isAbsolute(options.executable) || !path.isAbsolute(options.cwd)) {
    throw new StrongCodeError("VALIDATION_ERROR", "Contained process executable and cwd must be absolute paths");
  }
  if (process.platform === "win32") {
    const env = Object.fromEntries(
      Object.entries(options.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
    );
    return spawnWindowsJobProcess({
      executable: options.executable,
      args: options.args,
      cwd: options.cwd,
      env
    });
  }
  return spawn(options.executable, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

export function waitForChildClose(closed: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (didClose: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(didClose);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    void closed.then(() => finish(true));
  });
}

function signalPosixProcessTree(child: ChildProcess, processId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processId, signal);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
}

function posixProcessGroupExists(processId: number): boolean {
  try {
    process.kill(-processId, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForPosixProcessGroupExit(processId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (posixProcessGroupExists(processId)) {
    if (Date.now() >= deadline) return false;
    await delay(10);
  }
  return true;
}

export async function terminateProcessTree(child: ChildProcess): Promise<void> {
  const processId = child.pid;
  if (!processId) return;
  const rootAlreadyExited = child.exitCode !== null || child.signalCode !== null;
  const closed = rootAlreadyExited
    ? Promise.resolve()
    : new Promise<void>(resolve => child.once("close", () => resolve()));
  if (process.platform === "win32") {
    await terminateWindowsProcessTree(child, processId);
  } else {
    signalPosixProcessTree(child, processId, "SIGTERM");
    await delay(PROCESS_KILL_GRACE_MS);
    signalPosixProcessTree(child, processId, "SIGKILL");
    if (!await waitForPosixProcessGroupExit(processId, PROCESS_CLOSE_DEADLINE_MS)) {
      throw new StrongCodeError("TOOL_ERROR", `Process group ${processId} survived tree termination`);
    }
  }
  if (await waitForChildClose(closed, PROCESS_CLOSE_DEADLINE_MS)) return;
  throw new StrongCodeError("TOOL_ERROR", `Process ${processId} did not close after tree termination`);
}

function stoppedResult(options: ProcessOptions, reason: StopReason): Result<ToolResult> {
  if (reason.kind === "cancelled") {
    return err(new StrongCodeError("CANCELLED", `Process '${options.command}' was cancelled`));
  }
  return err(new StrongCodeError("TOOL_ERROR", `${options.command} timed out after ${options.timeoutMs}ms`));
}

export async function runProcess(options: ProcessOptions): Promise<Result<ToolResult>> {
  if (options.signal?.aborted) return stoppedResult(options, { kind: "cancelled" });
  return new Promise(resolve => {
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let truncated = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let stopReason: StopReason | undefined;
    let child: ChildProcess;
    try {
      child = spawnContainedProcess({
        executable: options.command,
        args: options.args,
        cwd: options.cwd,
        env: options.env ?? process.env,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      resolve(err(new StrongCodeError("TOOL_ERROR", `Unable to run '${options.command}': ${message}`)));
      return;
    }
    const onAbort = () => requestStop({ kind: "cancelled" });
    const finish = (result: Result<ToolResult>) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const requestStop = (reason: StopReason) => {
      if (stopReason || settled) return;
      stopReason = reason;
      void terminateProcessTree(child).then(
        () => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish(stoppedResult(options, reason));
        },
        error => {
          const message = error instanceof Error ? error.message : String(error);
          finish(err(new StrongCodeError("TOOL_ERROR", `Unable to terminate '${options.command}': ${message}`)));
        }
      );
    };
    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
      const remaining = Math.max(0, options.maxOutputBytes - current.length);
      if (chunk.length > remaining) truncated = true;
      return remaining > 0 ? Buffer.concat([current, chunk.subarray(0, remaining)]) : current;
    };
    child.stdout?.on("data", chunk => { stdout = append(stdout, Buffer.from(chunk)); });
    child.stderr?.on("data", chunk => { stderr = append(stderr, Buffer.from(chunk)); });
    child.once("error", error => {
      if (!stopReason) finish(err(new StrongCodeError("TOOL_ERROR", `Unable to run '${options.command}': ${error.message}`)));
    });
    child.once("close", (code, signal) => {
      if (stopReason) return;
      const output = [
        stdout.toString("utf8").trimEnd(),
        stderr.length > 0 ? `stderr:\n${stderr.toString("utf8").trimEnd()}` : "",
        truncated ? `[output truncated at ${options.maxOutputBytes} bytes]` : ""
      ].filter(Boolean).join("\n");
      if (code === 0) finish(ok({ content: output }));
      else finish(err(new StrongCodeError("TOOL_ERROR", `${options.command} exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}${output ? `\n${output}` : ""}`)));
    });
    timer = setTimeout(() => requestStop({ kind: "timeout" }), options.timeoutMs);
    timer.unref();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}
