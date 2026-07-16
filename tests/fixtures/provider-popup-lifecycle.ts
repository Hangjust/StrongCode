import * as core from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { StrongCodeConfig } from "../../src/config/schema";
import {
  addProviderPopupLayer,
  appendMessage,
  appendPendingMessage,
  buildSession,
  closeProviderPopupLayer,
  createTuiServices,
  refreshProviderPopupLayer
} from "../../src/tui/app";
import { defaultTuiConfig } from "../../src/tui/config/tui";
import { fullTuiRouteForInput } from "../../src/tui/slash-command-registry";

const config = {
  version: 1,
  workspace: ".",
  dataDir: ".strongcode",
  defaultAgent: "default",
  providers: {
    mock: { type: "mock", displayName: "Mock", enabled: true },
    openai: { type: "openai", displayName: "OpenAI", enabled: true }
  },
  agents: { default: { model: "mock", tools: [] } },
  models: { mock: { provider: "mock", model: "mock", enabled: true } },
  permissions: { tools: {} }
} satisfies StrongCodeConfig;

async function main(): Promise<void> {
  const setup = await createTestRenderer({ width: 100, height: 32, exitOnCtrlC: false });
  const state = {
    provider: "mock",
    model: "mock",
    modelDisplayName: "Mock",
    defaultAgent: "Tesla",
    configPath: "strongcode.config.yaml",
    configMissing: false
  };
  const runtime = { state, config, activeAgentId: "default" };
  const services = await createTuiServices(defaultTuiConfig(), undefined, state);
  const callbacks = {
    onSlashFocus() {},
    onSlashSelect() {},
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
  };

  try {
    const session = buildSession(core, setup.renderer, runtime, services, "Popup lifecycle", () => undefined);
    const transcript = appendMessage(core, setup.renderer, session.scroll, "assistant", "Transcript survives", state);
    const pending = appendPendingMessage(core, setup.renderer, session.scroll, state, Date.now());
    const initialScroll = session.scroll;
    const initialTextarea = session.textarea;

    services.startupOverlay = fullTuiRouteForInput("/connect") === "providers" ? "providers" : "none";
    addProviderPopupLayer(core, setup.renderer, setup.renderer.root, runtime, services, callbacks);
    await setup.flush();
    const connectOpened = Boolean(setup.renderer.root.getRenderable("provider-popup-layer"));

    services.providerQuery = "open";
    refreshProviderPopupLayer(core, setup.renderer, runtime, services, callbacks);
    services.startupOverlay = "providerAuthMethod";
    refreshProviderPopupLayer(core, setup.renderer, runtime, services, callbacks);
    services.startupOverlay = "providerAuth";
    refreshProviderPopupLayer(core, setup.renderer, runtime, services, callbacks);
    services.startupOverlay = fullTuiRouteForInput("/model") === "models" ? "models" : "none";
    refreshProviderPopupLayer(core, setup.renderer, runtime, services, callbacks);
    await setup.flush();
    const frame = process.argv.includes("--frame") ? setup.captureCharFrame() : undefined;

    const onePopupPair = Boolean(setup.renderer.root.getRenderable("provider-popup-backdrop"))
      && Boolean(setup.renderer.root.getRenderable("provider-popup-layer"));
    const scrollSame = session.scroll === initialScroll && !initialScroll.isDestroyed;
    const transcriptSurvived = !transcript.isDestroyed;
    const pendingSurvived = !pending.box.isDestroyed;

    closeProviderPopupLayer(setup.renderer, initialTextarea);
    await setup.flush();
    const focusRestored = setup.renderer.currentFocusedRenderable === initialTextarea;
    const popupRemoved = !setup.renderer.root.getRenderable("provider-popup-backdrop")
      && !setup.renderer.root.getRenderable("provider-popup-layer");

    process.stdout.write(frame ?? `${JSON.stringify({ connectOpened, onePopupPair, scrollSame, transcriptSurvived, pendingSurvived, focusRestored, popupRemoved })}\n`);
    pending.stop();
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy();
  }
}

void main();
