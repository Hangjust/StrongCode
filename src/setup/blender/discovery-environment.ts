import { StrongCodeError } from "../../core/errors";

const DISCOVERY_ENVIRONMENT = [
  "APPDATA",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "ProgramFiles",
  "ProgramW6432",
  "PROGRAMDATA",
  "SystemRoot",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "WINDIR"
] as const;

export function discoveryEnvironment(source: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  if (platform !== "win32") {
    return Object.fromEntries(
      DISCOVERY_ENVIRONMENT.flatMap(name => source[name] === undefined ? [] : [[name, source[name]]])
    );
  }

  const discovered = new Map<string, string>();
  const aliases = new Map<string, string>();
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const canonicalName = DISCOVERY_ENVIRONMENT.find(candidate => candidate.toUpperCase() === name.toUpperCase());
    if (canonicalName === undefined) continue;
    const firstAlias = aliases.get(canonicalName);
    if (firstAlias === undefined) {
      discovered.set(canonicalName, value);
      aliases.set(canonicalName, name);
      continue;
    }
    if (discovered.get(canonicalName) !== value) {
      throw new StrongCodeError(
        "CONFIG_ERROR",
        `Conflicting environment aliases for ${canonicalName}: ${firstAlias} and ${name}`
      );
    }
  }
  return Object.fromEntries(discovered.entries());
}
