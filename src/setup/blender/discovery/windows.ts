import path from "node:path";
import { opendir } from "node:fs/promises";
import type { PlatformAssociationAdapter } from "../types";
import { runAssociationCommand, type AssociationCommandOptions } from "./command";

const USER_CHOICE_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.blend\\UserChoice";
const FILE_EXTENSION_KEY = "HKCR\\.blend";
const SAFE_PROG_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REGISTRY_VALUE = /^\s*(?:ProgId|\(Default\)|<NO NAME>)\s+REG_SZ\s+(.+?)\s*$/iu;
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:\\/u;
const BLENDER_INSTALL_DIRECTORY = /^Blender \d+\.\d+(?:\.\d+)?$/u;

export type WindowsInstallEntry = {
  readonly name: string;
  readonly kind: "directory" | "link" | "other";
};

export interface WindowsInstallEnumerator {
  directories(root: string, maximum: number): Promise<readonly WindowsInstallEntry[]>;
}

export const nodeWindowsInstallEnumerator: WindowsInstallEnumerator = {
  async directories(root: string, maximum: number): Promise<readonly WindowsInstallEntry[]> {
    if (maximum < 1) return [];
    try {
      const directory = await opendir(root);
      const entries: WindowsInstallEntry[] = [];
      try {
        for await (const entry of directory) {
          if (entries.length >= maximum) break;
          entries.push({
            name: entry.name,
            kind: entry.isSymbolicLink() ? "link" : entry.isDirectory() ? "directory" : "other"
          });
        }
      } finally {
        await directory.close().catch(error => {
          if (!(error instanceof Error && "code" in error && error.code === "ERR_DIR_CLOSED")) throw error;
        });
      }
      return entries;
    } catch (error) {
      if (error instanceof Error && "code" in error) return [];
      throw error;
    }
  }
};

export function parseWindowsProgId(output: string): string | undefined {
  if (Buffer.byteLength(output, "utf8") > 64 * 1024) return undefined;
  for (const line of output.split(/\r?\n/u)) {
    const value = REGISTRY_VALUE.exec(line)?.[1]?.trim();
    if (!value || !SAFE_PROG_ID.test(value) || value.toLowerCase().startsWith("appx")) continue;
    return value;
  }
  return undefined;
}

export function parseWindowsOpenCommand(output: string): string | undefined {
  if (Buffer.byteLength(output, "utf8") > 64 * 1024) return undefined;
  for (const line of output.split(/\r?\n/u)) {
    const registered = REGISTRY_VALUE.exec(line)?.[1]?.trim();
    if (!registered) continue;
    const match = /^"([^"]+)"(?:\s+(?:"%(?:1|L)"|%(?:1|L)))?$/u.exec(registered);
    const executable = match?.[1];
    if (!executable || !WINDOWS_DRIVE_PATH.test(executable) || !path.win32.isAbsolute(executable)) continue;
    if (/[\u0000-\u001F&|<>^%!`$]/u.test(executable) || executable.split(/[\\/]/u).includes("..")) continue;
    if (/\\Microsoft\\WindowsApps\\/iu.test(executable)) continue;
    if (path.win32.basename(executable).toLowerCase() !== "blender.exe") continue;
    return executable;
  }
  return undefined;
}

function safeSystemRoot(systemRoot: string): boolean {
  return WINDOWS_DRIVE_PATH.test(systemRoot)
    && path.win32.isAbsolute(systemRoot)
    && !/[\u0000-\u001F&|<>^%!`$]/u.test(systemRoot)
    && !systemRoot.split(/[\\/]/u).includes("..");
}

function environmentValue(environment: NodeJS.ProcessEnv, key: string): string | undefined {
  const match = Object.keys(environment).find(candidate => candidate.toUpperCase() === key.toUpperCase());
  return match ? environment[match] : undefined;
}

function safeInstallRoot(root: string): boolean {
  return WINDOWS_DRIVE_PATH.test(root)
    && path.win32.isAbsolute(root)
    && !/[\u0000-\u001F&|<>^%!`$]/u.test(root)
    && !root.split(/[\\/]/u).includes("..");
}

async function standardInstallCandidates(
  options: AssociationCommandOptions & { readonly installEnumerator?: WindowsInstallEnumerator }
): Promise<readonly string[]> {
  const programFiles = environmentValue(options.env, "ProgramFiles");
  const programW6432 = environmentValue(options.env, "ProgramW6432");
  const localAppData = environmentValue(options.env, "LOCALAPPDATA");
  const roots = [...new Map([
    programFiles ? path.win32.join(programFiles, "Blender Foundation") : undefined,
    programW6432 ? path.win32.join(programW6432, "Blender Foundation") : undefined,
    localAppData ? path.win32.join(localAppData, "Programs", "Blender Foundation") : undefined
  ].filter((root): root is string => root !== undefined && safeInstallRoot(root))
    .map(root => [root.toLowerCase(), root])).values()];
  const enumerator = options.installEnumerator ?? nodeWindowsInstallEnumerator;
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const entries = await enumerator.directories(root, options.maxCandidates);
    for (const entry of entries.slice(0, options.maxCandidates)) {
      if (candidates.length >= options.maxCandidates) return candidates;
      if (entry.kind !== "directory" || !BLENDER_INSTALL_DIRECTORY.test(entry.name)) continue;
      const executable = path.win32.join(root, entry.name, "blender.exe");
      const key = executable.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(executable);
    }
  }
  return candidates;
}

export function createWindowsAssociationAdapter(
  options: AssociationCommandOptions & {
    readonly systemRoot: string;
    readonly installEnumerator?: WindowsInstallEnumerator;
  }
): PlatformAssociationAdapter {
  return {
    async blenderExecutables(): Promise<readonly string[]> {
      if (!safeSystemRoot(options.systemRoot)) return [];
      const registry = path.win32.join(options.systemRoot, "System32", "reg.exe");
      const userChoice = await runAssociationCommand(options, registry, ["query", USER_CHOICE_KEY, "/v", "ProgId"]);
      const extension = userChoice ? undefined : await runAssociationCommand(options, registry, ["query", FILE_EXTENSION_KEY, "/ve"]);
      const progId = parseWindowsProgId(userChoice ?? extension ?? "");
      const registered = progId
        ? parseWindowsOpenCommand(await runAssociationCommand(
          options,
          registry,
          ["query", `HKCR\\${progId}\\shell\\open\\command`, "/ve"]
        ) ?? "")
        : undefined;
      const candidates = [
        ...(registered ? [registered] : []),
        ...await standardInstallCandidates(options)
      ];
      return [...new Map(candidates.slice(0, options.maxCandidates).map(candidate => [candidate.toLowerCase(), candidate])).values()];
    }
  };
}
