import path from "node:path";
import type { PlatformAssociationAdapter } from "../types";
import { runAssociationCommand, type AssociationCommandOptions } from "./command";

const MDFIND = "/usr/bin/mdfind";
const BLENDER_BUNDLE_QUERY = "kMDItemCFBundleIdentifier == 'org.blenderfoundation.blender'";
const SAFE_BUNDLE_NAME = /^Blender(?: [A-Za-z0-9._+-]+)?\.app$/iu;

export function parseMacosMetadataApplications(output: string, maxCandidates: number): readonly string[] {
  if (Buffer.byteLength(output, "utf8") > 64 * 1024 || maxCandidates < 1) return [];
  const candidates: string[] = [];
  for (const rawLine of output.split(/\r?\n/u)) {
    if (candidates.length >= maxCandidates) break;
    const bundle = rawLine.trim();
    if (!bundle || bundle.length > 4096 || !path.posix.isAbsolute(bundle)) continue;
    if (/[\u0000-\u001F\u007F]/u.test(bundle) || bundle.split("/").includes("..")) continue;
    if (!SAFE_BUNDLE_NAME.test(path.posix.basename(bundle))) continue;
    candidates.push(path.posix.join(bundle, "Contents", "MacOS", "Blender"));
  }
  return [...new Set(candidates)];
}

export function createMacosAssociationAdapter(options: AssociationCommandOptions): PlatformAssociationAdapter {
  return {
    async blenderExecutables(): Promise<readonly string[]> {
      const output = await runAssociationCommand(options, MDFIND, [BLENDER_BUNDLE_QUERY]);
      return parseMacosMetadataApplications(output ?? "", options.maxCandidates);
    }
  };
}
