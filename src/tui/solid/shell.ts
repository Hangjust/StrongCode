import { TuiConfig } from "../config/tui";
import { PromptHistory } from "../component/prompt/history";
import { TuiPluginRuntime } from "../plugin";
import { TuiRoute } from "../route";
import { TuiState } from "../render";
import { DialogManager } from "../ui/dialog";
import { ToastManager } from "../ui/toast";

export interface SolidTuiServices {
  config: TuiConfig;
  dialogs: DialogManager;
  toasts: ToastManager;
  history: PromptHistory;
  plugins: TuiPluginRuntime;
}

export interface SolidShellNode {
  type: "box" | "text";
  props: Record<string, unknown>;
  children: Array<SolidShellNode | string>;
}

export function createSolidShellDescriptor(state: TuiState, route: TuiRoute, services: SolidTuiServices): SolidShellNode {
  return {
    type: "box",
    props: { flexDirection: "column", width: "100%", height: "100%" },
    children: [
      { type: "text", props: { fg: services.config.theme.primary }, children: ["StrongCode Solid shell"] },
      { type: "text", props: { fg: services.config.theme.text }, children: [`Route ${route.name}`] },
      { type: "text", props: { fg: services.config.theme.muted }, children: [`Model ${state.model ?? "mock"}`] },
      { type: "text", props: { fg: services.config.theme.muted }, children: [services.plugins.render("status")] }
    ]
  };
}
