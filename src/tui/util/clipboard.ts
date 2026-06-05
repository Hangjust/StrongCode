import { spawn } from "node:child_process";

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
  await new Promise<void>(resolve => {
    const child = spawn(command.command, command.args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => resolve());
    child.on("exit", () => resolve());
    child.stdin.end(text);
  });
}
