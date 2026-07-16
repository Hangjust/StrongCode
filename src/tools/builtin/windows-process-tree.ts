import type { ChildProcess } from "node:child_process";
import { StrongCodeError } from "../../core/errors";
import { isManagedWindowsJobProcess } from "./windows-job-process";

export async function terminateWindowsProcessTree(child: ChildProcess, processId: number): Promise<void> {
  if (!isManagedWindowsJobProcess(child)) {
    throw new StrongCodeError("TOOL_ERROR", `Refusing to terminate unmanaged Windows process ${processId}`);
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  const terminated = child.kill("SIGKILL");
  if (!terminated && child.exitCode === null && child.signalCode === null) {
    throw new StrongCodeError("TOOL_ERROR", `Unable to terminate managed Windows Job host ${processId}`);
  }
}
