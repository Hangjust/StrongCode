import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { Agent } from "../agents/agent";
import { AgentRunner } from "../agents/runner";
import { DEFAULT_CONFIG_PATH } from "../config/load";
import { persistConfigUpdate, selectModel } from "../config/save";
import { StrongCodeConfig } from "../config/schema";
import { orderedProviders } from "../models/registry";
import { ProviderAuth, ProviderAuthStore } from "../models/auth-store";
import { createProviderCatalog } from "../models/catalog";
import { buildModelsUrl, discoverOpenAICompatibleModels, globalFetchTransport } from "../models/discovery";
import { ProviderAuthMethodDetail, ProviderService } from "../models/provider-service";
import { requireRuntime, createAgent } from "../runtime/factory";
import { SessionStore } from "../sessions/session-store";
import { createDefaultToolRegistry } from "../tools/registry";
import { TuiState, sanitizeDisplayValue } from "./render";
import { clipDisplayLine, renderAllModelList, renderHomeWithPrompt, renderSessionLayout } from "./render";
import { handleConnectCommand } from "./commands";
import { loadTuiConfig, TuiConfig } from "./config/tui";
import { describeKeybinds, TuiKeybindCommand } from "./config/keybind";
import { createDefaultPalette } from "./ui/palette";
import { DialogManager } from "./ui/dialog";
import { ToastManager } from "./ui/toast";
import { PromptHistory, PromptHistoryStore } from "./component/prompt/history";
import { TuiRouter } from "./route";
import { createBuiltinPluginRuntime, TuiPluginRuntime } from "./plugin";
import { renderDialogOverlay, renderPaletteOverlay, renderSlashCommandOverlay } from "./ui/overlay";
import { renderApprovalSurface, renderDiffSurface, renderEditorPasteSurface, renderPickerSurface, renderSidebarPanel, renderStatusDashboard, renderThemePicker } from "./ui/surfaces";
import { createSolidShellDescriptor, SolidShellNode } from "./solid/shell";
import { writeClipboard } from "./util/clipboard";

type OpenTuiCore = typeof import("@opentui/core");
type OpenTuiRenderer = InstanceType<OpenTuiCore["CliRenderer"]>;
type OpenTuiRoot = OpenTuiRenderer["root"];
type OpenTuiBox = InstanceType<OpenTuiCore["BoxRenderable"]>;
type OpenTuiText = InstanceType<OpenTuiCore["TextRenderable"]>;
type OpenTuiInput = InstanceType<OpenTuiCore["InputRenderable"]>;
type OpenTuiTextarea = InstanceType<OpenTuiCore["TextareaRenderable"]>;
type OpenTuiScrollBox = InstanceType<OpenTuiCore["ScrollBoxRenderable"]>;
type OpenTuiDialogFocus = OpenTuiBox | OpenTuiInput | OpenTuiTextarea;
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
type ClipboardSelection = {
  getSelectedText(): string;
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
const HOME_PROMPT_WIDTH = LOGO_WIDTH;

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
      state.providerDisplayName = runtime.config.providers[modelConfig.provider]?.displayName;
      state.model = agentConfig.model;
      state.modelDisplayName = modelConfig.displayName;
      state.defaultAgent = agentName;
      state.workspace = runtime.config.workspace;
      state.dataDir = runtime.config.dataDir;
      agent = createAgent(runtime.config, runtime.config.defaultAgent, { authStore: new ProviderAuthStore(runtime.context.dataDir) });
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
        if (await handleSystemCommand(value, runtime, services, append, close)) {
          config = runtime.config;
          agent = runtime.agent;
      return;
        }
        if (value === "/connect" || value.startsWith("/connect ")) {
          const response = await handleConnectCommand(value, { config, configPath, state, noColor: true, onConfigUpdated: updated => { refreshRuntimeFromConfig(runtime, updated); config = runtime.config; agent = runtime.agent; services.toasts.push("success", "Provider connected."); } });
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
  startupOverlay: "none" | "palette" | "slashCommands" | "whichkey" | "themes" | "models" | "providers" | "providerAuthMethod" | "providerAuth" | "sessions" | "toasts";
  pickerIndex: number;
  slashIndex: number;
  slashScrollIndex: number;
  promptDraft: string;
  providerQuery: string;
  authInputDraft: string;
  providerAuth: Record<string, ProviderAuth>;
  modelProviderFilter?: string;
  authProviderId?: string;
  authProviderTitle?: string;
  customProviderForm: CustomProviderFormState;
}

interface CustomProviderFormState {
  providerId: string;
  displayName: string;
  baseUrl: string;
  apiKey: string;
  focusIndex: number;
  selectedModelIndex: number;
  discovery: CustomProviderDiscoveryState;
  cursorOffsets: Partial<Record<CustomProviderFormField, number>>;
}

interface CustomProviderDiscoveryState {
  status: "idle" | "loading" | "ready" | "error";
  models: string[];
  selectedModels: string[];
  error?: string;
}

type CustomProviderFormField = "providerId" | "displayName" | "baseUrl" | "apiKey";

const CUSTOM_PROVIDER_FORM_FIELDS: Array<{ key: CustomProviderFormField; label: string; placeholder: string; helper?: string; secret?: boolean }> = [
  { key: "providerId", label: "Provider ID", placeholder: "myprovider", helper: "Lowercase letters, numbers, hyphens, or underscores" },
  { key: "displayName", label: "Display name", placeholder: "My AI Provider" },
  { key: "baseUrl", label: "Base URL", placeholder: "https://api.myprovider.com/v1" },
  { key: "apiKey", label: "API key", placeholder: "API key", secret: true }
];
const CUSTOM_PROVIDER_DISCOVER_INDEX = CUSTOM_PROVIDER_FORM_FIELDS.length;
const CUSTOM_PROVIDER_FOCUS_COUNT = CUSTOM_PROVIDER_FORM_FIELDS.length + 1;

function defaultCustomProviderDiscovery(): CustomProviderDiscoveryState {
  return {
    status: "idle",
    models: [],
    selectedModels: []
  };
}

function defaultCustomProviderForm(): CustomProviderFormState {
  return {
    providerId: "custom",
    displayName: "Custom Provider",
    baseUrl: "",
    apiKey: "",
    focusIndex: 0,
    selectedModelIndex: 0,
    discovery: defaultCustomProviderDiscovery(),
    cursorOffsets: {}
  };
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
    promptDraft: "",
    providerQuery: "",
    authInputDraft: "",
    providerAuth: dataDir ? await new ProviderAuthStore(dataDir).all() : {},
    customProviderForm: defaultCustomProviderForm()
  };
}

interface ProviderDialogOption {
  id: string;
  title: string;
  description: string;
  category: "Popular" | "Providers";
  connected: boolean;
  footer?: string;
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

export function providerPickerDescription(providerId: string): string {
  return {
    openai: "(ChatGPT Plus/Pro or API key)",
    anthropic: "(API key)",
    kimi: "(Moonshot API key)",
    grok: "(xAI API key)",
    mock: "(local mock provider)",
    custom: "(OpenAI-compatible custom provider)"
  }[providerId] ?? "";
}

export function providerDialogTitle(providerId: string, displayName: string): string {
  return providerId === "custom" ? "Custom Provider" : displayName;
}

function providerDialogCategory(providerId: string): ProviderDialogOption["category"] {
  return ["openai", "custom", "anthropic", "mock"].includes(providerId) ? "Popular" : "Providers";
}

export function providerPickerPriority(providerId: string): number {
  return {
    openai: 0,
    custom: 1,
    kimi: 2,
    anthropic: 3,
    grok: 4,
    mock: 5
  }[providerId] ?? 99;
}

export function isValidCustomProviderId(providerId: string): boolean {
  return /^[a-z0-9_-]+$/.test(providerId);
}

export function apiKeyEnvForProviderId(providerId: string): string {
  return `${providerId.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase()}_API_KEY`;
}

function customProviderFormFromConfig(config: StrongCodeConfig | undefined, providerId = "custom", auth?: ProviderAuth): CustomProviderFormState {
  void auth;
  const provider = config?.providers[providerId];
  return {
    providerId,
    displayName: provider?.displayName ?? "Custom Provider",
    baseUrl: provider?.baseUrl ?? "",
    apiKey: "",
    focusIndex: 0,
    selectedModelIndex: 0,
    discovery: defaultCustomProviderDiscovery(),
    cursorOffsets: {}
  };
}

export function activeCustomProviderModelRows(models: string[], selectedModels: string[] = models): string[] {
  const selected = new Set(selectedModels);
  return models.map(model => `${selected.has(model) ? "●" : "○"} ${sanitizeDisplayValue(model, "unknown")}`);
}

export function toggleCustomProviderSelectedModel(models: string[], selectedModels: string[], modelId: string): string[] {
  if (!models.includes(modelId)) return selectedModels.filter(model => models.includes(model));
  const selected = new Set(selectedModels.filter(model => models.includes(model)));
  if (selected.has(modelId)) selected.delete(modelId);
  else selected.add(modelId);
  return models.filter(model => selected.has(model));
}

export function selectedCustomProviderModels(models: string[], selectedModels: string[]): string[] {
  const selected = new Set(selectedModels);
  return models.filter(model => selected.has(model));
}

function loadingDots(frame = 0): string {
  const dots = [".", "..", "..."];
  return dots[frame % dots.length];
}

export function customProviderFetchingModelsText(frame = 0): string {
  return `Fetching models${loadingDots(frame)}`;
}

export function customProviderEndpointLoadingText(frame = 0): string {
  return `Calling endpoint${loadingDots(frame)}`;
}

export function shouldAutoDiscoverCustomProviderModels(baseUrl: string, apiKey: string): boolean {
  return baseUrl.trim().length > 0 && apiKey.trim().length > 0;
}

export function customProviderCursorOffset(value: string, savedOffset: number | undefined): number {
  return Math.max(0, Math.min(savedOffset ?? value.length, value.length));
}

export function shouldRefreshCustomProviderDiscoveryPanel(startupOverlay: string, authProviderId: string | undefined, focusIndex: number): boolean {
  return startupOverlay === "providerAuth" && authProviderId === "custom" && focusIndex === CUSTOM_PROVIDER_DISCOVER_INDEX;
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
    })
    .sort(([leftId, left], [rightId, right]) => {
      const priorityDelta = providerPickerPriority(leftId) - providerPickerPriority(rightId);
      if (priorityDelta !== 0) return priorityDelta;
      return sanitizeDisplayValue(left.displayName, leftId).localeCompare(sanitizeDisplayValue(right.displayName, rightId));
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

function providerDialogOptions(runtime: RuntimeState, services: TuiServices, query = ""): ProviderDialogOption[] {
  if (!runtime.config) return [];
  const catalog = createProviderCatalog(runtime.config, services.providerAuth);
  const catalogByProvider = new Map(catalog.all.map(provider => [provider.id, provider]));
  const providers = providerPickerEntries(runtime, query);
  return providers.map(([providerId, provider]): ProviderDialogOption => {
    const displayName = sanitizeDisplayValue(provider.displayName, providerId);
    const catalogProvider = catalogByProvider.get(providerId);
    const apiKeyEnv = provider.apiKeyEnv ? sanitizeDisplayValue(provider.apiKeyEnv, "unknown") : undefined;
    const connectedByAuth = Boolean(catalogProvider?.connected && provider.apiKeyEnv && !process.env[provider.apiKeyEnv]);
    return {
      id: providerId,
      title: providerDialogTitle(providerId, displayName),
      description: sanitizeDisplayValue(providerPickerDescription(providerId), providerId),
      category: providerDialogCategory(providerId),
      connected: catalogProvider?.connected ?? provider.enabled !== false,
      footer: connectedByAuth ? "auth.json" : provider.apiKeyEnv && process.env[provider.apiKeyEnv] ? `env ${apiKeyEnv}` : undefined
    };
  });
}

export function providerAuthOverlayForMethods(methods: ProviderAuthMethodDetail[]): TuiServices["startupOverlay"] | undefined {
  if (methods.length > 1) return "providerAuthMethod";
  if (methods.some(method => method.type === "api")) return "providerAuth";
  return undefined;
}

export function connectCommandForProviderAuthMethod(providerId: string, method: ProviderAuthMethodDetail): string | undefined {
  if (providerId === "openai" && method.type === "oauth") return `/connect ${providerId} chatgpt-browser`;
  return undefined;
}

function authStoreForConfig(config: StrongCodeConfig, configPath = DEFAULT_CONFIG_PATH): ProviderAuthStore {
  return new ProviderAuthStore(path.resolve(path.dirname(path.resolve(configPath)), config.dataDir));
}

function providerAuthMethods(runtime: RuntimeState, providerId: string): ProviderAuthMethodDetail[] {
  if (!runtime.config) return [];
  const service = new ProviderService(runtime.config, authStoreForConfig(runtime.config, runtime.state.configPath));
  return service.authMethods()[providerId] ?? [];
}

async function reloadProviderAuth(runtime: RuntimeState, services: TuiServices): Promise<void> {
  services.providerAuth = runtime.config ? await authStoreForConfig(runtime.config, runtime.state.configPath).all() : {};
}

async function refreshAuthenticatedProviderModels(runtime: RuntimeState): Promise<string[]> {
  if (!runtime.config) return [];
  const providerId = runtime.state.provider && runtime.state.provider !== "N/A" ? runtime.state.provider : "mock";
  const provider = runtime.config.providers[providerId];
  if (!provider || provider.type === "mock" || !provider.baseUrl) return [];

  try {
    const authStore = authStoreForConfig(runtime.config, runtime.state.configPath);
    const discovered = await discoverOpenAICompatibleModels({
      id: providerId,
      type: provider.type,
      displayName: provider.displayName,
      apiKeyEnv: provider.apiKeyEnv,
      baseUrl: provider.baseUrl,
      modelsEndpoint: provider.modelsEndpoint,
      enabled: provider.enabled,
      authStore
    }, globalFetchTransport());
    if (discovered.length === 0) return [];

    const updated = await persistConfigUpdate({ path: runtime.state.configPath, directory: "", config: runtime.config }, config => {
      const models = { ...config.models };
      for (const model of discovered) {
        const existing = models[model.id];
        models[model.id] = {
          provider: providerId,
          model: model.id,
          displayName: existing?.displayName ?? model.displayName,
          enabled: existing?.enabled ?? model.enabled,
          source: existing?.source ?? model.source,
          options: existing?.options
        };
      }
      return { ...config, models };
    });
    refreshRuntimeFromConfig(runtime, updated);
    return [];
  } catch (error) {
    return [`Model refresh failed: ${error instanceof Error ? error.message : String(error)}`];
  }
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

export function navigationKeyName(name: string): "up" | "down" | "return" | "escape" | undefined {
  const normalized = name.toLowerCase();
  if (normalized === "up" || normalized === "arrowup" || normalized === "arrow_up" || normalized === "uparrow") return "up";
  if (normalized === "down" || normalized === "arrowdown" || normalized === "arrow_down" || normalized === "downarrow") return "down";
  if (normalized === "return" || normalized === "enter") return "return";
  if (normalized === "escape" || normalized === "esc") return "escape";
  return undefined;
}

export function nextSelectionIndex(currentIndex: number, length: number, delta: -1 | 1): number {
  return length === 0 ? 0 : (currentIndex + delta + length) % length;
}

export function selectedSlashCommand<T extends { slash: string }>(commands: T[], selectedIndex: number): T | undefined {
  if (commands.length === 0) return undefined;
  return commands[Math.max(0, Math.min(selectedIndex, commands.length - 1))];
}

export function scrollTopForSelectedRow(selectedRowIndex: number, viewportHeight: number): number {
  return Math.max(0, selectedRowIndex - Math.max(1, viewportHeight) + 1);
}

export function slashOverlayTop(promptTop: number, overlayHeight: number): number {
  return Math.max(0, promptTop - Math.max(1, overlayHeight));
}

export function providerDialogSelectedRowIndex(options: Array<{ category: string }>, selectedIndex: number): number {
  const clampedIndex = Math.max(0, Math.min(selectedIndex, options.length - 1));
  let category = "";
  let rowIndex = 0;

  for (const [index, option] of options.entries()) {
    if (option.category !== category) {
      category = option.category;
      rowIndex++;
    }
    if (index === clampedIndex) return rowIndex;
    rowIndex++;
  }

  return 0;
}

export function providerDialogRowCount(options: Array<{ category: string }>): number {
  let category = "";
  let rows = 0;

  for (const option of options) {
    if (option.category !== category) {
      category = option.category;
      rows++;
    }
    rows++;
  }

  return rows;
}

function keepDialogRowVisible(renderer: OpenTuiRenderer, scroll: OpenTuiScrollBox, selectedRowIndex: number, viewportHeight: number, topPaddingRows = 0): void {
  const scrollTop = scrollTopForSelectedRow(selectedRowIndex + topPaddingRows, viewportHeight);
  scroll.scrollTop = scrollTop;
  setImmediate(() => {
    scroll.scrollTop = scrollTop;
    renderer.requestRender();
  });
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
  if (value === "/connect") return "providers";
  if (value === "/model" || value === "/models") return "models";
  return undefined;
}

export function draftHomeCommandOverlay(value: string): TuiServices["startupOverlay"] | undefined {
  void value;
  return undefined;
}

export function shouldSubmitHomePrompt(startupOverlay: string): boolean {
  return startupOverlay === "none";
}

export function shouldSubmitHomeValue(startupOverlay: string, value: string): boolean {
  return shouldSubmitHomePrompt(startupOverlay) || (startupOverlay === "slashCommands" && exactHomeCommandOverlay(value) !== undefined);
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
  if (services.startupOverlay === "providers") return "";
  if (services.startupOverlay === "providerAuthMethod") return "";
  if (services.startupOverlay === "providerAuth") return "";
  if (services.startupOverlay === "sessions") return "Session Picker\nUse the configured session list keybind to load saved sessions.";
  if (services.startupOverlay === "toasts") return services.toasts.list().length > 0 ? services.toasts.render() : "No toasts yet.";
  return renderPaletteOverlay(services.palette.list(), services.palette.cursor());
}

export function isProviderPopupOverlay(startupOverlay: string): boolean {
  return startupOverlay === "providers" || startupOverlay === "providerAuthMethod" || startupOverlay === "providerAuth" || startupOverlay === "models";
}

function isOpenCodeDialogOverlay(services: TuiServices): boolean {
  return isProviderPopupOverlay(services.startupOverlay);
}

function providerAuthDescription(providerId: string | undefined): string | undefined {
  if (providerId === "openai") return "Paste an OpenAI API key. StrongCode stores API keys only.";
  if (providerId === "custom") return "Paste a custom provider API key and configure its base URL below.";
  return undefined;
}

export function promptDraftAfterEscape(startupOverlay: string, currentPrompt: string): string {
  if (startupOverlay === "slashCommands" || startupOverlay === "providerAuthMethod" || startupOverlay === "providerAuth") return "";
  return currentPrompt;
}

export function selectedTextForClipboard(selection: ClipboardSelection | null | undefined): string | undefined {
  const text = selection?.getSelectedText() ?? "";
  return text.length > 0 ? text : undefined;
}

export function shouldCopySelectionForInput(inputKey: string, selectedText: string | undefined): boolean {
  return inputKey === "ctrl+c" && selectedText !== undefined;
}

export function shouldCopySelectionForMouse(event: { type: string; button: number }, rightButton: number, selectedText: string | undefined): boolean {
  return event.type === "down" && event.button === rightButton && selectedText !== undefined;
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
  runtime.state.providerDisplayName = config.providers[modelConfig.provider]?.displayName;
  runtime.state.model = agentConfig.model;
  runtime.state.modelDisplayName = modelConfig.displayName;
  runtime.state.defaultAgent = config.defaultAgent;
  try {
    runtime.agent = createAgent(config, config.defaultAgent, { authStore: authStoreForConfig(config, runtime.state.configPath) });
  } catch {
    runtime.agent = undefined;
  }
}

async function handleSystemCommand(input: string, runtime: RuntimeState, services: TuiServices, append: (role: "assistant" | "system", text: string) => void | Promise<void>, exit: () => void): Promise<boolean> {
  if (input === "/exit" || input === "exit" || input === "quit") {
    exit();
    return true;
  }
  if (input === "/connect" || input.startsWith("/connect ")) {
    const response = await handleConnectCommand(input, {
      config: runtime.config,
      configPath: DEFAULT_CONFIG_PATH,
      state: runtime.state,
      noColor: true,
      onConfigUpdated: config => {
        refreshRuntimeFromConfig(runtime, config);
        services.toasts.push("success", "Provider connected.");
      }
    });
    await reloadProviderAuth(runtime, services);
    append("system", response);
    return true;
  }
  if (input === "/model" || input === "/models") {
    const failures = await refreshAuthenticatedProviderModels(runtime);
    const failureOutput = failures.length > 0 ? `${failures.map(failure => clipDisplayLine(failure)).join("\n")}\n` : "";
    append("system", runtime.config ? `${failureOutput}${renderAllModelList(runtime.config, runtime.state, true)}` : "Config missing. Run 'strongcode init' first.");
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
  state.providerDisplayName = runtime.config.providers[modelConfig.provider]?.displayName;
  state.model = agentConfig.model;
  state.modelDisplayName = modelConfig.displayName;
  state.defaultAgent = agentName;
  state.workspace = runtime.config.workspace;
  state.dataDir = runtime.config.dataDir;

  return {
    state,
    config: runtime.config,
    agent: createAgent(runtime.config, runtime.config.defaultAgent, { authStore: new ProviderAuthStore(runtime.context.dataDir) }),
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
  const model = promptStatusLabel(state.model, "mock");
  const modelDisplay = promptStatusLabel(state.modelDisplayName, model);
  const modelLabel = modelDisplay !== model ? `${modelDisplay} (${model})` : model;
  return clipDisplayLine(`Strong Code · ${modelLabel}`, 71);
}

interface PromptElements {
  textarea: OpenTuiTextarea;
  anchor: OpenTuiBox;
}

function createPrompt(core: OpenTuiCore, renderer: OpenTuiRenderer, parent: OpenTuiBox, state: TuiState, initialValue: string, onSubmit: (value: string) => void, onContentChange?: () => void): PromptElements {
  const promptOuter = new core.BoxRenderable(renderer, {
    width: HOME_PROMPT_WIDTH,
    height: 7,
    flexDirection: "row",
    flexShrink: 0
  });
  parent.add(promptOuter);

  const accent = new core.BoxRenderable(renderer, {
    width: 1,
    height: 6,
    backgroundColor: COLORS.primary,
    flexShrink: 0
  });
  promptOuter.add(accent);

  const promptPanel = new core.BoxRenderable(renderer, {
    flexGrow: 1,
    minWidth: 0,
    height: 6,
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
    height: 4,
    initialValue,
    placeholder: "Ask anything... \"Fix a TODO in the codebase\"  / for commands",
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
  
  return { textarea, anchor: promptOuter };
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
    width: HOME_PROMPT_WIDTH,
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

interface ProviderDialogCallbacks {
  onProviderSelect(index: number): void;
  onProviderQueryChange(): void;
  onProviderAuthMethodSelect(index: number): void;
  onProviderAuthSubmit(value: string): void;
  onCustomProviderFieldFocus(index: number): void;
  onCustomProviderFieldChange(field: CustomProviderFormField): void;
  onCustomProviderDiscover(): void;
  onCustomProviderModelToggle(index: number): void;
  onCustomProviderSubmit(): void;
  onModelSelect(index: number): void;
}

function addDialogFrame(core: OpenTuiCore, renderer: OpenTuiRenderer, parent: OpenTuiBox, title: string, width = 60): OpenTuiBox {
  const modal = new core.BoxRenderable(renderer, {
    width,
    maxWidth: width,
    flexDirection: "column",
    backgroundColor: COLORS.panel,
    paddingTop: 1,
    paddingBottom: 1,
    focusable: true,
    flexShrink: 0
  });
  parent.add(modal);

  const header = new core.BoxRenderable(renderer, {
    width: "100%",
    height: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingLeft: 4,
    paddingRight: 4,
    backgroundColor: COLORS.panel
  });
  modal.add(header);
  header.add(new core.TextRenderable(renderer, { content: title, fg: COLORS.text, bg: COLORS.panel, height: 1 }));
  header.add(new core.TextRenderable(renderer, { content: "esc", fg: COLORS.muted, bg: COLORS.panel, height: 1 }));
  return modal;
}

function addDialogEmptyState(core: OpenTuiCore, renderer: OpenTuiRenderer, parent: OpenTuiBox | OpenTuiScrollBox, message: string): void {
  const row = new core.BoxRenderable(renderer, { width: "100%", height: 1, paddingLeft: 4, paddingRight: 4, backgroundColor: COLORS.panel });
  row.add(new core.TextRenderable(renderer, { content: message, fg: COLORS.muted, bg: COLORS.panel, height: 1 }));
  parent.add(row);
}

function addProviderSelectDialog(core: OpenTuiCore, renderer: OpenTuiRenderer, parent: OpenTuiBox, runtime: RuntimeState, services: TuiServices, callbacks: ProviderDialogCallbacks): OpenTuiInput | undefined {
  const modal = addDialogFrame(core, renderer, parent, "Connect a provider");
  const filterBox = new core.BoxRenderable(renderer, { width: "100%", height: 2, paddingLeft: 4, paddingRight: 4, paddingTop: 1, backgroundColor: COLORS.panel });
  modal.add(filterBox);

  let input!: OpenTuiInput;
  input = new core.InputRenderable(renderer, {
    width: "100%",
    value: services.providerQuery,
    placeholder: "Search",
    backgroundColor: COLORS.panel,
    focusedBackgroundColor: COLORS.panel,
    textColor: COLORS.text,
    focusedTextColor: COLORS.text,
    placeholderColor: COLORS.muted,
    cursorColor: COLORS.primary,
    onContentChange: () => {
      services.providerQuery = input.plainText;
      const providers = providerPickerEntries(runtime, services.providerQuery);
      services.pickerIndex = providers.length === 0 ? 0 : Math.min(services.pickerIndex, providers.length - 1);
      setImmediate(callbacks.onProviderQueryChange);
    }
  });
  input.traits = { status: "FILTER" };
  input.cursorOffset = services.providerQuery.length;
  filterBox.add(input);

  const options = providerDialogOptions(runtime, services, services.providerQuery);
  const rows = providerDialogRowCount(options);
  const viewportHeight = Math.max(1, Math.min(12, rows));
  const scroll = new core.ScrollBoxRenderable(renderer, {
    width: "100%",
    height: viewportHeight,
    scrollY: true,
    scrollbarOptions: { visible: false },
    backgroundColor: COLORS.panel,
    paddingLeft: 1,
    paddingRight: 1
  });
  modal.add(scroll);

  if (options.length === 0) {
    addDialogEmptyState(core, renderer, scroll, "No results found");
    return input;
  }

  let category = "";
  let rowIndex = 0;
  const selectedRowIndex = providerDialogSelectedRowIndex(options, services.pickerIndex);
  options.forEach((option, index) => {
    if (option.category !== category) {
      category = option.category;
      const header = new core.BoxRenderable(renderer, { width: "100%", height: 1, paddingLeft: 3, paddingTop: index > 0 ? 1 : 0, backgroundColor: COLORS.panel });
      header.add(new core.TextRenderable(renderer, { content: category, fg: COLORS.primary, bg: COLORS.panel, height: 1 }));
      scroll.add(header);
      rowIndex++;
    }
    const selected = index === services.pickerIndex;
    const background = selected ? COLORS.primary : COLORS.panel;
    const foreground = selected ? COLORS.background : COLORS.text;
    const muted = selected ? COLORS.background : COLORS.muted;
    const row = new core.BoxRenderable(renderer, {
      id: `provider-${option.id}`,
      width: "100%",
      height: 1,
      flexDirection: "row",
      paddingLeft: option.connected ? 1 : 3,
      paddingRight: 3,
      backgroundColor: background,
      onMouseDown: () => {
        services.pickerIndex = index;
        callbacks.onProviderQueryChange();
      },
      onMouseUp: () => callbacks.onProviderSelect(index)
    });
    if (option.connected) row.add(new core.TextRenderable(renderer, { content: "✓", fg: selected ? foreground : COLORS.success, bg: background, width: 2, height: 1 }));
    row.add(new core.TextRenderable(renderer, { content: `${option.title}${option.description ? ` ${option.description}` : ""}`, fg: foreground, bg: background, height: 1, width: option.footer ? 42 : 52, wrapMode: "none" }));
    if (option.footer) row.add(new core.TextRenderable(renderer, { content: option.footer, fg: muted, bg: background, height: 1, width: 10, wrapMode: "none" }));
    scroll.add(row);
    rowIndex++;
  });

  keepDialogRowVisible(renderer, scroll, selectedRowIndex, viewportHeight);
  return input;
}

function addProviderAuthDialog(core: OpenTuiCore, renderer: OpenTuiRenderer, parent: OpenTuiBox, services: TuiServices, callbacks: ProviderDialogCallbacks): OpenTuiTextarea {
  const modal = addDialogFrame(core, renderer, parent, services.authProviderTitle ?? "API key");
  const description = providerAuthDescription(services.authProviderId) ?? "Paste API key below. It is saved to auth.json, not config.";
  const body = new core.BoxRenderable(renderer, { width: "100%", flexDirection: "column", gap: 1, paddingLeft: 2, paddingRight: 2, paddingTop: 1, backgroundColor: COLORS.panel });
  modal.add(body);
  body.add(new core.TextRenderable(renderer, { content: description, fg: COLORS.muted, bg: COLORS.panel, height: 1, wrapMode: "word" }));

  let textarea!: OpenTuiTextarea;
  textarea = new core.TextareaRenderable(renderer, {
    width: "100%",
    height: 3,
    initialValue: services.authInputDraft,
    placeholder: "API key",
    placeholderColor: COLORS.muted,
    textColor: COLORS.text,
    focusedTextColor: COLORS.text,
    backgroundColor: COLORS.element,
    focusedBackgroundColor: COLORS.element,
    cursorColor: COLORS.primary,
    wrapMode: "none",
    onContentChange: () => {
      services.authInputDraft = textarea.plainText;
    },
    onSubmit: () => callbacks.onProviderAuthSubmit(textarea.plainText)
  });
  textarea.cursorOffset = services.authInputDraft.length;
  body.add(textarea);
  const footer = new core.BoxRenderable(renderer, { width: "100%", height: 1, flexDirection: "row", paddingBottom: 1, backgroundColor: COLORS.panel });
  footer.add(new core.TextRenderable(renderer, { content: "enter", fg: COLORS.text, bg: COLORS.panel, height: 1 }));
  footer.add(new core.TextRenderable(renderer, { content: " submit", fg: COLORS.muted, bg: COLORS.panel, height: 1 }));
  body.add(footer);
  return textarea;
}

function addFormInput(core: OpenTuiCore, renderer: OpenTuiRenderer, parent: OpenTuiBox | OpenTuiScrollBox, services: TuiServices, callbacks: ProviderDialogCallbacks, field: typeof CUSTOM_PROVIDER_FORM_FIELDS[number], index: number): OpenTuiInput {
  const selected = services.customProviderForm.focusIndex === index;
  const label = new core.BoxRenderable(renderer, {
    width: "100%",
    height: 1,
    paddingLeft: 0,
    backgroundColor: COLORS.panel,
    onMouseDown: () => callbacks.onCustomProviderFieldFocus(index)
  });
  parent.add(label);
  label.add(new core.TextRenderable(renderer, { content: field.label, fg: selected ? COLORS.text : COLORS.muted, bg: COLORS.panel, height: 1 }));

  const inputBox = new core.BoxRenderable(renderer, {
    width: "100%",
    height: 2,
    paddingLeft: 1,
    paddingRight: 1,
    backgroundColor: COLORS.element,
    border: selected ? true : false,
    borderColor: selected ? COLORS.border : COLORS.element,
    onMouseDown: () => callbacks.onCustomProviderFieldFocus(index),
    onMouseUp: () => callbacks.onCustomProviderFieldFocus(index)
  });
  parent.add(inputBox);

  let input!: OpenTuiInput;
  input = new core.InputRenderable(renderer, {
    width: "100%",
    value: services.customProviderForm[field.key],
    placeholder: field.placeholder,
    backgroundColor: COLORS.element,
    focusedBackgroundColor: COLORS.element,
    textColor: COLORS.text,
    focusedTextColor: COLORS.text,
    placeholderColor: COLORS.muted,
    cursorColor: COLORS.primary,
    onContentChange: () => {
      services.customProviderForm[field.key] = input.plainText;
      services.customProviderForm.cursorOffsets[field.key] = input.cursorOffset;
      callbacks.onCustomProviderFieldChange(field.key);
    }
  });
  input.cursorOffset = customProviderCursorOffset(services.customProviderForm[field.key], services.customProviderForm.cursorOffsets[field.key]);
  inputBox.add(input);

  if (field.helper) {
    const helper = new core.BoxRenderable(renderer, {
      width: "100%",
      height: 1,
      paddingTop: 0,
      backgroundColor: COLORS.panel,
      onMouseDown: () => callbacks.onCustomProviderFieldFocus(index)
    });
    parent.add(helper);
    helper.add(new core.TextRenderable(renderer, { content: field.helper, fg: COLORS.muted, bg: COLORS.panel, height: 1, wrapMode: "none" }));
  }

  return input;
}

function addCustomProviderModelPanel(core: OpenTuiCore, renderer: OpenTuiRenderer, parent: OpenTuiBox, services: TuiServices, callbacks: ProviderDialogCallbacks): OpenTuiBox {
  const discovery = services.customProviderForm.discovery;
  const selected = services.customProviderForm.focusIndex === CUSTOM_PROVIDER_DISCOVER_INDEX;
  const panel = new core.BoxRenderable(renderer, {
    width: 32,
    height: 18,
    flexDirection: "column",
    backgroundColor: COLORS.panel,
    border: ["left"],
    borderColor: COLORS.border,
    paddingLeft: 2,
    paddingRight: 1,
    paddingTop: 1
  });
  parent.add(panel);

  panel.add(new core.TextRenderable(renderer, { content: "Models", fg: COLORS.text, bg: COLORS.panel, height: 1 }));
  panel.add(new core.TextRenderable(renderer, { content: "From Base URL /models", fg: COLORS.muted, bg: COLORS.panel, height: 1, wrapMode: "none" }));

  const buttonBackground = selected ? COLORS.primary : COLORS.element;
  const buttonForeground = selected ? COLORS.background : COLORS.text;
  const button = new core.BoxRenderable(renderer, {
    width: "100%",
    height: 1,
    marginTop: 1,
    paddingLeft: 1,
    backgroundColor: buttonBackground,
    onMouseDown: () => callbacks.onCustomProviderFieldFocus(CUSTOM_PROVIDER_DISCOVER_INDEX),
    onMouseUp: () => callbacks.onCustomProviderDiscover()
  });
  panel.add(button);
  const buttonText = discovery.status === "loading"
    ? new core.TextRenderable(renderer, { content: customProviderFetchingModelsText(), fg: buttonForeground, bg: buttonBackground, height: 1, wrapMode: "none" })
    : new core.TextRenderable(renderer, { content: "Fetch models", fg: buttonForeground, bg: buttonBackground, height: 1, wrapMode: "none" });
  button.add(buttonText);

  if (discovery.status === "idle") {
    panel.add(new core.TextRenderable(renderer, { content: "Enter Base URL and API key, then fetch.", fg: COLORS.muted, bg: COLORS.panel, height: 2, marginTop: 1, wrapMode: "word" }));
    return panel;
  }
  if (discovery.status === "loading") {
    panel.add(new core.TextRenderable(renderer, { content: customProviderEndpointLoadingText(), fg: COLORS.muted, bg: COLORS.panel, height: 1, marginTop: 1 }));
    return panel;
  }
  if (discovery.status === "error") {
    panel.add(new core.TextRenderable(renderer, { content: sanitizeDisplayValue(discovery.error, "Model discovery failed"), fg: COLORS.warning, bg: COLORS.panel, height: 3, marginTop: 1, wrapMode: "word" }));
    return panel;
  }
  if (discovery.models.length === 0) {
    panel.add(new core.TextRenderable(renderer, { content: "No models returned.", fg: COLORS.muted, bg: COLORS.panel, height: 1, marginTop: 1 }));
    return panel;
  }

  const list = new core.ScrollBoxRenderable(renderer, {
    width: "100%",
    height: 10,
    scrollY: true,
    scrollbarOptions: { visible: false },
    backgroundColor: COLORS.panel,
    marginTop: 1
  });
  panel.add(list);
  activeCustomProviderModelRows(discovery.models, discovery.selectedModels).forEach((row, index) => {
    const highlighted = selected && index === services.customProviderForm.selectedModelIndex;
    const background = highlighted ? COLORS.element : COLORS.panel;
    const foreground = highlighted ? COLORS.primary : COLORS.text;
    const marker = row.slice(0, 1);
    const item = new core.BoxRenderable(renderer, {
      width: "100%",
      height: 1,
      flexDirection: "row",
      backgroundColor: background,
      onMouseDown: () => callbacks.onCustomProviderFieldFocus(CUSTOM_PROVIDER_DISCOVER_INDEX),
      onMouseUp: () => callbacks.onCustomProviderModelToggle(index)
    });
    item.add(new core.TextRenderable(renderer, { content: marker, fg: marker === "●" ? COLORS.success : COLORS.muted, bg: background, width: 2, height: 1 }));
    item.add(new core.TextRenderable(renderer, { content: row.slice(2), fg: foreground, bg: background, height: 1, wrapMode: "none" }));
    list.add(item);
  });
  const selectedCount = selectedCustomProviderModels(discovery.models, discovery.selectedModels).length;
  panel.add(new core.TextRenderable(renderer, { content: `${selectedCount}/${discovery.models.length} selected · enter toggles`, fg: COLORS.muted, bg: COLORS.panel, height: 1, marginTop: 1, wrapMode: "none" }));
  return panel;
}

function addCustomProviderFormDialog(core: OpenTuiCore, renderer: OpenTuiRenderer, parent: OpenTuiBox, services: TuiServices, callbacks: ProviderDialogCallbacks): OpenTuiDialogFocus {
  const modal = addDialogFrame(core, renderer, parent, "Custom Provider", 96);
  const body = new core.BoxRenderable(renderer, { width: "100%", height: 20, flexDirection: "row", backgroundColor: COLORS.panel, paddingLeft: 3, paddingRight: 3, paddingTop: 1 });
  modal.add(body);
  const scroll = new core.ScrollBoxRenderable(renderer, {
    width: 56,
    height: 18,
    scrollY: true,
    scrollbarOptions: { visible: true },
    backgroundColor: COLORS.panel,
    paddingRight: 2,
    paddingTop: 1
  });
  body.add(scroll);

  const inputs = CUSTOM_PROVIDER_FORM_FIELDS.map((field, index) => addFormInput(core, renderer, scroll, services, callbacks, field, index));
  const footer = new core.BoxRenderable(renderer, { width: "100%", height: 1, flexDirection: "row", paddingTop: 1, backgroundColor: COLORS.panel });
  scroll.add(footer);
  footer.add(new core.TextRenderable(renderer, { content: "enter", fg: COLORS.text, bg: COLORS.panel, height: 1 }));
  footer.add(new core.TextRenderable(renderer, { content: " save   ", fg: COLORS.muted, bg: COLORS.panel, height: 1 }));
  footer.add(new core.TextRenderable(renderer, { content: "up/down", fg: COLORS.text, bg: COLORS.panel, height: 1 }));
  footer.add(new core.TextRenderable(renderer, { content: " move", fg: COLORS.muted, bg: COLORS.panel, height: 1 }));

  const focusedIndex = Math.max(0, Math.min(services.customProviderForm.focusIndex, inputs.length - 1));
  keepDialogRowVisible(renderer, scroll, focusedIndex * 3, 14, 1);
  const modelPanel = addCustomProviderModelPanel(core, renderer, body, services, callbacks);
  if (services.customProviderForm.focusIndex === CUSTOM_PROVIDER_DISCOVER_INDEX) return modelPanel;
  return inputs[focusedIndex] ?? inputs[0];
}

function addProviderAuthMethodDialog(core: OpenTuiCore, renderer: OpenTuiRenderer, parent: OpenTuiBox, runtime: RuntimeState, services: TuiServices, callbacks: ProviderDialogCallbacks): OpenTuiBox {
  const modal = addDialogFrame(core, renderer, parent, "Select auth method");
  const methods = services.authProviderId ? providerAuthMethods(runtime, services.authProviderId) : [];
  const viewportHeight = Math.max(1, Math.min(8, methods.length + 1));
  const scroll = new core.ScrollBoxRenderable(renderer, {
    width: "100%",
    height: viewportHeight,
    scrollY: true,
    scrollbarOptions: { visible: false },
    backgroundColor: COLORS.panel,
    paddingLeft: 1,
    paddingRight: 1,
    paddingTop: 1
  });
  keepDialogRowVisible(renderer, scroll, services.pickerIndex, viewportHeight, 1);
  modal.add(scroll);

  if (methods.length === 0) {
    addDialogEmptyState(core, renderer, scroll, "No auth methods configured.");
    return modal;
  }

  methods.forEach((method, index) => {
    const selected = index === services.pickerIndex;
    const background = selected ? COLORS.primary : COLORS.panel;
    const foreground = selected ? COLORS.background : COLORS.text;
    const row = new core.BoxRenderable(renderer, {
      id: `provider-auth-method-${index}`,
      width: "100%",
      height: 1,
      flexDirection: "row",
      paddingLeft: 3,
      paddingRight: 3,
      backgroundColor: background,
      onMouseDown: () => {
        services.pickerIndex = index;
        callbacks.onProviderQueryChange();
      },
      onMouseUp: () => callbacks.onProviderAuthMethodSelect(index)
    });
    row.add(new core.TextRenderable(renderer, { content: method.label, fg: foreground, bg: background, height: 1, width: 52, wrapMode: "none" }));
    scroll.add(row);
  });
  return modal;
}

function addModelSelectDialog(core: OpenTuiCore, renderer: OpenTuiRenderer, parent: OpenTuiBox, runtime: RuntimeState, services: TuiServices, callbacks: ProviderDialogCallbacks): OpenTuiBox {
  const title = services.modelProviderFilter && runtime.config ? sanitizeDisplayValue(runtime.config.providers[services.modelProviderFilter]?.displayName ?? services.modelProviderFilter, services.modelProviderFilter) : "Select model";
  const modal = addDialogFrame(core, renderer, parent, title);
  const models = modelPickerEntriesForProvider(runtime, services.modelProviderFilter);
  const viewportHeight = Math.max(1, Math.min(12, models.length + 1));
  const scroll = new core.ScrollBoxRenderable(renderer, {
    width: "100%",
    height: viewportHeight,
    scrollY: true,
    scrollbarOptions: { visible: false },
    backgroundColor: COLORS.panel,
    paddingLeft: 1,
    paddingRight: 1,
    paddingTop: 1
  });
  keepDialogRowVisible(renderer, scroll, services.pickerIndex, viewportHeight, 1);
  modal.add(scroll);

  if (models.length === 0) {
    addDialogEmptyState(core, renderer, scroll, "No models configured for this provider.");
    return modal;
  }

  models.forEach(([modelId, model], index) => {
    const selected = index === services.pickerIndex;
    const background = selected ? COLORS.primary : COLORS.panel;
    const foreground = selected ? COLORS.background : COLORS.text;
    const muted = selected ? COLORS.background : COLORS.muted;
    const enabled = model.enabled === false ? "○" : "●";
    const label = `${enabled} ${sanitizeDisplayValue(model.displayName ?? modelId, "unknown")}`;
    const description = sanitizeDisplayValue(model.displayName && model.displayName !== modelId ? `${model.provider}/${modelId}` : model.provider, "unknown");
    const row = new core.BoxRenderable(renderer, {
      id: `model-${modelId}`,
      width: "100%",
      height: 1,
      flexDirection: "row",
      paddingLeft: 3,
      paddingRight: 3,
      backgroundColor: background,
      onMouseDown: () => {
        services.pickerIndex = index;
        callbacks.onProviderQueryChange();
      },
      onMouseUp: () => callbacks.onModelSelect(index)
    });
    row.add(new core.TextRenderable(renderer, { content: label, fg: foreground, bg: background, height: 1, width: 34, wrapMode: "none" }));
    row.add(new core.TextRenderable(renderer, { content: description, fg: muted, bg: background, height: 1, width: 18, wrapMode: "none" }));
    scroll.add(row);
  });
  return modal;
}

function addProviderFlowDialog(core: OpenTuiCore, renderer: OpenTuiRenderer, parent: OpenTuiBox, runtime: RuntimeState, services: TuiServices, callbacks: ProviderDialogCallbacks): OpenTuiDialogFocus | undefined {
  if (services.startupOverlay === "providers") return addProviderSelectDialog(core, renderer, parent, runtime, services, callbacks);
  if (services.startupOverlay === "providerAuthMethod") return addProviderAuthMethodDialog(core, renderer, parent, runtime, services, callbacks);
  if (services.startupOverlay === "providerAuth" && services.authProviderId === "custom") return addCustomProviderFormDialog(core, renderer, parent, services, callbacks);
  if (services.startupOverlay === "providerAuth") return addProviderAuthDialog(core, renderer, parent, services, callbacks);
  if (services.startupOverlay === "models") return addModelSelectDialog(core, renderer, parent, runtime, services, callbacks);
  return undefined;
}

function addProviderPopupLayer(core: OpenTuiCore, renderer: OpenTuiRenderer, parent: OpenTuiRoot, runtime: RuntimeState, services: TuiServices, callbacks: ProviderDialogCallbacks): OpenTuiDialogFocus | undefined {
  const backdrop = new core.BoxRenderable(renderer, {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    backgroundColor: COLORS.background,
    opacity: 0.72,
    zIndex: 90
  });
  parent.add(backdrop);

  const layer = new core.BoxRenderable(renderer, {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 100
  });
  parent.add(layer);

  return addProviderFlowDialog(core, renderer, layer, runtime, services, callbacks);
}

function buildHome(core: OpenTuiCore, renderer: OpenTuiRenderer, runtime: RuntimeState, services: TuiServices, onSubmit: (input: string) => void, onContentChange: (() => void) | undefined, callbacks: ProviderDialogCallbacks): OpenTuiTextarea {
  const root = renderer.root;
  clearBox(root);
  root.flexDirection = "column";
  let dialogFocus: OpenTuiDialogFocus | undefined;

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

  const openCodeDialog = isOpenCodeDialogOverlay(services);
  container.add(new core.BoxRenderable(renderer, { flexGrow: 1, minHeight: 0 }));
  container.add(new core.BoxRenderable(renderer, { height: 4, minHeight: 0, flexShrink: 1 }));
  for (const line of LOGO) {
    addText(core, renderer, container, line, { fg: COLORS.primary, width: LOGO_WIDTH, height: 1 });
  }
  container.add(new core.BoxRenderable(renderer, { height: 2, minHeight: 0, flexShrink: 1 }));
  if (services.startupOverlay !== "none" || services.dialogs.active()) {
    if (services.startupOverlay !== "slashCommands" && !openCodeDialog) {
      const overlay = new core.BoxRenderable(renderer, { width: HOME_PROMPT_WIDTH, flexDirection: "column", border: true, borderColor: COLORS.secondary, paddingLeft: 1, paddingRight: 1, paddingTop: 1, paddingBottom: 1, flexShrink: 0 });
      container.add(overlay);
      addMultilineText(core, renderer, overlay, renderHomeOverlayText(runtime, services), { fg: COLORS.text, height: 1 });
    }
  }
  if (services.startupOverlay === "slashCommands") {
    addSlashCommandOverlay(core, renderer, container, services);
  }
  const prompt = createPrompt(core, renderer, container, runtime.state, services.promptDraft, onSubmit, onContentChange);
  const textarea = prompt.textarea;
  container.add(new core.BoxRenderable(renderer, { flexGrow: 1, minHeight: 1 }));

  const footer = new core.BoxRenderable(renderer, { width: "100%", height: 1, flexDirection: "row", justifyContent: "space-between", paddingLeft: 1, paddingRight: 1, flexShrink: 0 });
  footer.add(new core.TextRenderable(renderer, { content: sanitizeDisplayValue(runtime.state.workspace, "."), fg: COLORS.muted, width: 32 }));
  footer.add(new core.TextRenderable(renderer, { content: `• 0 LSP   ⊙ 0 MCP`, fg: COLORS.text, width: 30 }));
  container.add(footer);

  if (openCodeDialog) {
    dialogFocus = addProviderPopupLayer(core, renderer, root, runtime, services, callbacks);
  }

  if (dialogFocus) {
    dialogFocus.focus();
    renderer.focusRenderable(dialogFocus);
  } else {
    textarea.focus();
    renderer.focusRenderable(textarea);
  }
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
  const textarea = createPrompt(core, renderer, main, runtime.state, "", input => onSubmit(input, scroll)).textarea;

  const sidebar = new core.BoxRenderable(renderer, { width: 42, height: "100%", backgroundColor: COLORS.panel, paddingTop: 1, paddingBottom: 1, paddingLeft: 2, paddingRight: 2, flexDirection: "column" });
  renderer.root.add(sidebar);
  const sidebarScroll = new core.ScrollBoxRenderable(renderer, { flexGrow: 1, scrollY: true });
  sidebar.add(sidebarScroll);
  addText(core, renderer, sidebarScroll, "local", { fg: COLORS.text, height: 1 });
  addText(core, renderer, sidebarScroll, sanitizeDisplayValue(runtime.state.workspace, "."), { fg: COLORS.muted, height: 1 });
  addText(core, renderer, sidebarScroll, `Active model: ${sanitizeDisplayValue(runtime.state.modelDisplayName ?? runtime.state.model, "mock")}`, { fg: COLORS.primary, height: 1 });
  addText(core, renderer, sidebarScroll, `Provider: ${sanitizeDisplayValue(runtime.state.providerDisplayName ?? runtime.state.provider, "local")}`, { fg: COLORS.muted, height: 1 });
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
  let customProviderDiscoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let customProviderDiscoveryRequestId = 0;
  const exit = () => {
    clearCustomProviderDiscoveryTimer();
    if (!renderer.isDestroyed) renderer.destroy();
  };
  const clearCustomProviderDiscoveryTimer = (): void => {
    if (!customProviderDiscoveryTimer) return;
    clearTimeout(customProviderDiscoveryTimer);
    customProviderDiscoveryTimer = undefined;
  };
  const copyCurrentSelection = (): boolean => {
    const selectedText = selectedTextForClipboard(renderer.getSelection());
    if (!selectedText) return false;
    void writeClipboard(selectedText, output);
    return true;
  };
  renderer.root.onMouseDown = event => {
    if (!shouldCopySelectionForMouse(event, core.MouseButton.RIGHT, selectedTextForClipboard(renderer.getSelection()))) return;
    event.preventDefault();
    event.stopPropagation();
    copyCurrentSelection();
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
    if (input.startsWith("/connect ")) {
      if (!scroll) return;
      const response = await handleConnectCommand(input, {
        config: runtime.config,
        configPath: DEFAULT_CONFIG_PATH,
        state: runtime.state,
        noColor: true,
        onConfigUpdated: config => {
          refreshRuntimeFromConfig(runtime, config);
          services.toasts.push("success", "Provider connected.");
        }
      });
      await reloadProviderAuth(runtime, services);
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
  const openHomeOverlayForCommand = async (value: string): Promise<boolean> => {
    const overlay = exactHomeCommandOverlay(value);
    if (!overlay) return false;
    services.modelProviderFilter = undefined;
    services.providerQuery = "";
    services.authInputDraft = "";
    if (overlay === "models") {
      const failures = await refreshAuthenticatedProviderModels(runtime);
      await reloadProviderAuth(runtime, services);
      failures.forEach(failure => services.toasts.push("error", clipDisplayLine(failure)));
    }
    services.pickerIndex = overlay === "providers" ? selectedProviderIndex(runtime) : selectedModelIndex(runtime);
    showOverlay(overlay);
    return true;
  };
  const executeCustomProviderModelDiscovery = async (requestId = ++customProviderDiscoveryRequestId): Promise<void> => {
    clearCustomProviderDiscoveryTimer();
    if (requestId !== customProviderDiscoveryRequestId) return;
    const form = services.customProviderForm;
    const providerId = form.providerId.trim() || "custom";
    const baseUrl = form.baseUrl.trim();
    const apiKey = form.apiKey.trim();
    if (!baseUrl || !apiKey) {
      services.customProviderForm.discovery = { status: "error", models: [], selectedModels: [], error: "Enter Base URL and API key first." };
      rebuildHome();
      return;
    }
    if (!isValidCustomProviderId(providerId)) {
      services.customProviderForm.discovery = { status: "error", models: [], selectedModels: [], error: "Provider ID must be lowercase letters, numbers, hyphens, or underscores." };
      rebuildHome();
      return;
    }
    try {
      buildModelsUrl({ baseUrl, modelsEndpoint: "/models" });
    } catch (error) {
      services.customProviderForm.discovery = { status: "error", models: [], selectedModels: [], error: `Invalid Base URL: ${error instanceof Error ? error.message : String(error)}` };
      rebuildHome();
      return;
    }

    services.customProviderForm.discovery = { status: "loading", models: [], selectedModels: [] };
    rebuildHome();
    try {
      const authStore = {
        async get() {
          return { type: "api" as const, key: apiKey };
        },
        async all() {
          return { [providerId]: { type: "api" as const, key: apiKey } };
        }
      };
      const discovered = await discoverOpenAICompatibleModels({
        id: providerId,
        type: "openai-compatible",
        displayName: form.displayName.trim() || providerId,
        baseUrl,
        modelsEndpoint: "/models",
        authStore
      }, globalFetchTransport());
      if (requestId !== customProviderDiscoveryRequestId) return;
      const models = Array.from(new Set(discovered.map(model => model.id))).sort((left, right) => left.localeCompare(right));
      services.customProviderForm.discovery = {
        status: "ready",
        models,
        selectedModels: models
      };
      services.customProviderForm.selectedModelIndex = 0;
    } catch (error) {
      if (requestId !== customProviderDiscoveryRequestId) return;
      services.customProviderForm.discovery = { status: "error", models: [], selectedModels: [], error: error instanceof Error ? error.message : String(error) };
    }
    if (shouldRefreshCustomProviderDiscoveryPanel(services.startupOverlay, services.authProviderId, services.customProviderForm.focusIndex)) {
      rebuildHome();
    }
  };
  const scheduleCustomProviderModelDiscovery = (): void => {
    clearCustomProviderDiscoveryTimer();
    const form = services.customProviderForm;
    customProviderDiscoveryRequestId += 1;
    if (!shouldAutoDiscoverCustomProviderModels(form.baseUrl, form.apiKey)) {
      services.customProviderForm.discovery = defaultCustomProviderDiscovery();
      services.customProviderForm.selectedModelIndex = 0;
      return;
    }
    services.customProviderForm.discovery = { status: "loading", models: [], selectedModels: [] };
    services.customProviderForm.selectedModelIndex = 0;
    rebuildHome();
    const requestId = customProviderDiscoveryRequestId;
    customProviderDiscoveryTimer = setTimeout(() => {
      customProviderDiscoveryTimer = undefined;
      void executeCustomProviderModelDiscovery(requestId);
    }, 450);
  };
  const executeCustomProviderFormSubmit = async (): Promise<void> => {
    clearCustomProviderDiscoveryTimer();
    const form = services.customProviderForm;
    const providerId = form.providerId.trim();
    const displayName = form.displayName.trim();
    const baseUrl = form.baseUrl.trim();
    const apiKey = form.apiKey.trim();
    if (!providerId || !displayName || !baseUrl || !apiKey) {
      services.toasts.push("error", "Fill Provider ID, Display name, Base URL, and API key.");
      showOverlay("toasts");
      return;
    }
    if (!isValidCustomProviderId(providerId)) {
      services.toasts.push("error", "Provider ID may use lowercase letters, numbers, hyphens, or underscores.");
      showOverlay("toasts");
      return;
    }
    try {
      buildModelsUrl({ baseUrl, modelsEndpoint: "/models" });
    } catch (error) {
      services.toasts.push("error", `Invalid Base URL: ${error instanceof Error ? error.message : String(error)}`);
      showOverlay("toasts");
      return;
    }
    if (!runtime.config) {
      services.toasts.push("error", "Config missing. Run 'strongcode init' first.");
      showOverlay("toasts");
      return;
    }
    try {
      const updated = await persistConfigUpdate({ path: DEFAULT_CONFIG_PATH, directory: "", config: runtime.config }, config => {
        const nextConfig = structuredClone(config);
        nextConfig.providers[providerId] = {
          type: "openai-compatible",
          displayName,
          apiKeyEnv: apiKeyEnvForProviderId(providerId),
          baseUrl,
          modelsEndpoint: "/models",
          enabled: true
        };
        const selectedModels = selectedCustomProviderModels(form.discovery.models, form.discovery.selectedModels);
        for (const modelId of selectedModels) {
          const existing = nextConfig.models[modelId];
          nextConfig.models[modelId] = {
            provider: providerId,
            model: modelId,
            enabled: true,
            source: "discovered",
            displayName: existing?.displayName ?? modelId,
            options: existing?.options
          };
        }
        const firstModel = selectedModels[0];
        if (firstModel && nextConfig.agents[nextConfig.defaultAgent]) {
          nextConfig.agents[nextConfig.defaultAgent].model = firstModel;
        }
        return nextConfig;
      });
      refreshRuntimeFromConfig(runtime, updated);
      await authStoreForConfig(updated, DEFAULT_CONFIG_PATH).set(providerId, { type: "api", key: apiKey });
      await reloadProviderAuth(runtime, services);
      services.toasts.push("success", `Connected ${providerId}.`);
      services.authProviderId = undefined;
      services.authProviderTitle = undefined;
      services.authInputDraft = "";
      services.customProviderForm = defaultCustomProviderForm();
      services.modelProviderFilter = providerId;
      services.pickerIndex = selectedModelIndexForProvider(runtime, providerId);
      showOverlay("models");
    } catch (error) {
      services.toasts.push("error", `Error: ${error instanceof Error ? error.message : String(error)}`);
      showOverlay("toasts");
    }
  };
  const executeProviderAuthSubmit = async (apiKey: string): Promise<void> => {
    if (services.authProviderId === "custom") {
      await executeCustomProviderFormSubmit();
      return;
    }
    const providerId = services.authProviderId;
    if (!providerId || !apiKey.trim()) {
      services.startupOverlay = "none";
      services.authInputDraft = "";
      rebuildHome();
      return;
    }
    const response = await handleConnectCommand(`/connect ${providerId} ${apiKey.trim()}`, {
      config: runtime.config,
      configPath: DEFAULT_CONFIG_PATH,
      state: runtime.state,
      noColor: true,
      onConfigUpdated: config => {
        refreshRuntimeFromConfig(runtime, config);
        services.toasts.push("success", `Connected ${providerId}.`);
      }
    });
    await reloadProviderAuth(runtime, services);
    services.authProviderId = undefined;
    services.authProviderTitle = undefined;
    services.authInputDraft = "";
    if (response.startsWith("Error:") || response.startsWith("Unknown provider") || response.startsWith("Usage:")) {
      services.toasts.push("error", response);
      showOverlay("toasts");
      return;
    }
    services.modelProviderFilter = providerId;
    services.pickerIndex = selectedModelIndexForProvider(runtime, providerId);
    showOverlay("models");
  };
  const submitHomeValue = async (value: string): Promise<void> => {
    if (services.startupOverlay === "providerAuth") {
      services.promptDraft = "";
      void executeProviderAuthSubmit(value);
      return;
    }
    services.promptDraft = "";
    services.startupOverlay = "none";
    if (await openHomeOverlayForCommand(value)) return;
    if (value) void handleSubmit(value);
  };
  const submitPrompt = () => {
    const value = textarea.plainText.trim();
    textarea.clear();
    void submitHomeValue(value);
  };
  const rebuildHome = () => {
    textarea = buildHome(core, renderer, runtime, services, value => {
      if (shouldSubmitHomeValue(services.startupOverlay, value)) void submitHomeValue(value);
      else if (services.startupOverlay === "slashCommands") void executeSlashSelection();
    }, () => syncSlashOverlay(), {
      onProviderSelect(index) {
        services.pickerIndex = index;
        executeProviderSelection();
      },
      onProviderQueryChange() {
        rebuildHome();
      },
      onProviderAuthMethodSelect(index) {
        services.pickerIndex = index;
        void executeProviderAuthMethodSelection();
      },
      onProviderAuthSubmit(value) {
        services.authInputDraft = value;
        void executeProviderAuthSubmit(value);
      },
      onCustomProviderFieldFocus(index) {
        services.customProviderForm.focusIndex = Math.max(0, Math.min(index, CUSTOM_PROVIDER_FOCUS_COUNT - 1));
        rebuildHome();
      },
      onCustomProviderFieldChange(field) {
        if (field === "baseUrl" || field === "apiKey") scheduleCustomProviderModelDiscovery();
      },
      onCustomProviderDiscover() {
        void executeCustomProviderModelDiscovery();
      },
      onCustomProviderModelToggle(index) {
        const discovery = services.customProviderForm.discovery;
        const modelId = discovery.models[index];
        if (!modelId) return;
        services.customProviderForm.selectedModelIndex = index;
        services.customProviderForm.discovery = {
          ...discovery,
          selectedModels: toggleCustomProviderSelectedModel(discovery.models, discovery.selectedModels, modelId)
        };
        rebuildHome();
      },
      onCustomProviderSubmit() {
        void executeCustomProviderFormSubmit();
      },
      onModelSelect(index) {
        services.pickerIndex = index;
        void executeModelSelection();
      }
    });
  };
  const showOverlay = (overlay: TuiServices["startupOverlay"]) => {
    services.startupOverlay = overlay;
    services.dialogs.close();
    rebuildHome();
  };
  const executePaletteSelection = async (): Promise<void> => {
    const selected = services.palette.selected();
    services.promptDraft = "";
    services.startupOverlay = "none";
    if (selected && await openHomeOverlayForCommand(selected.slash)) {
      return;
    }
    if (selected) void handleSubmit(selected.slash);
  };
  const executeSlashSelection = async (): Promise<void> => {
    const commands = slashCommands(services);
    const selected = selectedSlashCommand(commands, services.slashIndex);
    services.promptDraft = "";
    services.startupOverlay = "none";
    if (selected) {
      textarea.clear();
      if (await openHomeOverlayForCommand(selected.slash)) {
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
    services.slashIndex = nextSelectionIndex(services.slashIndex, commands.length, delta);
    updateSlashScroll(commands);
    rebuildHome();
    return true;
  };
  const moveProviderSelection = (delta: -1 | 1): boolean => {
    if (services.startupOverlay !== "providers") return false;
    const providers = providerPickerEntries(runtime, services.providerQuery);
    services.pickerIndex = nextSelectionIndex(services.pickerIndex, providers.length, delta);
    rebuildHome();
    return true;
  };
  const moveProviderAuthMethodSelection = (delta: -1 | 1): boolean => {
    if (services.startupOverlay !== "providerAuthMethod" || !services.authProviderId) return false;
    const methods = providerAuthMethods(runtime, services.authProviderId);
    services.pickerIndex = nextSelectionIndex(services.pickerIndex, methods.length, delta);
    rebuildHome();
    return true;
  };
  const moveCustomProviderFormFocus = (delta: -1 | 1): boolean => {
    if (services.startupOverlay !== "providerAuth" || services.authProviderId !== "custom") return false;
    services.customProviderForm.focusIndex = nextSelectionIndex(services.customProviderForm.focusIndex, CUSTOM_PROVIDER_FOCUS_COUNT, delta);
    services.customProviderForm.selectedModelIndex = Math.max(0, Math.min(services.customProviderForm.selectedModelIndex, Math.max(0, services.customProviderForm.discovery.models.length - 1)));
    rebuildHome();
    return true;
  };
  const moveCustomProviderModelSelection = (delta: -1 | 1): boolean => {
    if (services.startupOverlay !== "providerAuth" || services.authProviderId !== "custom") return false;
    const form = services.customProviderForm;
    if (form.focusIndex !== CUSTOM_PROVIDER_DISCOVER_INDEX || form.discovery.status !== "ready" || form.discovery.models.length === 0) return false;
    const nextIndex = form.selectedModelIndex + delta;
    if (nextIndex < 0 || nextIndex >= form.discovery.models.length) return false;
    form.selectedModelIndex = nextIndex;
    rebuildHome();
    return true;
  };
  const toggleFocusedCustomProviderModel = (): boolean => {
    if (services.startupOverlay !== "providerAuth" || services.authProviderId !== "custom") return false;
    const form = services.customProviderForm;
    if (form.focusIndex !== CUSTOM_PROVIDER_DISCOVER_INDEX || form.discovery.status !== "ready") return false;
    const modelId = form.discovery.models[form.selectedModelIndex];
    if (!modelId) return false;
    form.discovery = {
      ...form.discovery,
      selectedModels: toggleCustomProviderSelectedModel(form.discovery.models, form.discovery.selectedModels, modelId)
    };
    rebuildHome();
    return true;
  };
  const moveModelSelection = (delta: -1 | 1): boolean => {
    if (services.startupOverlay !== "models") return false;
    const models = modelPickerEntriesForProvider(runtime, services.modelProviderFilter);
    services.pickerIndex = nextSelectionIndex(services.pickerIndex, models.length, delta);
    rebuildHome();
    return true;
  };
  const executeProviderSelection = () => {
    if (!runtime.config) return;
    const providers = providerPickerEntries(runtime, services.providerQuery);
    const selected = providers[Math.max(0, Math.min(services.pickerIndex, providers.length - 1))];
    services.providerQuery = "";
    if (selected) {
      textarea.clear();
      const [providerId, provider] = selected;
      const authOverlay = provider.type !== "mock" ? providerAuthOverlayForMethods(providerAuthMethods(runtime, providerId)) : undefined;
      if (authOverlay === "providerAuthMethod") {
        services.authProviderId = providerId;
        services.authProviderTitle = undefined;
        services.authInputDraft = "";
        services.pickerIndex = 0;
        showOverlay("providerAuthMethod");
        return;
      }
      if (providerId === "custom" && authOverlay === "providerAuth") {
        services.authProviderId = providerId;
        services.authProviderTitle = "Custom API Key";
        services.authInputDraft = "";
        services.customProviderForm = customProviderFormFromConfig(runtime.config, providerId, services.providerAuth[providerId]);
        showOverlay("providerAuth");
        return;
      }
      const catalogProvider = runtime.config ? createProviderCatalog(runtime.config, services.providerAuth).all.find(item => item.id === providerId) : undefined;
      if (provider.type !== "mock" && !catalogProvider?.connected) {
        services.authProviderId = providerId;
        services.authInputDraft = "";
        services.authProviderTitle = "API key";
        showOverlay("providerAuth");
        return;
      }
      services.modelProviderFilter = selected[0];
      services.pickerIndex = selectedModelIndexForProvider(runtime, selected[0]);
      showOverlay("models");
    }
  };
  const executeProviderAuthMethodSelection = async () => {
    const providerId = services.authProviderId;
    if (!providerId) return;
    const methods = providerAuthMethods(runtime, providerId);
    const method = methods[Math.max(0, Math.min(services.pickerIndex, methods.length - 1))];
    if (!method) return;
    if (method.type === "api") {
      services.authProviderTitle = method.label;
      services.authInputDraft = "";
      showOverlay("providerAuth");
      return;
    }
    const command = connectCommandForProviderAuthMethod(providerId, method);
    if (!command) {
      services.toasts.push("error", `Unsupported auth method for ${providerId}.`);
      showOverlay("toasts");
      return;
    }
    services.promptDraft = "";
    services.providerQuery = "";
    services.authInputDraft = "";
    services.authProviderId = undefined;
    services.authProviderTitle = undefined;
    services.startupOverlay = "none";
    await handleSubmit(command);
  };
  const executeModelSelection = async () => {
    if (!runtime.config) return;
    const models = modelPickerEntriesForProvider(runtime, services.modelProviderFilter);
    const selected = models[Math.max(0, Math.min(services.pickerIndex, models.length - 1))];
    services.promptDraft = "";
    if (!selected) return;
    textarea.clear();
    try {
      const updated = await persistConfigUpdate({ path: DEFAULT_CONFIG_PATH, directory: "", config: runtime.config }, config => selectModel(config, selected[0]));
      refreshRuntimeFromConfig(runtime, updated);
      services.toasts.push("success", "Model config updated.");
      services.modelProviderFilter = undefined;
      services.startupOverlay = "none";
      rebuildHome();
    } catch (error) {
      services.toasts.push("error", `Error: ${error instanceof Error ? error.message : String(error)}`);
      showOverlay("toasts");
    }
  };
  const submitOpenCodeDialog = (): boolean => {
    if (services.startupOverlay === "providers") {
      executeProviderSelection();
      return true;
    }
    if (services.startupOverlay === "providerAuthMethod") {
      void executeProviderAuthMethodSelection();
      return true;
    }
    if (services.startupOverlay === "providerAuth") {
      if (services.authProviderId === "custom" && services.customProviderForm.focusIndex === CUSTOM_PROVIDER_DISCOVER_INDEX) {
        if (!toggleFocusedCustomProviderModel()) void executeCustomProviderModelDiscovery();
      }
      else if (services.authProviderId === "custom") void executeCustomProviderFormSubmit();
      else void executeProviderAuthSubmit(services.authInputDraft);
      return true;
    }
    if (services.startupOverlay === "models") {
      void executeModelSelection();
      return true;
    }
    return false;
  };
  const closeOpenCodeDialog = (): boolean => {
    if (!isOpenCodeDialogOverlay(services)) return false;
    clearCustomProviderDiscoveryTimer();
    customProviderDiscoveryRequestId += 1;
    services.promptDraft = promptDraftAfterEscape(services.startupOverlay, "");
    services.providerQuery = "";
    services.authInputDraft = "";
    services.authProviderId = undefined;
    services.authProviderTitle = undefined;
    services.customProviderForm = defaultCustomProviderForm();
    showOverlay("none");
    return true;
  };
  const syncSlashOverlay = () => {
    const draft = textarea.plainText;
    if (services.startupOverlay === "providerAuthMethod" || services.startupOverlay === "providerAuth") {
      services.promptDraft = "";
      return;
    }
    const draftOverlay = draftHomeCommandOverlay(draft);
    if (draftOverlay) {
      services.promptDraft = "";
      services.modelProviderFilter = undefined;
      services.pickerIndex = selectedProviderIndex(runtime);
      showOverlay(draftOverlay);
      return;
    }
    services.promptDraft = draft;
    const query = slashQuery(draft);
    if (query === undefined) {
      if (services.startupOverlay === "providers") {
        const providers = providerPickerEntries(runtime, services.providerQuery);
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
  const unregisterOpenCodeDialogNavigationLayer = keymap.registerLayer({
    priority: 200,
    commands: [
      {
        name: "dialog.provider.previous",
        desc: "Previous dialog item",
        run() {
          if (services.startupOverlay === "providers") return moveProviderSelection(-1);
          if (services.startupOverlay === "providerAuthMethod") return moveProviderAuthMethodSelection(-1);
          if (services.startupOverlay === "providerAuth") return moveCustomProviderFormFocus(-1);
          if (services.startupOverlay === "models") return moveModelSelection(-1);
          return false;
        }
      },
      {
        name: "dialog.provider.next",
        desc: "Next dialog item",
        run() {
          if (services.startupOverlay === "providers") return moveProviderSelection(1);
          if (services.startupOverlay === "providerAuthMethod") return moveProviderAuthMethodSelection(1);
          if (services.startupOverlay === "providerAuth") return moveCustomProviderFormFocus(1);
          if (services.startupOverlay === "models") return moveModelSelection(1);
          return false;
        }
      },
      {
        name: "dialog.provider.submit",
        desc: "Submit dialog selection",
        run() {
          return submitOpenCodeDialog();
        }
      },
      {
        name: "dialog.provider.close",
        desc: "Close dialog",
        run() {
          return closeOpenCodeDialog();
        }
      }
    ],
    bindings: [
      { key: "up", cmd: "dialog.provider.previous" },
      { key: "down", cmd: "dialog.provider.next" },
      { key: "return", cmd: "dialog.provider.submit" },
      { key: "enter", cmd: "dialog.provider.submit" },
      { key: "escape", cmd: "dialog.provider.close" }
    ]
  });
  renderer.keyInput.on("keypress", key => {
    const inputKey = keyEventToInput(key);
    const navigationKey = navigationKeyName(key.name);
    if (shouldCopySelectionForInput(inputKey, selectedTextForClipboard(renderer.getSelection())) && copyCurrentSelection()) {
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    if (isOpenCodeDialogOverlay(services)) {
      if (navigationKey === "up" && services.startupOverlay === "providers") {
        key.preventDefault();
        key.stopPropagation();
        moveProviderSelection(-1);
        return;
      }
      if (navigationKey === "down" && services.startupOverlay === "providers") {
        key.preventDefault();
        key.stopPropagation();
        moveProviderSelection(1);
        return;
      }
      if (navigationKey === "return" && services.startupOverlay === "providers") {
        key.preventDefault();
        key.stopPropagation();
        submitOpenCodeDialog();
        return;
      }
      if (navigationKey === "up" && services.startupOverlay === "providerAuthMethod") {
        key.preventDefault();
        key.stopPropagation();
        moveProviderAuthMethodSelection(-1);
        return;
      }
      if (navigationKey === "down" && services.startupOverlay === "providerAuthMethod") {
        key.preventDefault();
        key.stopPropagation();
        moveProviderAuthMethodSelection(1);
        return;
      }
      if (navigationKey === "return" && services.startupOverlay === "providerAuthMethod") {
        key.preventDefault();
        key.stopPropagation();
        submitOpenCodeDialog();
        return;
      }
      if (navigationKey === "return" && services.startupOverlay === "providerAuth") {
        key.preventDefault();
        key.stopPropagation();
        submitOpenCodeDialog();
        return;
      }
      if (navigationKey === "up" && services.startupOverlay === "providerAuth" && services.authProviderId === "custom") {
        key.preventDefault();
        key.stopPropagation();
        if (!moveCustomProviderModelSelection(-1)) moveCustomProviderFormFocus(-1);
        return;
      }
      if (navigationKey === "down" && services.startupOverlay === "providerAuth" && services.authProviderId === "custom") {
        key.preventDefault();
        key.stopPropagation();
        if (!moveCustomProviderModelSelection(1)) moveCustomProviderFormFocus(1);
        return;
      }
      if (navigationKey === "up" && services.startupOverlay === "models") {
        key.preventDefault();
        key.stopPropagation();
        moveModelSelection(-1);
        return;
      }
      if (navigationKey === "down" && services.startupOverlay === "models") {
        key.preventDefault();
        key.stopPropagation();
        moveModelSelection(1);
        return;
      }
      if (navigationKey === "return" && services.startupOverlay === "models") {
        key.preventDefault();
        key.stopPropagation();
        submitOpenCodeDialog();
        return;
      }
      if (navigationKey === "escape") {
        key.preventDefault();
        key.stopPropagation();
        closeOpenCodeDialog();
        return;
      }
      return;
    }
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
    if (navigationKey === "up" && services.startupOverlay === "slashCommands") {
      key.preventDefault();
      key.stopPropagation();
      moveSlashSelection(-1);
      return;
    }
    if (navigationKey === "down" && services.startupOverlay === "slashCommands") {
      key.preventDefault();
      key.stopPropagation();
      moveSlashSelection(1);
      return;
    }
    if (navigationKey === "return" && services.startupOverlay === "slashCommands") {
      key.preventDefault();
      key.stopPropagation();
      void executeSlashSelection();
      return;
    }
    if (navigationKey === "up" && services.startupOverlay === "palette") {
      key.preventDefault();
      key.stopPropagation();
      services.palette.move(-1);
      rebuildHome();
      return;
    }
    if (navigationKey === "down" && services.startupOverlay === "palette") {
      key.preventDefault();
      key.stopPropagation();
      services.palette.move(1);
      rebuildHome();
      return;
    }
    if (navigationKey === "return" && services.startupOverlay === "palette") {
      key.preventDefault();
      key.stopPropagation();
      void executePaletteSelection();
      return;
    }
    if (navigationKey === "escape") {
      services.dialogs.close();
      services.promptDraft = promptDraftAfterEscape(services.startupOverlay, textarea.plainText);
      if (services.startupOverlay === "slashCommands" || services.startupOverlay === "providerAuthMethod" || services.startupOverlay === "providerAuth") textarea.clear();
      if (services.startupOverlay === "providerAuthMethod" || services.startupOverlay === "providerAuth") {
        services.authProviderId = undefined;
        services.authProviderTitle = undefined;
        services.authInputDraft = "";
      }
      showOverlay("none");
      return;
    }
    if (!key.ctrl && !key.meta) setImmediate(syncSlashOverlay);
  });
  rebuildHome();

  await new Promise<void>(resolve => {
    renderer.once("destroy", () => {
      clearCustomProviderDiscoveryTimer();
      unregisterOpenCodeDialogNavigationLayer();
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
