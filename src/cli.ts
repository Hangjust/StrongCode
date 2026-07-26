#!/usr/bin/env node
import path from "node:path";
import { createProgram } from "./cli/program";
import type { CliDependencies } from "./cli/types";
import { enforceHomeCacheRetention } from "./config/cache-retention";
import { ensureStrongCodeHome } from "./config/home";
import { resolveStrongCodeHome } from "./config/paths";
import { StrongCodeError } from "./core/errors";
import { sanitizeTerminalLine } from "./core/terminal-text";
import { runBlenderSetupFlow } from "./setup/blender/runner";
import { loadSetupState } from "./setup/state";
import { BLENDER_OFFER_VERSION } from "./setup/types";
import { runSetup, shouldRunFirstSetup } from "./setup/wizard";
import { runTui } from "./tui/app";

export { createProgram };
export type { CliDependencies };

function printError(error: StrongCodeError): void {
  console.error(`${error.code}: ${sanitizeTerminalLine(error.message)}`);
}

function hasNonInteractiveBlenderSetupGuard(argv: string[], interactive: boolean): boolean {
  if (interactive) return false;

  let command: "setup" | "install" | undefined;
  let hasBlenderFlag = false;

  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--" || argument === "--help" || argument === "-h") {
      return false;
    }

    if (argument.startsWith("-")) {
      if (command === undefined) {
        return false;
      }
      if (argument === "--blender") {
        hasBlenderFlag = true;
        continue;
      }
      if (argument === "--force") {
        continue;
      }
      return false;
    }

    if (argument === "setup" || argument === "install") {
      if (command !== undefined) {
        return false;
      }
      command = argument;
      continue;
    }

    if (command === undefined) {
      return false;
    }

    return false;
  }

  return command !== undefined && hasBlenderFlag;
}

export async function main(argv: string[], dependencies: CliDependencies = {}): Promise<void> {
  try {
    if (process.env.STRONGCODE_TUI_BUN === "1" && process.env.STRONGCODE_TUI_PROJECT_CWD) {
      const projectCwd = process.env.STRONGCODE_TUI_PROJECT_CWD;
      delete process.env.STRONGCODE_TUI_PROJECT_CWD;
      if (!path.isAbsolute(projectCwd)) throw new StrongCodeError("CONFIG_ERROR", "StrongCode TUI project directory must be absolute");
      process.chdir(projectCwd);
    }

    const homePath = path.resolve(dependencies.homePath ?? resolveStrongCodeHome());
    const interactive = dependencies.isInteractive?.() ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);

    if (hasNonInteractiveBlenderSetupGuard(argv, interactive)) {
      throw new StrongCodeError("CONFIG_ERROR", "strongcode setup --blender requires an interactive TTY for explicit installation consent");
    }

    await ensureStrongCodeHome({ homePath });
    const startsAgentRuntime = argv.length === 2 || argv[2] === "run";
    if (startsAgentRuntime) {
      try {
        const retention = await (dependencies.enforceCacheRetention ?? enforceHomeCacheRetention)(homePath);
        if (retention.skippedPaths.includes("config/retention.json")) {
          (dependencies.reportCacheRetentionError ?? console.error)(
            "Cache retention policy is invalid or unsafe; cleanup skipped."
          );
        }
      } catch (error) {
        const detail = sanitizeTerminalLine(error instanceof Error ? error.message : String(error));
        (dependencies.reportCacheRetentionError ?? console.error)(`Cache retention skipped: ${detail}`);
      }
    }
    const runtimeCommand = argv.length === 2 || ["run", "tools", "session"].includes(argv[2] ?? "");
    const explicitConfig = argv.some(argument => argument === "--config" || argument.startsWith("--config="));
    const needsCoreSetup = runtimeCommand
      && !explicitConfig
      && await (dependencies.shouldRunFirstSetup ?? shouldRunFirstSetup)(homePath);
    let firstRunAttemptedBlender = false;
    if (needsCoreSetup) {
      if (!interactive) {
        throw new StrongCodeError("CONFIG_ERROR", "StrongCode setup is incomplete. Run 'strongcode setup' before using the harness.");
      }
      const setup = await (dependencies.runSetup ?? runSetup)({}, {
        homePath,
        interactive,
        workspace: dependencies.workspace,
        prompter: dependencies.setupPrompter,
        blender: dependencies.blender
      });
      firstRunAttemptedBlender = true;
      if (setup.status === "cancelled") return;
    }
    if (argv.length === 2) {
      if (interactive && !explicitConfig && !firstRunAttemptedBlender) {
        const state = await loadSetupState(homePath);
        if (state.completed && !state.blender && (state.blenderOfferVersion ?? 0) < BLENDER_OFFER_VERSION) {
          try {
            await runBlenderSetupFlow({
              homePath,
              workspace: path.resolve(dependencies.workspace ?? process.cwd()),
              mode: "automatic",
              prompter: dependencies.setupPrompter
            }, dependencies.blender);
          } catch {
            (dependencies.reportBlenderOfferError ?? console.error)(
              "Optional Blender setup was skipped. Run 'strongcode setup --blender' to retry with diagnostics."
            );
          }
        }
      }
      await (dependencies.runTui ?? runTui)();
      return;
    }

    const program = createProgram(dependencies);
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof StrongCodeError) {
      printError(error);
      process.exitCode = 1;
      return;
    }

    if (error instanceof Error && error.name === "CommanderError") {
      const exitCode = "exitCode" in error && typeof error.exitCode === "number" ? error.exitCode : 1;
      process.exitCode = exitCode;
      return;
    }

    throw error;
  }
}

if (require.main === module) {
  void main(process.argv);
}
