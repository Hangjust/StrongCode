export function terminalBell(output: NodeJS.WritableStream = process.stdout): void {
  if ((output as NodeJS.WritableStream & { isTTY?: boolean }).isTTY) output.write("\x07");
}
