import { spawn } from "node:child_process";
import os from "node:os";
import { buildDelegatedProcessEnv } from "../../models/delegated-environment";
import { prepareDelegatedSpawn, resolveDelegatedExecutable } from "../../models/delegated-executable";

function osc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
}

function commandForPlatform(): { command: string; args: string[] } | undefined {
  if (process.platform === "win32") return { command: "clip.exe", args: [] };
  if (process.platform === "darwin") return { command: "pbcopy", args: [] };
  return { command: "xclip", args: ["-selection", "clipboard"] };
}

export async function writeClipboard(text: string, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  if ((output as NodeJS.WritableStream & { isTTY?: boolean }).isTTY) output.write(osc52(text));
  const command = commandForPlatform();
  if (!command) return;
  const env = buildDelegatedProcessEnv();
  const cwd = os.tmpdir();
  let resolvedCommand;
  try {
    resolvedCommand = await resolveDelegatedExecutable(command.command, { env, cwd });
  } catch {
    return;
  }
  const launch = prepareDelegatedSpawn(resolvedCommand, command.args);
  await new Promise<void>(resolve => {
    const child = spawn(launch.executable, launch.args, {
      cwd,
      env: launch.env,
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
      shell: false,
      windowsVerbatimArguments: launch.windowsVerbatimArguments
    });
    child.on("error", () => resolve());
    child.on("exit", () => resolve());
    child.stdin.end(text);
  });
}
