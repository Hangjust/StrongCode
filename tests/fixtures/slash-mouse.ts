import * as core from "@opentui/core";
import { createTestRenderer, MouseButtons } from "@opentui/core/testing";
import { buildHome } from "../../src/tui/app";
import { defaultTuiConfig } from "../../src/tui/config/tui";
import { DialogManager } from "../../src/tui/ui/dialog";
import { createDefaultPalette } from "../../src/tui/ui/palette";
import { modelUiControls } from "../../src/tui/ui/session-chrome";
import { ToastManager } from "../../src/tui/ui/toast";

async function main(): Promise<void> {
  const setup = await createTestRenderer({ width: 100, height: 32, exitOnCtrlC: false, useMouse: true, enableMouseMovement: true });
  const focused: number[] = [];
  const selected: number[] = [];
  const state = {
    provider: "mock",
    providerDisplayName: "Mock",
    model: "mock",
    modelDisplayName: "Mock",
    defaultAgent: "Tesla",
    configPath: "strongcode.config.yaml",
    configMissing: false,
    workspace: ".",
    dataDir: ".strongcode"
  };
  const services = {
    tuiConfig: defaultTuiConfig(),
    palette: createDefaultPalette(),
    dialogs: new DialogManager(),
    toasts: new ToastManager(),
    startupOverlay: "slashCommands",
    pickerIndex: 0,
    slashIndex: 0,
    slashScrollIndex: 0,
    promptDraft: "/",
    providerQuery: "",
    authInputDraft: "",
    providerAuth: {},
    controls: modelUiControls(undefined, "mock"),
    telemetry: { toolCalls: 0 },
    helpOpen: false,
    summaryOpen: false,
    turnRunning: false
  };
  const connectIndex = services.palette.search("").sort((left, right) => left.slash.localeCompare(right.slash)).findIndex(command => command.id === "connect");

  try {
    buildHome(core, setup.renderer, { state } as never, services as never, () => undefined, undefined, {
      onSlashFocus(index) { focused.push(index); },
      onSlashSelect(index) { selected.push(index); },
      onProviderSelect() {},
      onProviderQueryChange() {},
      onProviderAuthMethodSelect() {},
      onProviderAuthSubmit() {},
      onCustomProviderFieldFocus() {},
      onCustomProviderFieldChange() {},
      onCustomProviderDiscover() {},
      onCustomProviderModelToggle() {},
      onCustomProviderSubmit() {},
      onModelSelect() {}
    });
    await setup.flush();
    const row = setup.renderer.root.findDescendantById("slash-command-connect");
    if (!row) throw new Error("missing connect command row");
    await setup.mockMouse.moveTo(row.x + 1, row.y);
    await setup.mockMouse.click(row.x + 1, row.y, MouseButtons.LEFT);
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy();
  }

  const providerSetup = await createTestRenderer({ width: 100, height: 32, exitOnCtrlC: false, useMouse: true, enableMouseMovement: true });
  const providerSelected: number[] = [];
  const providerServices = { ...services, startupOverlay: "providers", promptDraft: "", pickerIndex: 0 };
  const config = {
    version: 1,
    workspace: ".",
    dataDir: ".strongcode",
    defaultAgent: "default",
    providers: {
      mock: { type: "mock", displayName: "Mock", enabled: true },
      custom: { type: "openai-compatible", displayName: "Custom", baseUrl: "https://example.com/v1", modelsEndpoint: "/models", enabled: true }
    },
    agents: { default: { model: "mock", tools: [] } },
    models: { mock: { provider: "mock", model: "mock", enabled: true } },
    permissions: { tools: {} }
  };
  try {
    buildHome(core, providerSetup.renderer, { state, config, activeAgentId: "default" } as never, providerServices as never, () => undefined, undefined, {
      onSlashFocus() {},
      onSlashSelect() {},
      onProviderSelect(index) { providerSelected.push(index); },
      onProviderQueryChange() {},
      onProviderAuthMethodSelect() {},
      onProviderAuthSubmit() {},
      onCustomProviderFieldFocus() {},
      onCustomProviderFieldChange() {},
      onCustomProviderDiscover() {},
      onCustomProviderModelToggle() {},
      onCustomProviderSubmit() {},
      onModelSelect() {}
    });
    await providerSetup.flush();
    const row = providerSetup.renderer.root.findDescendantById("provider-custom");
    if (!row) throw new Error("missing custom provider row");
    await providerSetup.mockMouse.click(row.x + 1, row.y, MouseButtons.LEFT);
  } finally {
    if (!providerSetup.renderer.isDestroyed) providerSetup.renderer.destroy();
  }

  process.stdout.write(JSON.stringify({ connectIndex, focused, selected, providerSelected }));
}

void main();
