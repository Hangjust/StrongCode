import path from "node:path";
import { StrongCodeError } from "../core/errors";
import {
  environmentValue,
  resolveDelegatedExecutableTarget,
  setEnvironmentValue,
  trustedExecutableCandidate,
  type TrustedExecutableOptions
} from "../core/executable";

export type ResolveDelegatedExecutableOptions = TrustedExecutableOptions;

export interface ResolvedDelegatedExecutable {
  executable: string;
  /** The already-resolved command shim that must be invoked through cmd.exe. */
  windowsCommandShim?: string;
  /** Delegated environment with PATH reduced to the same trusted directories used for resolution. */
  env: NodeJS.ProcessEnv;
}

export interface DelegatedSpawnInvocation {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Required only for the fully encoded cmd.exe command line built below. */
  windowsVerbatimArguments: boolean;
}

const WINDOWS_SHIM_ENV_PREFIX = "STRONGCODE_DELEGATED_CMD_";
const WINDOWS_SHIM_ENV = `${WINDOWS_SHIM_ENV_PREFIX}SHIM`;
const MAX_DELEGATED_ARGUMENTS = 128;
const MAX_DELEGATED_ARGUMENT_LENGTH = 512;
const MAX_DELEGATED_ARGUMENT_BYTES = 16 * 1024;
const SAFE_WINDOWS_SHIM_ARGUMENT = /^[A-Za-z0-9._:/=-]+$/;

async function resolvedLauncher(
  executable: string,
  environment: NodeJS.ProcessEnv,
  excludedRoots: readonly string[],
  allowedRoots: readonly string[] = []
): Promise<Pick<ResolvedDelegatedExecutable, "executable" | "windowsCommandShim">> {
  const extension = path.extname(executable).toLowerCase();
  if (process.platform !== "win32" || (extension !== ".cmd" && extension !== ".bat")) {
    return { executable };
  }

  const systemRoot = environmentValue(environment, "SYSTEMROOT");
  if (!systemRoot || !path.isAbsolute(systemRoot)) {
    throw new StrongCodeError("CONFIG_ERROR", "An absolute SYSTEMROOT is required to launch delegated Windows command shims");
  }
  // Do not trust a caller-controlled COMSPEC path. Pin the command processor to
  // the operating-system location and overwrite COMSPEC in the delegated env.
  const commandProcessor = path.join(systemRoot, "System32", "cmd.exe");
  const resolvedCommandProcessor = await trustedExecutableCandidate(commandProcessor, excludedRoots, allowedRoots);
  if (!resolvedCommandProcessor) {
    throw new StrongCodeError("CONFIG_ERROR", `The system command processor is not a trusted executable outside the workspace: ${commandProcessor}`);
  }
  setEnvironmentValue(environment, "COMSPEC", resolvedCommandProcessor);
  return {
    executable: resolvedCommandProcessor,
    windowsCommandShim: executable
  };
}

function assertWindowsShimValue(value: string, label: string): void {
  // Values are expanded inside a quoted cmd.exe command. Quotes or line breaks
  // could terminate that boundary; NUL cannot be represented in an env value.
  if (/["\r\n\0]/u.test(value)) {
    throw new StrongCodeError("CONFIG_ERROR", `${label} contains characters that cannot be passed safely to a Windows command shim`);
  }
}

/**
 * Build the exact spawn boundary for an already-resolved delegated executable.
 *
 * Windows .cmd/.bat files cannot be passed directly to spawn with shell:false.
 * Putting raw arguments after `cmd /c` is also unsafe: spaces break normal shim
 * locations and command metacharacters become executable syntax. Instead, the
 * shim path is carried in a private environment variable and caller arguments
 * are restricted to the token grammar these official CLIs currently require.
 * Delayed expansion is disabled, and windowsVerbatimArguments keeps Node from
 * adding backslash quote escapes that cmd.exe does not understand.
 */
export function prepareDelegatedSpawn(
  resolved: ResolvedDelegatedExecutable,
  args: readonly string[]
): DelegatedSpawnInvocation {
  if (!resolved.windowsCommandShim) {
    return {
      executable: resolved.executable,
      args: [...args],
      env: resolved.env,
      windowsVerbatimArguments: false
    };
  }
  if (process.platform !== "win32") {
    throw new StrongCodeError("CONFIG_ERROR", "Windows command shim metadata is invalid on this platform");
  }
  if (args.length > MAX_DELEGATED_ARGUMENTS) {
    throw new StrongCodeError("CONFIG_ERROR", `Delegated command exceeds the ${MAX_DELEGATED_ARGUMENTS} argument safety limit`);
  }
  if (args.reduce((total, argument) => total + Buffer.byteLength(argument, "utf8"), 0) > MAX_DELEGATED_ARGUMENT_BYTES) {
    throw new StrongCodeError("CONFIG_ERROR", `Delegated command exceeds the ${MAX_DELEGATED_ARGUMENT_BYTES} byte argument safety limit`);
  }

  assertWindowsShimValue(resolved.windowsCommandShim, "Delegated command shim path");
  const environment = { ...resolved.env };
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase().startsWith(WINDOWS_SHIM_ENV_PREFIX)) delete environment[key];
  }
  setEnvironmentValue(environment, WINDOWS_SHIM_ENV, resolved.windowsCommandShim);

  const safeArguments = args.map((argument, index) => {
    if (
      argument.length === 0
      || argument.length > MAX_DELEGATED_ARGUMENT_LENGTH
      || !SAFE_WINDOWS_SHIM_ARGUMENT.test(argument)
    ) {
      throw new StrongCodeError(
        "CONFIG_ERROR",
        `Delegated argument ${index + 1} cannot be passed safely to a Windows command shim`
      );
    }
    return argument;
  });
  const command = [`"%${WINDOWS_SHIM_ENV}%"`, ...safeArguments].join(" ");

  return {
    executable: resolved.executable,
    args: ["/d", "/s", "/v:off", "/c", `"${command}"`],
    env: environment,
    windowsVerbatimArguments: true
  };
}

/** Resolve a delegated credential-bearing CLI without allowing current-directory lookup. */
export async function resolveDelegatedExecutable(
  commandName: string,
  options: ResolveDelegatedExecutableOptions = {}
): Promise<ResolvedDelegatedExecutable> {
  const resolved = await resolveDelegatedExecutableTarget(commandName, options);
  return {
    ...await resolvedLauncher(resolved.executable, resolved.env, resolved.excludedRoots, resolved.allowedRoots),
    env: resolved.env
  };
}
