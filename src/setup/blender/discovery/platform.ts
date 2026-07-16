import type { PlatformAssociationAdapter, ProbeProcessAdapter } from "../types";
import { linuxApplicationRoots, createLinuxAssociationAdapter } from "./linux";
import { createMacosAssociationAdapter } from "./macos";
import { createWindowsAssociationAdapter } from "./windows";

export type PlatformAssociationOptions = {
  readonly platform: NodeJS.Platform;
  readonly runner: ProbeProcessAdapter;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxCandidates: number;
  readonly systemRoot?: string;
};

const noAssociations: PlatformAssociationAdapter = {
  async blenderExecutables(): Promise<readonly string[]> {
    return [];
  }
};

function environmentValue(environment: NodeJS.ProcessEnv, key: string): string | undefined {
  const match = Object.keys(environment).find(candidate => candidate.toUpperCase() === key.toUpperCase());
  return match ? environment[match] : undefined;
}

export function createPlatformAssociationAdapter(options: PlatformAssociationOptions): PlatformAssociationAdapter {
  switch (options.platform) {
    case "win32": {
      const systemRoot = options.systemRoot
        ?? (process.platform === "win32" ? environmentValue(process.env, "SYSTEMROOT") : undefined);
      return systemRoot ? createWindowsAssociationAdapter({ ...options, systemRoot }) : noAssociations;
    }
    case "darwin":
      return createMacosAssociationAdapter(options);
    case "linux":
      return createLinuxAssociationAdapter({ ...options, applicationRoots: linuxApplicationRoots(options.env) });
    default:
      return noAssociations;
  }
}
