import { TerminalSetupPrompter } from "../prompter";
import { loadSetupState } from "../state";
import type { SetupPrompter, SetupState } from "../types";
import { setupBlenderIntegration, type BlenderSetupDependencies, type BlenderSetupResult } from "./setup";
import { mergeBlenderSetupResult } from "./state";

export type BlenderSetupFlowOptions = {
  readonly homePath: string;
  readonly workspace: string;
  readonly mode: "automatic" | "explicit";
  readonly force?: boolean;
  readonly prompter?: SetupPrompter;
};

export type BlenderSetupFlowResult = {
  readonly setup: BlenderSetupResult;
  readonly state: SetupState;
};

export async function runBlenderSetupFlow(
  options: BlenderSetupFlowOptions,
  dependencies: BlenderSetupDependencies = {}
): Promise<BlenderSetupFlowResult> {
  const prompter = options.prompter ?? new TerminalSetupPrompter();
  try {
    if (options.mode === "explicit") prompter.intro("BLENDER SETUP");
    const setup = await setupBlenderIntegration({
      homePath: options.homePath,
      workspace: options.workspace,
      state: await loadSetupState(options.homePath),
      prompter,
      mode: options.mode,
      force: options.force ?? false
    }, dependencies);
    const state = await mergeBlenderSetupResult(options.homePath, setup);
    if (options.mode === "explicit") prompter.outro(explicitResultMessage(setup.status));
    return { setup, state };
  } finally {
    prompter.close();
  }
}

function explicitResultMessage(status: BlenderSetupResult["status"]): string {
  switch (status) {
    case "installed":
      return "StrongCode Blender integration is ready.";
    case "already-installed":
      return "StrongCode Blender integration is already installed, enabled, and verification passed.";
    case "not-found":
      return "No compatible Blender installation was found.";
    case "declined":
    case "cancelled":
      return "Blender installation was not changed.";
    case "prerequisite-missing":
      return "Blender prerequisites are not ready.";
  }
}
