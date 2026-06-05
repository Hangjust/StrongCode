import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { Agent } from "../agents/agent";
import { AgentRunner } from "../agents/runner";
import { DEFAULT_CONFIG_PATH } from "../config/load";
import { StrongCodeConfig } from "../config/schema";
import { orderedProviders } from "../models/registry";
import { requireRuntime, createAgent } from "../runtime/factory";
import { SessionStore } from "../sessions/session-store";
import { createDefaultToolRegistry } from "../tools/registry";
import { TuiState, sanitizeDisplayValue } from "./render";
import { clipDisplayLine, renderHomeWithPrompt, renderSessionLayout, renderStatus, renderHints } from "./render";
import { handleModelCommand, handleProviderCommand } from "./commands";
import { loadTuiConfig, TuiConfig } from "./config/tui";
import { describeKeybinds, TuiKeybindCommand } from "./config/keybind";
import { createDefaultPalette, renderFilteredPalette } from "./ui/palette";
import { DialogManager } from "./ui/dialog";
import { ToastManager } from "./ui/toast";
import { PromptHistory, PromptHistoryStore } from "./component/prompt/history";
import { TuiRouter } from "./route";
import { createBuiltinPluginRuntime, TuiPluginRuntime } from "./plugin";
import { renderDialogOverlay, renderPaletteOverlay, renderSlashCommandOverlay } from "./ui/overlay";
import { ProviderDialogItem, renderApprovalSurface, renderDiffSurface, renderEditorPasteSurface, renderPickerSurface, renderProviderDialogSurface, renderSidebarPanel, renderStatusDashboard, renderThemePicker } from "./ui/surfaces";
import { createSolidShellDescriptor, SolidShellNode } from "./solid/shell";

type OpenTuiCore = typeof import("@opentui/core");
type OpenTuiRenderer = InstanceType<OpenTuiCore["CliRenderer"]>;
type OpenTuiBox = InstanceType<OpenTuiCore["BoxRenderable"]>;
type OpenTuiText = InstanceType<OpenTuiCore["TextRenderable"]>;
type OpenTuiTextarea = InstanceType<OpenTuiCore["TextareaRenderable"]>;
type OpenTuiScrollBox = InstanceType<OpenTuiCore["ScrollBoxRenderable"]>;
type OpenTuiKeymap = {
  registerLayer(layer: { priority?: number; bindings?: unknown[]; commands?: unknown[] }): () => void;
};
type OpenTuiKeymapModule = {
  createDefaultOpenTuiKeymap(renderer: OpenTuiRenderer): OpenTuiKeymap;
};
type OpenTuiKeymapAddons = {
  registerBaseLayoutFallback(keymap: OpenTuiKeymap): () => void;
  registerManagedTextareaLayer(keymap: OpenTuiKeymap, renderer: OpenTuiRenderer, layer: { bindings: unknown[] }): () => void;
};
type OpenTuiSolidModule = {
  render(node: () => unknown, rendererOrConfig?: OpenTuiRenderer | Record<string, unknown>): Promise<void>;
  createElement?: (type: string, props: Record<string, unknown>, ...children: unknown[]) => unknown;
};

const COLORS = {
  background: "#0c0a08",
  panel: "#171411",
  element: "#221d19",
  border: "#5c4d40",
  primary: "#ffb870",
  secondary: "#77a9ff",
  success: "#88da99",
  warning: "#f5be66",
  text: "#f2eee6",
  muted: "#9a9184"
};

const LOGO = [
  ["██████", "██████", "█████ ", "██████", "██  ██", "██████", "██████", "██████", "█████ ", "██████"].join(" "),
  ["██    ", "  ██  ", "██  ██", "██  ██", "███ ██", "██    ", "██    ", "██  ██", "██  ██", "██    "].join(" "),
  ["█████ ", "  ██  ", "█████ ", "██  ██", "██████", "██ ███", "██    ", "██  ██", "██  ██", "█████ "].join(" "),
  ["   ██ ", "  ██  ", "██ ██ ", "██  ██", "██ ███", "██  ██", "██    ", "██  ██", "██  ██", "██    "].join(" "),
  ["██ ██ ", "  ██  ", "██  ██", "██  ██", "██  ██", "██  ██", "██    ", "██  ██", "██  ██", "██    "].join(" "),
  ["██████", "  ██  ", "██  ██", "██████", "██  ██", "██████", "██████", "██████", "█████ ", "██████"].join(" ")
];
const LOGO_WIDTH = Math.max(...LOGO.map(line => line.length));
const SLASH_COMMAND_LIMIT = 10;

function shouldUseOpenTui(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): boolean {
  return input === process.stdin && output === process.stdout && process.stdin.isTTY === true && process.stdout.isTTY === true;
}

async function runFallbackTui(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void> {
  const readline = await import("node:readline");
  const configPath = DEFAULT_CONFIG_PATH;
  const configExists = existsSync(configPath);
  const state: TuiState = { provider: "N/A", defaultAgent: "N/A", configPath, configMissing: !configExists };
  let runner: AgentRunner | undefined;
  let agent: Agent | undefined;
  let config: StrongCodeConfig | undefined;
  const messages: string[] = [];

  if (configExists) {
    try {
      const runtime = await requireRuntime(configPath);
      config = runtime.config;
      const agentName = runtime.config.defaultAgent;
      const agentConfig = runtime.config.agents[agentName];
      const modelConfig = runtime.config.models[agentConfig.model];
      state.provider = modelConfig.provider;
      state.model = agentConfig.model;
      state.defaultAgent = agentName;
      state.workspace = runtime.config.workspace;
      state.dataDir = runtime.config.dataDir;
      agent = createAgent(runtime.config, runtime.config.defaultAgent);
      runner = new AgentRunner(runtime.context, new SessionStore(runtime.context.dataDir), createDefaultToolRegistry());
    } catch (error) {
      output.write(`${clipDisplayLine(`Error loading config: ${error instanceof Error ? error.message : String(error)}`)}\n`);
    }
  }

  const services = await createTuiServices(await loadTuiConfig(), state.dataDir);

  const fallbackRuntime: RuntimeState = { state, config, runner, agent };
  output.write(`${renderHomeWithPrompt(state, true).output}\n`);
  await new Promise<void>(resolve => {
    const rl = readline.createInterface({ input, output, prompt: "" });
    let pending = Promise.resolve();
    const close = () => {
      rl.close();
      resolve();
    };
    rl.on("line", line => {
      const value = line.trim();
      pending = pending.then(async () => {
        const runtime: RuntimeState = { state, config, runner, agent };
        const append = (_role: "assistant" | "system", text: string) => {
          output.write(`\n${text}\n`);
        };
        if (await handleSystemCommand(value, runtime, services, append, close)) return;
        if (value === "/help") output.write(`\n${renderHints(true)}\n`);
        else if (value === "/status") output.write(`\n${renderStatus(state, true)}\n`);
        else if (value === "/provider" || value === "/providers" || value.startsWith("/provider ")) {
          const providerCommand = value === "/providers" ? "/provider" : value;
          const response = await handleProviderCommand(providerCommand, { config, configPath, state, noColor: true, onConfigUpdated: updated => { refreshRuntimeFromConfig(runtime, updated); config = runtime.config; agent = runtime.agent; services.toasts.push("success", "Provider config updated."); } });
          output.write(`\n${response}\n`);
        } else if (value === "/model" || value.startsWith("/model ") || value === "/models") {
          const response = await handleModelCommand(value === "/models" ? "/model" : value, { config, configPath, state, noColor: true, onConfigUpdated: updated => { refreshRuntimeFromConfig(runtime, updated); config = runtime.config; agent = runtime.agent; services.toasts.push("success", "Model config updated."); } });
          output.write(`\n${response}\n`);
        } else if (value.startsWith("/")) output.write(`\n${clipDisplayLine(`Unknown command: ${value}`)}\n`);
        else if (value) {
          services.history.add(value);
          await services.historyStore?.save(services.history);
          if (!runner || !agent) output.write("\nConfig missing. Run 'strongcode init' first.\n");
          else {
            const result = await runner.run(agent, value, `session-${Date.now()}`);
            messages.push(`user: ${value}`);
            messages.push(`assistant: ${result.ok ? result.value.response : String(result.error)}`);
            output.write(`\n${renderSessionLayout(state, messages, true)}\n`);
          }
        }
      }).catch(error => {
        output.write(`\n${clipDisplayLine(`Error: ${error instanceof Error ? error.message : String(error)}`)}\n`);
      });
    });
  });
}

async function runThroughBun(): Promise<void> {
  const entry = require.main?.filename ?? __filename;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("bun", [entry], {
      cwd: process.cwd(),
      env: { ...process.env, STRONGCODE_TUI_BUN: "1" },
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("exit", code => {
      process.exitCode = code ?? 0;
      resolve();
    });
  });
}

interface RuntimeState {
  state: TuiState;
  config?: StrongCodeConfig;
  runner?: AgentRunner;
  agent?: Agent;
}

interface TuiServices {
  tuiConfig: TuiConfig;
  palette: ReturnType<typeof createDefaultPalette>;
  dialogs: DialogManager;
  toasts: ToastManager;
  history: PromptHistory;
  historyStore?: PromptHistoryStore;
  router: TuiRouter;
  plugins: TuiPluginRuntime;
  startupOverlay: "none" | "palette" | "slashCommands" | "whichkey" | "themes" | "models" | "providers" | "sessions" | "toasts";
  pickerIndex: number;
  slashIndex: number;
  slashScrollIndex: number;
  promptDraft: string;
  modelProviderFilter?: string;
}

async function createTuiServices(tuiConfig: TuiConfig, dataDir?: string): Promise<TuiServices> {
  const historyStore = dataDir ? new PromptHistoryStore(dataDir) : undefined;
  return {
    tuiConfig,
    palette: createDefaultPalette(),
    dialogs: new DialogManager(),
    toasts: new ToastManager(),
    history: historyStore ? await historyStore.load() : new PromptHistory(),
    historyStore,
    router: new TuiRouter(),
    plugins: createBuiltinPluginRuntime(),
    startupOverlay: "none",
    pickerIndex: 0,
    slashIndex: 0,
    slashScrollIndex: 0,
    promptDraft: ""
  };
}

function renderThemeDetails(tuiConfig: TuiConfig): string {
  const files = tuiConfig.sourceFiles.length > 0 ? tuiConfig.sourceFiles.map(file => `  ${sanitizeDisplayValue(file, "")}`).join("\n") : "  default theme only";
  return [
    `Theme ${sanitizeDisplayValue(tuiConfig.theme.name, "default")}`,
    `Leader ${tuiConfig.leader ? `${sanitizeDisplayValue(tuiConfig.leader)} (${tuiConfig.leaderTimeout}ms)` : "disabled"}`,
    `Mouse ${tuiConfig.mouse ? "enabled" : "disabled"}`,
    `Diff ${tuiConfig.diffStyle}`,
    "Config files:",
    files
  ].join("\n");
}

function renderThemeSurface(tuiConfig: TuiConfig): string {
  const themes = Array.from(new Set([tuiConfig.theme.name, "ember", "mono", "contrast"]));
  return [
    renderThemePicker({ activeTheme: tuiConfig.theme.name, themes }),
    "",
    renderThemeDetails(tuiConfig)
  ].join("\n");
}

async function renderSessionList(runtime: RuntimeState): Promise<string> {
  if (!runtime.state.dataDir) return "Config missing. Run 'strongcode init' first.";
  const result = await new SessionStore(runtime.state.dataDir).list();
  if (!result.ok) return clipDisplayLine(`Error: ${result.error.message}`);
  return result.value.length > 0 ? renderPickerSurface("Session Picker", result.value.map(session => ({ id: session, label: session, description: "saved session" })), 0) : "No saved sessions.";
}

function providerPickerDescription(providerId: string): string {
  return {
    openai: "(ChatGPT Plus/Pro or API key)",
    anthropic: "(API key)",
    kimi: "(Moonshot API key)",
    grok: "(xAI API key)",
    mock: "(local mock provider)",
    custom: "Custom provider"
  }[providerId] ?? "";
}

function providerDialogTitle(providerId: string, displayName: string): string {
  return providerId === "custom" ? "Other" : displayName;
}

function providerDialogCategory(providerId: string): ProviderDialogItem["category"] {
  return ["openai", "anthropic", "mock"].includes(providerId) ? "Popular" : "Providers";
}

function providerPickerEntries(runtime: RuntimeState, query = ""): Array<[string, StrongCodeConfig["providers"][string]]> {
  if (!runtime.config) return [];
  const normalized = sanitizeDisplayValue(query, "").trim().toLowerCase();
  return orderedProviders(runtime.config.providers)
    .map(provider => [provider.id, provider.config] as [string, StrongCodeConfig["providers"][string]])
    .filter(([providerId, provider]) => {
      if (!normalized) return true;
      const displayName = sanitizeDisplayValue(provider.displayName, providerId).toLowerCase();
      const description = providerPickerDescription(providerId).toLowerCase();
      return providerId.toLowerCase().includes(normalized) || displayName.includes(normalized) || description.includes(normalized);
    });
}

function modelPickerEntries(runtime: RuntimeState): Array<[string, StrongCodeConfig["models"][string]]> {
  return modelPickerEntriesForProvider(runtime);
}

function modelPickerEntriesForProvider(runtime: RuntimeState, providerFilter?: string): Array<[string, StrongCodeConfig["models"][string]]> {
  if (!runtime.config) return [];
  const providerOrder = new Map(providerPickerEntries(runtime).map(([providerId], index) => [providerId, index]));
  return Object.entries(runtime.config.models).filter(([, model]) => !providerFilter || model.provider === providerFilter).sort(([leftId, left], [rightId, right]) => {
    const providerDelta = (providerOrder.get(left.provider) ?? Number.MAX_SAFE_INTEGER) - (providerOrder.get(right.provider) ?? Number.MAX_SAFE_INTEGER);
    if (providerDelta !== 0) return providerDelta;
    return leftId.localeCompare(rightId);
  });
}

function selectedProviderIndex(runtime: RuntimeState): number {
  return Math.max(0, providerPickerEntries(runtime).findIndex(([providerId]) => providerId === runtime.state.provider));
}

function selectedModelIndex(runtime: RuntimeState): number {
  return selectedModelIndexForProvider(runtime);
}

function selectedModelIndexForProvider(runtime: RuntimeState, providerFilter?: string): number {
  return Math.max(0, modelPickerEntriesForProvider(runtime, providerFilter).findIndex(([modelId]) => modelId === runtime.state.model));
}

function renderModelPicker(runtime: RuntimeState, selectedIndexOverride?: number, providerFilter?: string): string {
  if (!runtime.config) return "Config missing. Run 'strongcode init' first.";
  const models = modelPickerEntriesForProvider(runtime, providerFilter);
  const selectedIndex = selectedIndexOverride ?? selectedModelIndex(runtime);
  const title = providerFilter ? sanitizeDisplayValue(runtime.config.providers[providerFilter]?.displayName ?? providerFilter, providerFilter) : "Select model";
  return renderPickerSurface(title, models.map(([modelId, model]) => ({
    id: modelId,
    label: `${model.enabled === false ? "○" : "●"} ${sanitizeDisplayValue(model.displayName ?? modelId, "unknown")}`,
    description: sanitizeDisplayValue(model.displayName && model.displayName !== modelId ? `${model.provider}/${modelId}` : model.provider, "unknown")
  })), selectedIndex);
}

function renderProviderPicker(runtime: RuntimeState, selectedIndexOverride?: number, query = ""): string {
  if (!runtime.config) return "Config missing. Run 'strongcode init' first.";
  const providers = providerPickerEntries(runtime, query);
  const selectedIndex = Math.max(0, Math.min(selectedIndexOverride ?? selectedProviderIndex(runtime), Math.max(0, providers.length - 1)));
  return renderProviderDialogSurface(providers.map(([providerId, provider]): ProviderDialogItem => {
    const displayName = sanitizeDisplayValue(provider.displayName, providerId);
    const apiKeyEnv = provider.apiKeyEnv ? sanitizeDisplayValue(provider.apiKeyEnv, "unknown") : undefined;
    return {
      id: providerId,
      title: providerDialogTitle(providerId, displayName),
      description: sanitizeDisplayValue(providerPickerDescription(providerId), providerId),
      category: providerDialogCategory(providerId),
      connected: provider.enabled !== false,
      credential: apiKeyEnv ? `env ${apiKeyEnv} (${process.env[provider.apiKeyEnv ?? ""] ? "set" : "missing"})` : "no key required",
      footer: provider.baseUrl ? sanitizeDisplayValue(provider.baseUrl, "") : undefined
    };
  }), selectedIndex, query);
}

function renderRuntimeDashboard(runtime: RuntimeState, services: TuiServices): string {
  return [
    renderStatusDashboard("Status Dashboard", [
      { label: "state", value: runtime.state.configMissing ? "disconnected" : "connected", state: runtime.state.configMissing ? "warn" : "ok" },
      { label: "route", value: services.router.current().name, state: "ok" },
      { label: "provider", value: runtime.state.provider, state: "muted" },
      { label: "model", value: runtime.state.model ?? "N/A", state: "muted" },
      { label: "toasts", value: String(services.toasts.list().length), state: "muted" },
      { label: "plugins", value: String(services.plugins.list().length), state: "muted" }
    ]),
    "",
    renderSidebarPanel({ title: "Sidebar", rows: [
      { label: "workspace", value: runtime.state.workspace ?? "." },
      { label: "data", value: runtime.state.dataDir ?? ".strongcode" },
      { label: "theme", value: services.tuiConfig.theme.name }
    ] })
  ].join("\n");
}

function keyEventToInput(key: { name: string; ctrl?: boolean; meta?: boolean; shift?: boolean }): string {
  const modifiers = [key.ctrl ? "ctrl" : "", key.meta ? "meta" : "", key.shift ? "shift" : ""].filter(Boolean);
  return [...modifiers, key.name].join("+").toLowerCase();
}

function addMultilineText(core: OpenTuiCore, renderer: OpenTuiRenderer, parent: OpenTuiBox | OpenTuiScrollBox, content: string, options: Partial<ConstructorParameters<OpenTuiCore["TextRenderable"]>[1]> = {}): void {
  for (const line of content.split("\n")) addText(core, renderer, parent, line, options);
}

function slashQuery(value: string): string | undefined {
  if (!value.startsWith("/")) return undefined;
  const query = value.slice(1);
  return query.includes(" ") ? undefined : query;
}

function slashCommands(services: TuiServices) {
  const query = slashQuery(services.promptDraft) ?? "";
  return services.palette.search(query).sort((left, right) => left.slash.localeCompare(right.slash));
}

export function exactHomeCommandOverlay(value: string): TuiServices["startupOverlay"] | undefined {
  if (value === "/provider" || value === "/providers") return "providers";
  if (value === "/model") return "models";
  return undefined;
}

export function shouldSubmitHomePrompt(startupOverlay: string): boolean {
  return startupOverlay === "none";
}

function renderHomeOverlayText(runtime: RuntimeState, services: TuiServices): string {
  const dialog = services.dialogs.active();
  if (dialog) return renderDialogOverlay(dialog);
  if (services.startupOverlay === "whichkey") {
    return renderConfiguredWhichKey(services);
  }
  if (services.startupOverlay === "themes") return renderThemePicker({ activeTheme: services.tuiConfig.theme.name, themes: Array.from(new Set([services.tuiConfig.theme.name, "ember", "mono", "contrast"])) });
  if (services.startupOverlay === "slashCommands") {
    const query = slashQuery(services.promptDraft) ?? "";
    return renderSlashCommandOverlay(slashCommands(services), services.slashIndex, query, services.slashScrollIndex);
  }
  if (services.startupOverlay === "models") return renderModelPicker(runtime, services.pickerIndex, services.modelProviderFilter);
  if (services.startupOverlay === "providers") return renderProviderPicker(runtime, services.pickerIndex, services.promptDraft);
  if (services.startupOverlay === "sessions") return "Session Picker\nUse /sessions to load saved sessions.";
  if (services.startupOverlay === "toasts") return services.toasts.list().length > 0 ? services.toasts.render() : "No toasts yet.";
  return renderPaletteOverlay(services.palette.list(), services.palette.cursor());
}

function renderConfiguredWhichKey(services: TuiServices): string {
  return [`Which key: ${services.tuiConfig.leader || "disabled"}`, ...describeKeybinds(services.tuiConfig.keybinds).map(line => `  ${line}`)].join("\n");
}

function commandForKey(services: TuiServices, inputKey: string): TuiKeybindCommand | undefined {
  for (const [command, bindings] of Object.entries(services.tuiConfig.keybinds)) {
    if (bindings.map(binding => binding.toLowerCase()).includes(inputKey)) return command as TuiKeybindCommand;
  }
  return undefined;
}

async function tryMountSolidStartupShell(renderer: OpenTuiRenderer, runtime: RuntimeState, services: TuiServices): Promise<boolean> {
  if (!process.versions.bun) return false;
  try {
    const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<OpenTuiSolidModule>;
    const solid = await dynamicImport("@opentui/solid");
    if (!solid.createElement) return false;
    const instantiate = (node: SolidShellNode | string): unknown => {
      if (typeof node === "string") return node;
      return solid.createElement?.(node.type, node.props, ...node.children.map(instantiate));
    };
    const descriptor = createSolidShellDescriptor(runtime.state, services.router.current(), {
      config: services.tuiConfig,
      dialogs: services.dialogs,
      toasts: services.toasts,
      history: services.history,
      plugins: services.plugins
    });
    await solid.render(() => instantiate(descriptor), renderer);
    return true;
  } catch {
    return false;
  }
}

function refreshRuntimeFromConfig(runtime: RuntimeState, config: StrongCodeConfig): void {
  runtime.config = config;
  const agentConfig = config.agents[config.defaultAgent];
  const modelConfig = config.models[agentConfig.model];
  runtime.state.provider = modelConfig.provider;
  runtime.state.model = agentConfig.model;
  runtime.state.defaultAgent = config.defaultAgent;
  try {
    runtime.agent = createAgent(config, config.defaultAgent);
  } catch {
    runtime.agent = undefined;
  }
}

async function handleSystemCommand(input: string, runtime: RuntimeState, services: TuiServices, append: (role: "assistant" | "system", text: string) => void | Promise<void>, exit: () => void): Promise<boolean> {
  if (input === "/exit" || input === "exit" || input === "quit") {
    exit();
    return true;
  }
  if (input === "/help") {
    append("system", `${renderHints(true)}\n\nKeybinds\n${describeKeybinds(services.tuiConfig.keybinds).join("\n")}`);
    return true;
  }
  if (input === "/commands" || input.startsWith("/commands ")) {
    const query = input.slice("/commands".length).trim();
    services.router.go("home");
    append("system", query ? renderFilteredPalette(services.palette, query) : renderPaletteOverlay(services.palette.list(), services.palette.cursor()));
    return true;
  }
  if (input === "/status") {
    append("system", renderRuntimeDashboard(runtime, services));
    return true;
  }
  if (input === "/themes") {
    services.dialogs.open({ id: "theme", title: "Theme", body: renderThemeSurface(services.tuiConfig).split("\n"), actions: [{ id: "close", label: "Close" }] });
    append("system", renderDialogOverlay(services.dialogs.active() ?? { id: "theme", title: "Theme", body: [], actions: [] }));
    return true;
  }
  if (input === "/toast") {
    services.toasts.push("info", "Toast stack is active.");
    services.toasts.push("success", "UI event completed.");
    append("system", services.toasts.render());
    return true;
  }
  if (input === "/plugins") {
    const rows = services.plugins.list().map(plugin => `${plugin.id} -> ${plugin.slot}`);
    append("system", rows.length > 0 ? ["Plugins", ...rows, services.plugins.render("status")].join("\n") : "No TUI plugins registered.");
    return true;
  }
  if (input === "/whichkey") {
    append("system", renderConfiguredWhichKey(services));
    return true;
  }
  if (input === "/diff") {
    services.router.go("diff");
    append("system", renderDiffSurface({ filePath: "src/example.ts", before: "const ready = false;", after: "const ready = true;" }));
    return true;
  }
  if (input === "/approve") {
    services.router.go("approval");
    append("system", renderApprovalSurface({ toolName: "write_file", risk: "medium", description: "Approve a file write requested by an agent." }));
    return true;
  }
  if (input === "/pick") {
    services.router.go("picker");
    append("system", renderPickerSurface("Picker", services.palette.list().map(command => ({ id: command.id, label: command.slash, description: command.title })), services.palette.cursor()));
    return true;
  }
  if (input === "/paste") {
    services.router.go("editorPaste");
    append("system", renderEditorPasteSurface({ content: "Large pasted content is previewed here before submit or external edit." }));
    return true;
  }
  if (input === "/sessions") {
    services.router.go("sessions");
    append("system", await renderSessionList(runtime));
    return true;
  }
  if (input === "/provider" || input === "/providers") {
    const response = await handleProviderCommand("/provider", {
      config: runtime.config,
      configPath: DEFAULT_CONFIG_PATH,
      state: runtime.state,
      noColor: true,
      onConfigUpdated: config => {
        refreshRuntimeFromConfig(runtime, config);
        services.toasts.push("success", "Provider config updated.");
      }
    });
    append("system", response);
    return true;
  }
  if (input === "/model" || input.startsWith("/model ")) {
    if (input === "/model") {
      services.router.go("models");
      append("system", renderModelPicker(runtime));
      return true;
    }
    const response = await handleModelCommand(input, {
      config: runtime.config,
      configPath: DEFAULT_CONFIG_PATH,
      state: runtime.state,
      noColor: true,
      onConfigUpdated: config => {
        refreshRuntimeFromConfig(runtime, config);
        services.toasts.push("success", "Model config updated.");
      }
    });
    append("system", response);
    return true;
  }
  if (input === "/models") {
    const response = await handleModelCommand("/model", {
      config: runtime.config,
      configPath: DEFAULT_CONFIG_PATH,
      state: runtime.state,
      noColor: true,
      onConfigUpdated: config => {
        refreshRuntimeFromConfig(runtime, config);
        services.toasts.push("success", "Model config updated.");
      }
    });
    append("system", response);
    return true;
  }
  if (input === "/new") {
    services.router.go("session", { id: `session-${Date.now()}` });
    services.toasts.push("success", "Started a new local session view.");
    append("system", services.toasts.render());
    return true;
  }
  return false;
}

async function loadRuntimeState(): Promise<RuntimeState> {
  const configPath = DEFAULT_CONFIG_PATH;
  const configExists = existsSync(configPath);
  const state: TuiState = {
    provider: "N/A",
    defaultAgent: "N/A",
    configPath,
    configMissing: !configExists
  };

  if (!configExists) return { state };

  const runtime = await requireRuntime(configPath);
  const agentName = runtime.config.defaultAgent;
  const agentConfig = runtime.config.agents[agentName];
  const modelConfig = runtime.config.models[agentConfig.model];
  state.provider = modelConfig.provider;
  state.model = agentConfig.model;
  state.defaultAgent = agentName;
  state.workspace = runtime.config.workspace;
  state.dataDir = runtime.config.dataDir;

  return {
    state,
    config: runtime.config,
    agent: createAgent(runtime.config, runtime.config.defaultAgent),
    runner: new AgentRunner(runtime.context, new SessionStore(runtime.context.dataDir), createDefaultToolRegistry())
  };
}

function addText(core: OpenTuiCore, ctx: OpenTuiRenderer, parent: OpenTuiBox | OpenTuiScrollBox, content: string, options: Partial<ConstructorParameters<OpenTuiCore["TextRenderable"]>[1]> = {}): OpenTuiText {
  const text = new core.TextRenderable(ctx, {
    content,
    fg: COLORS.text,
    wrapMode: "word",
    height: 1,
    ...options
  });
  parent.add(text);
  return text;
}

function clearBox(box: { getChildren(): Array<{ id: string }>; remove(id: string): void }): void {
  for (const child of [...box.getChildren()]) box.remove(child.id);
}

function promptStatusLabel(value: string | undefined, fallback: string): string {
  const label = sanitizeDisplayValue(value, "").trim();
  return label && label !== "N/A" ? label : fallback;
}

function modelLine(state: TuiState): string {
  const agent = promptStatusLabel(state.defaultAgent, "default");
  const model = promptStatusLabel(state.model, "mock");
  const provider = promptStatusLabel(state.provider, "local");
  return `StrongCode · ${agent} · ${model} · ${provider}`;
}

function createPrompt(core: OpenTuiCore, renderer: OpenTuiRenderer, parent: OpenTuiBox, state: TuiState, initialValue: string, onSubmit: (value: string) => void, onContentChange?: () => void): OpenTuiTextarea {
  const promptOuter = new core.BoxRenderable(renderer, {
    width: 75,
    height: 8,
    flexDirection: "row",
    flexShrink: 0
  });
  parent.add(promptOuter);

  const accent = new core.BoxRenderable(renderer, {
    width: 1,
    height: 7,
    backgroundColor: COLORS.primary,
    flexShrink: 0
  });
  promptOuter.add(accent);

  const promptPanel = new core.BoxRenderable(renderer, {
    flexGrow: 1,
    minWidth: 0,
    height: 7,
    backgroundColor: COLORS.element,
    paddingLeft: 2,
    paddingRight: 2,
    paddingTop: 1,
    flexDirection: "column"
  });
  promptOuter.add(promptPanel);

  let textarea!: OpenTuiTextarea;
  textarea = new core.TextareaRenderable(renderer, {
    width: "100%",
    height: 5,
    initialValue,
    placeholder: "Ask anything... \"Fix a TODO in the codebase\"",
    placeholderColor: COLORS.muted,
    textColor: COLORS.text,
    focusedTextColor: COLORS.text,
    backgroundColor: COLORS.element,
    focusedBackgroundColor: COLORS.element,
    cursorColor: COLORS.text,
    wrapMode: "word",
    onSubmit: () => {
      const value = textarea.plainText.trim();
      textarea.clear();
      if (value) onSubmit(value);
    }
  });
  if (onContentChange) {
    textarea.onContentChange = () => setImmediate(onContentChange);
  }
  if (initialValue) textarea.cursorOffset = initialValue.length;
  promptPanel.add(textarea);

  const meta = new core.TextRenderable(renderer, {
    content: modelLine(state),
    fg: COLORS.primary,
    bg: COLORS.element,
    height: 1
  });
  promptPanel.add(meta);

  const hints = new core.BoxRenderable(renderer, {
    width: 75,
    height: 1,
    flexDirection: "row",
    justifyContent: "flex-start",
    gap: 3,
    flexShrink: 0
  });
  parent.add(hints);
  
  return textarea;
}

function appendMessage(core: OpenTuiCore, renderer: OpenTuiRenderer, scroll: OpenTuiScrollBox, role: "user" | "assistant" | "system", text: string, state: TuiState): void {
  if (role === "user") {
    const box = new core.BoxRenderable(renderer, {
      width: "100%",
      border: ["left"],
      customBorderChars: { vertical: "┃", topLeft: "", bottomLeft: "", horizontal: " ", topRight: "", bottomRight: "", topT: "", bottomT: "", leftT: "", rightT: "", cross: "" },
      borderColor: COLORS.secondary,
      backgroundColor: COLORS.panel,
      paddingLeft: 2,
      paddingTop: 1,
      paddingBottom: 1,
      marginTop: 1
    });
    box.add(new core.TextRenderable(renderer, { content: sanitizeDisplayValue(text, ""), fg: COLORS.text, bg: COLORS.panel, wrapMode: "word", height: "auto" }));
    scroll.add(box);
    scroll.scrollTo(scroll.scrollHeight);
    return;
  }

  const box = new core.BoxRenderable(renderer, {
    width: "100%",
    paddingLeft: 3,
    marginTop: 1,
    flexDirection: "column"
  });
  box.add(new core.TextRenderable(renderer, { content: sanitizeDisplayValue(text, ""), fg: role === "system" ? COLORS.warning : COLORS.text, wrapMode: "word", height: "auto" }));
  if (role === "assistant") box.add(new core.TextRenderable(renderer, { content: `▣ Build · ${sanitizeDisplayValue(state.model, "mock")} ${sanitizeDisplayValue(state.provider, "mock")}`, fg: COLORS.muted, height: 1 }));
  scroll.add(box);
  scroll.scrollTo(scroll.scrollHeight);
}

function addSlashCommandOverlay(core: OpenTuiCore, renderer: OpenTuiRenderer, parent: OpenTuiBox, services: TuiServices): void {
  const commands = slashCommands(services);
  const maxStart = Math.max(0, commands.length - SLASH_COMMAND_LIMIT);
  const startIndex = Math.max(0, Math.min(services.slashScrollIndex, maxStart));
  const visibleCommands = commands.slice(startIndex, startIndex + SLASH_COMMAND_LIMIT);
  const height = Math.max(1, visibleCommands.length) + 2;
  const menu = new core.BoxRenderable(renderer, {
    width: 75,
    height,
    flexDirection: "column",
    border: true,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panel,
    flexShrink: 0
  });
  parent.add(menu);

  if (visibleCommands.length === 0) {
    const row = new core.BoxRenderable(renderer, { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1, backgroundColor: COLORS.panel });
    row.add(new core.TextRenderable(renderer, { content: "No matching items", fg: COLORS.muted, bg: COLORS.panel, height: 1 }));
    menu.add(row);
    return;
  }

  const triggerWidth = Math.min(22, Math.max(...visibleCommands.map(command => command.slash.length)) + 2);
  visibleCommands.forEach((command, index) => {
    const selected = index + startIndex === services.slashIndex;
    const background = selected ? COLORS.primary : COLORS.panel;
    const foreground = selected ? COLORS.background : COLORS.text;
    const muted = selected ? COLORS.background : COLORS.muted;
    const row = new core.BoxRenderable(renderer, {
      width: "100%",
      height: 1,
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: background,
      flexDirection: "row"
    });
    row.add(new core.TextRenderable(renderer, { content: command.slash.padEnd(triggerWidth), fg: foreground, bg: background, width: triggerWidth, height: 1 }));
    row.add(new core.TextRenderable(renderer, { content: sanitizeDisplayValue(command.description, ""), fg: muted, bg: background, height: 1, wrapMode: "none" }));
    menu.add(row);
  });
}

function buildHome(core: OpenTuiCore, renderer: OpenTuiRenderer, runtime: RuntimeState, services: TuiServices, onSubmit: (input: string) => void, onContentChange?: () => void): OpenTuiTextarea {
  const root = renderer.root;
  clearBox(root);
  root.flexDirection = "column";

  const container = new core.BoxRenderable(renderer, {
    flexGrow: 1,
    minWidth: 0,
    height: "100%",
    flexDirection: "column",
    alignItems: "center",
    paddingLeft: 2,
    paddingRight: 2
  });
  root.add(container);

  const spacerTop = new core.BoxRenderable(renderer, { height: 2, flexShrink: 1 });
  container.add(spacerTop);
  for (const line of LOGO) {
    addText(core, renderer, container, line, { fg: COLORS.primary, width: LOGO_WIDTH, height: 1 });
  }
  container.add(new core.BoxRenderable(renderer, { height: 1, flexShrink: 0 }));
  if (services.startupOverlay !== "none" || services.dialogs.active()) {
    if (services.startupOverlay === "slashCommands") {
      addSlashCommandOverlay(core, renderer, container, services);
    } else {
      const overlay = new core.BoxRenderable(renderer, { width: 75, flexDirection: "column", border: true, borderColor: COLORS.secondary, paddingLeft: 1, paddingRight: 1, paddingTop: 1, paddingBottom: 1, flexShrink: 0 });
      container.add(overlay);
      addMultilineText(core, renderer, overlay, renderHomeOverlayText(runtime, services), { fg: COLORS.text, height: 1 });
    }
  }
  const textarea = createPrompt(core, renderer, container, runtime.state, services.promptDraft, onSubmit, onContentChange);
  container.add(new core.BoxRenderable(renderer, { flexGrow: 1, minHeight: 1 }));

  const footer = new core.BoxRenderable(renderer, { width: "100%", height: 1, flexDirection: "row", justifyContent: "space-between", paddingLeft: 1, paddingRight: 1, flexShrink: 0 });
  footer.add(new core.TextRenderable(renderer, { content: sanitizeDisplayValue(runtime.state.workspace, "."), fg: COLORS.muted, width: 32 }));
  footer.add(new core.TextRenderable(renderer, { content: `• 0 LSP   ⊙ 0 MCP`, fg: COLORS.text, width: 30 }));
  container.add(footer);

  textarea.focus();
  renderer.focusRenderable(textarea);
  renderer.requestRender();
  return textarea;
}

function buildSession(core: OpenTuiCore, renderer: OpenTuiRenderer, runtime: RuntimeState, onSubmit: (input: string, scroll: OpenTuiScrollBox) => void): { textarea: OpenTuiTextarea; scroll: OpenTuiScrollBox } {
  clearBox(renderer.root);
  renderer.root.flexDirection = "row";

  const main = new core.BoxRenderable(renderer, { flexGrow: 1, minWidth: 0, height: "100%", paddingLeft: 2, paddingRight: 2, paddingBottom: 1, flexDirection: "column", gap: 1 });
  renderer.root.add(main);

  const scroll = new core.ScrollBoxRenderable(renderer, {
    id: "session-scroll",
    flexGrow: 1,
    minHeight: 0,
    stickyScroll: true,
    stickyStart: "bottom",
    verticalScrollbarOptions: {
      visible: true,
      trackOptions: { backgroundColor: COLORS.element, foregroundColor: COLORS.border }
    }
  });
  main.add(scroll);
  appendMessage(core, renderer, scroll, "system", "No messages in session.", runtime.state);
  const textarea = createPrompt(core, renderer, main, runtime.state, "", input => onSubmit(input, scroll));

  const sidebar = new core.BoxRenderable(renderer, { width: 42, height: "100%", backgroundColor: COLORS.panel, paddingTop: 1, paddingBottom: 1, paddingLeft: 2, paddingRight: 2, flexDirection: "column" });
  renderer.root.add(sidebar);
  const sidebarScroll = new core.ScrollBoxRenderable(renderer, { flexGrow: 1, scrollY: true });
  sidebar.add(sidebarScroll);
  addText(core, renderer, sidebarScroll, "local", { fg: COLORS.text, height: 1 });
  addText(core, renderer, sidebarScroll, sanitizeDisplayValue(runtime.state.workspace, "."), { fg: COLORS.muted, height: 1 });
  addText(core, renderer, sidebarScroll, sanitizeDisplayValue(runtime.state.model, "mock"), { fg: COLORS.muted, height: 1 });
  sidebar.add(new core.TextRenderable(renderer, { content: "• StrongCode 0.1.0", fg: COLORS.muted, height: 1 }));

  textarea.focus();
  renderer.focusRenderable(textarea);
  renderer.requestRender();
  return { textarea, scroll };
}

async function loadOpenTuiCore(): Promise<OpenTuiCore> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<OpenTuiCore>;
  return dynamicImport("@opentui/core");
}

async function loadOpenTuiKeymap(): Promise<OpenTuiKeymapModule> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<OpenTuiKeymapModule>;
  return dynamicImport("@opentui/keymap/opentui");
}

async function loadOpenTuiKeymapAddons(): Promise<OpenTuiKeymapAddons> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<OpenTuiKeymapAddons>;
  return dynamicImport("@opentui/keymap/addons/opentui");
}

export async function runTui(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  if (!shouldUseOpenTui(input, output)) {
    await runFallbackTui(input, output);
    return;
  }
  if (!process.versions.bun && process.env.STRONGCODE_TUI_BUN !== "1") {
    await runThroughBun();
    return;
  }
  const core = await loadOpenTuiCore();
  const keymapModule = await loadOpenTuiKeymap();
  const keymapAddons = await loadOpenTuiKeymapAddons();
  const runtime = await loadRuntimeState().catch(error => {
    const state: TuiState = { provider: "N/A", defaultAgent: "N/A", configPath: DEFAULT_CONFIG_PATH, configMissing: true };
    return { state, error } as RuntimeState & { error: unknown };
  });
  const services = await createTuiServices(await loadTuiConfig(), runtime.state.dataDir);

  const renderer = await core.createCliRenderer({
    exitOnCtrlC: false,
    useMouse: services.tuiConfig.mouse,
    enableMouseMovement: services.tuiConfig.mouse,
    autoFocus: false,
    targetFps: 60,
    backgroundColor: COLORS.background,
    openConsoleOnError: false,
    screenMode: "alternate-screen"
  });
  const keymap = keymapModule.createDefaultOpenTuiKeymap(renderer);
  const unregisterBaseLayout = keymapAddons.registerBaseLayoutFallback(keymap);
  const unregisterTextareaLayer = keymapAddons.registerManagedTextareaLayer(keymap, renderer, {
    bindings: [{ key: "return", cmd: "input.submit", desc: "Submit prompt", group: "Text Editing" }]
  });

  let activeScroll: OpenTuiScrollBox | undefined;
  const exit = () => {
    if (!renderer.isDestroyed) renderer.destroy();
  };

  const handleSubmit = async (input: string, scroll?: OpenTuiScrollBox): Promise<void> => {
    if (!scroll && input.startsWith("/")) {
      const sessionView = buildSession(core, renderer, runtime, (value, sessionScroll) => void handleSubmit(value, sessionScroll));
      activeScroll = sessionView.scroll;
      scroll = sessionView.scroll;
      sessionView.textarea.focus();
    }
    const append = (role: "assistant" | "system", text: string) => {
      if (scroll) appendMessage(core, renderer, scroll, role, text, runtime.state);
    };
    if (await handleSystemCommand(input, runtime, services, append, exit)) {
      return;
    }
    if (input.startsWith("/provider ")) {
      if (!scroll) return;
      const response = await handleProviderCommand(input, {
        config: runtime.config,
        configPath: DEFAULT_CONFIG_PATH,
        state: runtime.state,
        noColor: true,
        onConfigUpdated: config => {
          refreshRuntimeFromConfig(runtime, config);
          services.toasts.push("success", "Provider config updated.");
        }
      });
      appendMessage(core, renderer, scroll, "system", response, runtime.state);
      return;
    }

    if (input.startsWith("/")) {
      if (scroll) appendMessage(core, renderer, scroll, "system", clipDisplayLine(`Unknown command: ${input}`), runtime.state);
      return;
    }

    if (!activeScroll) {
      const sessionView = buildSession(core, renderer, runtime, (value, sessionScroll) => void handleSubmit(value, sessionScroll));
      activeScroll = sessionView.scroll;
      sessionView.textarea.focus();
    }

    const targetScroll = scroll ?? activeScroll;
    if (!targetScroll) return;
    services.history.add(input);
    await services.historyStore?.save(services.history);
    appendMessage(core, renderer, targetScroll, "user", input, runtime.state);
    if (!runtime.runner || !runtime.agent) {
      appendMessage(core, renderer, targetScroll, "system", "Config missing. Run 'strongcode init' first.", runtime.state);
      return;
    }
    const result = await runtime.runner.run(runtime.agent, input, `session-${Date.now()}`);
    appendMessage(core, renderer, targetScroll, result.ok ? "assistant" : "system", result.ok ? result.value.response : String(result.error), runtime.state);
  };

  let textarea: OpenTuiTextarea;
  const openHomeOverlayForCommand = (value: string): boolean => {
    const overlay = exactHomeCommandOverlay(value);
    if (!overlay) return false;
    services.modelProviderFilter = undefined;
    services.pickerIndex = overlay === "providers" ? selectedProviderIndex(runtime) : selectedModelIndex(runtime);
    showOverlay(overlay);
    return true;
  };
  const submitHomeValue = (value: string) => {
    services.promptDraft = "";
    services.startupOverlay = "none";
    if (openHomeOverlayForCommand(value)) return;
    if (value) void handleSubmit(value);
  };
  const submitPrompt = () => {
    const value = textarea.plainText.trim();
    textarea.clear();
    submitHomeValue(value);
  };
  const rebuildHome = () => {
    textarea = buildHome(core, renderer, runtime, services, value => {
      if (shouldSubmitHomePrompt(services.startupOverlay)) submitHomeValue(value);
    }, () => syncSlashOverlay());
    textarea.focus();
  };
  const showOverlay = (overlay: TuiServices["startupOverlay"]) => {
    services.startupOverlay = overlay;
    services.dialogs.close();
    rebuildHome();
  };
  const executePaletteSelection = () => {
    const selected = services.palette.selected();
    services.promptDraft = "";
    services.startupOverlay = "none";
    if (selected && openHomeOverlayForCommand(selected.slash)) {
      return;
    }
    if (selected) void handleSubmit(selected.slash);
  };
  const executeSlashSelection = () => {
    const commands = slashCommands(services);
    const selected = commands[Math.max(0, Math.min(services.slashIndex, commands.length - 1))];
    services.promptDraft = "";
    services.startupOverlay = "none";
    if (selected) {
      textarea.clear();
      if (openHomeOverlayForCommand(selected.slash)) {
        return;
      }
      void handleSubmit(selected.slash);
    }
  };
  const updateSlashScroll = (commands: ReturnType<typeof slashCommands>) => {
    const maxStart = Math.max(0, commands.length - SLASH_COMMAND_LIMIT);
    if (services.slashIndex < services.slashScrollIndex) {
      services.slashScrollIndex = services.slashIndex;
    } else if (services.slashIndex >= services.slashScrollIndex + SLASH_COMMAND_LIMIT) {
      services.slashScrollIndex = services.slashIndex - SLASH_COMMAND_LIMIT + 1;
    }
    services.slashScrollIndex = Math.max(0, Math.min(services.slashScrollIndex, maxStart));
  };
  const moveSlashSelection = (delta: -1 | 1): boolean => {
    if (services.startupOverlay !== "slashCommands") return false;
    const commands = slashCommands(services);
    services.slashIndex = commands.length === 0 ? 0 : (services.slashIndex + delta + commands.length) % commands.length;
    updateSlashScroll(commands);
    rebuildHome();
    return true;
  };
  const executeProviderSelection = () => {
    if (!runtime.config) return;
    const providers = providerPickerEntries(runtime, services.promptDraft);
    const selected = providers[Math.max(0, Math.min(services.pickerIndex, providers.length - 1))];
    services.promptDraft = "";
    if (selected) {
      textarea.clear();
      services.modelProviderFilter = selected[0];
      services.pickerIndex = selectedModelIndexForProvider(runtime, selected[0]);
      showOverlay("models");
    }
  };
  const executeModelSelection = async () => {
    if (!runtime.config) return;
    const models = modelPickerEntriesForProvider(runtime, services.modelProviderFilter);
    const selected = models[Math.max(0, Math.min(services.pickerIndex, models.length - 1))];
    services.promptDraft = "";
    if (selected) {
      textarea.clear();
      const response = await handleModelCommand(`/model ${selected[0]}`, {
        config: runtime.config,
        configPath: DEFAULT_CONFIG_PATH,
        state: runtime.state,
        noColor: true,
        onConfigUpdated: config => {
          refreshRuntimeFromConfig(runtime, config);
          services.toasts.push("success", "Model config updated.");
        }
      });
      if (response.startsWith("Error:")) {
        services.toasts.push("error", response);
        showOverlay("toasts");
        return;
      }
      services.modelProviderFilter = undefined;
      services.startupOverlay = "none";
      rebuildHome();
    }
  };
  const syncSlashOverlay = () => {
    const draft = textarea.plainText;
    services.promptDraft = draft;
    const query = slashQuery(draft);
    if (query === undefined) {
      if (services.startupOverlay === "providers") {
        const providers = providerPickerEntries(runtime, services.promptDraft);
        services.pickerIndex = providers.length === 0 ? 0 : Math.min(services.pickerIndex, providers.length - 1);
        rebuildHome();
        return;
      }
      if (services.startupOverlay === "slashCommands") showOverlay("none");
      return;
    }
    const commands = slashCommands(services);
    services.slashIndex = Math.max(0, Math.min(services.slashIndex, Math.max(0, commands.length - 1)));
    updateSlashScroll(commands);
    showOverlay("slashCommands");
  };
  const unregisterSlashNavigationLayer = keymap.registerLayer({
    priority: 100,
    commands: [
      {
        name: "prompt.slash.previous",
        desc: "Previous slash command",
        run() {
          return moveSlashSelection(-1);
        }
      },
      {
        name: "prompt.slash.next",
        desc: "Next slash command",
        run() {
          return moveSlashSelection(1);
        }
      }
    ],
    bindings: [
      { key: "up", cmd: "prompt.slash.previous" },
      { key: "down", cmd: "prompt.slash.next" }
    ]
  });
  renderer.keyInput.on("keypress", key => {
    const inputKey = keyEventToInput(key);
    if (services.startupOverlay === "whichkey") {
      const command = commandForKey(services, inputKey);
      key.preventDefault();
      key.stopPropagation();
      if (command === "command_palette") showOverlay("palette");
      else if (command === "theme_picker") showOverlay("themes");
      else if (command === "model_picker") showOverlay("models");
      else if (command === "session_list") showOverlay("sessions");
      else if (command === "status") void handleSubmit("/status");
      else if (command === "session_new") void handleSubmit("/new");
      else if (command === "app_exit") exit();
      else showOverlay("none");
      return;
    }
    if (services.tuiConfig.leader && inputKey === services.tuiConfig.leader) {
      key.preventDefault();
      key.stopPropagation();
      showOverlay("whichkey");
      return;
    }
    if (key.name === "up" && services.startupOverlay === "slashCommands") {
      key.preventDefault();
      key.stopPropagation();
      moveSlashSelection(-1);
      return;
    }
    if (key.name === "down" && services.startupOverlay === "slashCommands") {
      key.preventDefault();
      key.stopPropagation();
      moveSlashSelection(1);
      return;
    }
    if (key.name === "return" && services.startupOverlay === "slashCommands") {
      key.preventDefault();
      key.stopPropagation();
      executeSlashSelection();
      return;
    }
    if (key.name === "up" && services.startupOverlay === "providers") {
      key.preventDefault();
      key.stopPropagation();
      const providers = providerPickerEntries(runtime, services.promptDraft);
      services.pickerIndex = providers.length === 0 ? 0 : (services.pickerIndex - 1 + providers.length) % providers.length;
      rebuildHome();
      return;
    }
    if (key.name === "down" && services.startupOverlay === "providers") {
      key.preventDefault();
      key.stopPropagation();
      const providers = providerPickerEntries(runtime, services.promptDraft);
      services.pickerIndex = providers.length === 0 ? 0 : (services.pickerIndex + 1) % providers.length;
      rebuildHome();
      return;
    }
    if (key.name === "return" && services.startupOverlay === "providers") {
      key.preventDefault();
      key.stopPropagation();
      executeProviderSelection();
      return;
    }
    if (key.name === "up" && services.startupOverlay === "models") {
      key.preventDefault();
      key.stopPropagation();
      const models = modelPickerEntriesForProvider(runtime, services.modelProviderFilter);
      services.pickerIndex = models.length === 0 ? 0 : (services.pickerIndex - 1 + models.length) % models.length;
      rebuildHome();
      return;
    }
    if (key.name === "down" && services.startupOverlay === "models") {
      key.preventDefault();
      key.stopPropagation();
      const models = modelPickerEntriesForProvider(runtime, services.modelProviderFilter);
      services.pickerIndex = models.length === 0 ? 0 : (services.pickerIndex + 1) % models.length;
      rebuildHome();
      return;
    }
    if (key.name === "return" && services.startupOverlay === "models") {
      key.preventDefault();
      key.stopPropagation();
      void executeModelSelection();
      return;
    }
    if (key.name === "up" && services.startupOverlay === "palette") {
      key.preventDefault();
      key.stopPropagation();
      services.palette.move(-1);
      rebuildHome();
      return;
    }
    if (key.name === "down" && services.startupOverlay === "palette") {
      key.preventDefault();
      key.stopPropagation();
      services.palette.move(1);
      rebuildHome();
      return;
    }
    if (key.name === "return" && services.startupOverlay === "palette") {
      key.preventDefault();
      key.stopPropagation();
      executePaletteSelection();
      return;
    }
    if (key.name === "escape") {
      services.dialogs.close();
      services.promptDraft = services.startupOverlay === "slashCommands" ? "" : textarea.plainText;
      if (services.startupOverlay === "slashCommands") textarea.clear();
      showOverlay("none");
      return;
    }
    if (!key.ctrl && !key.meta) setImmediate(syncSlashOverlay);
  });
  rebuildHome();

  await new Promise<void>(resolve => {
    renderer.once("destroy", () => {
      unregisterSlashNavigationLayer();
      unregisterTextareaLayer();
      unregisterBaseLayout();
      resolve();
    });
  });
}

if (require.main === module) {
  void runTui();
}
