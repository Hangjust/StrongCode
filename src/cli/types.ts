import type { BlenderSetupDependencies } from "../setup/blender/setup";
import type { SetupPrompter } from "../setup/types";
import type { runSetup, shouldRunFirstSetup } from "../setup/wizard";
import type { runTui } from "../tui/app";

export interface CliDependencies {
  readonly runSetup?: typeof runSetup;
  readonly blender?: BlenderSetupDependencies;
  readonly setupPrompter?: SetupPrompter;
  readonly homePath?: string;
  readonly workspace?: string;
  readonly isInteractive?: () => boolean;
  readonly shouldRunFirstSetup?: typeof shouldRunFirstSetup;
  readonly runTui?: typeof runTui;
  readonly reportBlenderOfferError?: (message: string) => void;
}
