import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { PlatformAssociationAdapter } from "../types";
import { runAssociationCommand, type AssociationCommandOptions } from "./command";

const XDG_MIME = "/usr/bin/xdg-mime";
const MAX_DESKTOP_FILE_BYTES = 64 * 1024;
const SAFE_DESKTOP_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}\.desktop$/u;

export function parseLinuxDesktopId(output: string): string | undefined {
  if (Buffer.byteLength(output, "utf8") > 4096) return undefined;
  const lines = output.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  return lines.length === 1 && SAFE_DESKTOP_ID.test(lines[0] ?? "") ? lines[0] : undefined;
}

export function parseLinuxDesktopExec(command: string): string | undefined {
  if (command.length === 0 || command.length > 4096 || /[\u0000-\u001F;&|<>`$]/u.test(command)) return undefined;
  const match = command.startsWith('"')
    ? /^"([^"]+)"(?:\s+(%[fFuU]))?$/u.exec(command)
    : /^(\S+)(?:\s+(%[fFuU]))?$/u.exec(command);
  const executable = match?.[1];
  if (!executable || !path.posix.isAbsolute(executable)) return undefined;
  if (executable.split("/").includes("..") || path.posix.basename(executable).toLowerCase() !== "blender") return undefined;
  return executable;
}

function desktopExec(source: string): string | undefined {
  let inDesktopEntry = false;
  for (const line of source.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inDesktopEntry = trimmed === "[Desktop Entry]";
      continue;
    }
    if (inDesktopEntry && trimmed.startsWith("Exec=")) return parseLinuxDesktopExec(trimmed.slice("Exec=".length));
  }
  return undefined;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function readDesktopCandidate(root: string, desktopId: string, workspace: string): Promise<string | undefined> {
  try {
    const canonicalRoot = await realpath(root);
    if (isInside(workspace, canonicalRoot)) return undefined;
    const candidate = path.join(canonicalRoot, desktopId);
    const metadata = await lstat(candidate);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_DESKTOP_FILE_BYTES) return undefined;
    const canonicalCandidate = await realpath(candidate);
    if (!isInside(canonicalRoot, canonicalCandidate)) return undefined;
    return desktopExec(await readFile(canonicalCandidate, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error) return undefined;
    throw error;
  }
}

export function linuxApplicationRoots(environment: NodeJS.ProcessEnv): readonly string[] {
  const roots: string[] = [];
  const home = environment.HOME;
  const dataHome = environment.XDG_DATA_HOME;
  if (dataHome && path.isAbsolute(dataHome)) roots.push(path.join(dataHome, "applications"));
  else if (home && path.isAbsolute(home)) roots.push(path.join(home, ".local", "share", "applications"));
  roots.push("/usr/local/share/applications", "/usr/share/applications");
  return [...new Set(roots)];
}

export function createLinuxAssociationAdapter(
  options: AssociationCommandOptions & { readonly applicationRoots: readonly string[] }
): PlatformAssociationAdapter {
  return {
    async blenderExecutables(): Promise<readonly string[]> {
      const output = await runAssociationCommand(options, XDG_MIME, ["query", "default", "application/x-blender"]);
      const desktopId = parseLinuxDesktopId(output ?? "");
      if (!desktopId) return [];
      let workspace: string;
      try {
        workspace = await realpath(options.cwd);
      } catch (error) {
        if (error instanceof Error && "code" in error) return [];
        throw error;
      }
      for (const root of options.applicationRoots.slice(0, options.maxCandidates)) {
        const executable = await readDesktopCandidate(root, desktopId, workspace);
        if (executable) return [executable];
      }
      return [];
    }
  };
}
