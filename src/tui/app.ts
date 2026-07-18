import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { Agent } from "../agents/agent";
import { AgentRunner } from "../agents/runner";
import type { ApprovedPlan, PlanReceipt } from "../agents/plan-handoff";
import { cyclePrimaryAgent, getAgentDefinition, getAgentDisplayName, listAgentDefinitions } from "../agents/registry";
import { DEFAULT_CONFIG_PATH, loadConfig, resolveConfigPath } from "../config/load";
import { resolveStrongCodeHome } from "../config/paths";
import { persistConfigUpdate, selectModel } from "../config/save";
import { StrongCodeConfig } from "../config/schema";
import { StrongCodeError } from "../core/errors";
import { orderedProviders } from "../models/registry";
import { createRuntimeAuthReader, ProviderAuth, ProviderAuthStore, resolveRuntimeAuthDataDir } from "../models/auth-store";
import { createProviderCatalog } from "../models/catalog";
import { buildModelsUrl, discoverOpenAICompatibleModels, discoverProviderModels, globalFetchTransport } from "../models/discovery";
import { ProviderAuthMethodDetail, ProviderService } from "../models/provider-service";
import { isLocalProviderBaseUrl } from "../models/provider-url";
import { requireRuntime, createAgent } from "../runtime/factory";
import { SessionStore } from "../sessions/session-store";
import { createRuntimeToolRegistry } from "../mcp/runtime-registry";
import { TuiState, TuiTranscriptMessage, sanitizeDisplayValue, sanitizeMultilineDisplayValue } from "./render";
import { clipDisplayLine, renderAllModelList, renderHomeWithPrompt, renderSessionLayout } from "./render";
import { handleConnectCommand } from "./commands";
import { prepareDelegatedSpawn, resolveDelegatedExecutable } from "../models/delegated-executable";
import { loadTuiConfig, TuiConfig } from "./config/tui";
import type { QuestionBroker } from "../questions/broker";
import type { DeepSeekQuestionSimplifier } from "../questions/simplifier";
import { mountQuestionSurface, type QuestionSurfaceController } from "./question/surface";
import { installQuestionRuntime } from "./question/runtime";
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
import {
  STRONGCODE_WORDMARK,
  STRONGCODE_WORDMARK_GAP,
  STRONGCODE_WORDMARK_HEIGHT,
  STRONGCODE_WORDMARK_LEFT_WIDTH,
  STRONGCODE_WORDMARK_MIN_VIEWPORT,
  STRONGCODE_WORDMARK_RIGHT_WIDTH,
  STRONGCODE_WORDMARK_WIDTH,
  decodeWordmarkLine
} from "./ui/wordmark";
import {
  ModelUiControls,
  SessionTelemetry,
  STRONGCODE_VERSION,
  TurnReceipt,
  commandHelpLines,
  compactSessionTitle,
  fastModeLabel,
  formatCost,
  formatTokens,
  modelUiControls,
  promptHeightForVisualLines,
  reasoningLabel,
  sessionTelemetryLine,
  shouldFollowLatestPosition,
  shouldSyncSlashOverlay,
  turnReceiptLine,
  turnStatusIcon
} from "./ui/session-chrome";
import { projectSessionTelemetry, summaryDetailLines, summaryRailLines } from "./ui/session-summary";
import {
  fullTuiRouteForInput,
  parseSlashCommand,
  resolveSlashSubmission,
  slashCommandAllowedDuringTurn,
  slashCommandAvailability
} from "./slash-command-registry";

type OpenTuiCore = typeof import("@opentui/core");
type OpenTuiRenderer = InstanceType<OpenTuiCore["CliRenderer"]>;
type OpenTuiRoot = OpenTuiRenderer["root"];
type OpenTuiBox = InstanceType<OpenTuiCore["BoxRenderable"]>;
type OpenTuiText = InstanceType<OpenTuiCore["TextRenderable"]>;
type OpenTuiInput = InstanceType<OpenTuiCore["InputRenderable"]>;
type OpenTuiTextarea = InstanceType<OpenTuiCore["TextareaRenderable"]>;
type OpenTuiScrollBox = InstanceType<OpenTuiCore["ScrollBoxRenderable"]>;
type OpenTuiRenderable = NonNullable<OpenTuiRenderer["currentFocusedRenderable"]>;
type OpenTuiDialogFocus = OpenTuiBox | OpenTuiInput | OpenTuiTextarea;
type OpenTuiKeymap = {
  registerLayer(layer: { priority?: number; bindings?: readonly unknown[]; commands?: readonly unknown[] }): () => void;
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

const REASONING_DISCLOSURE_ID_PREFIX = "assistant-reasoning-disclosure-";
let reasoningDisclosureCount = 0;

const SLASH_COMMAND_LIMIT = 10;
const HOME_PROMPT_WIDTH = 72;
export const ACTIVE_TURN_BUSY_MESSAGE = "The active agent is still working. Wait for this turn to finish before sending another message.";
export const START_WORK_HANDOFF_PROMPT = "StrongCode /start-work handoff: Execute the latest approved JBP plan in this session now. Begin with its first unblocked task and continue through its verification gates.";

export type ExclusiveOperationLease = object;

export interface ExclusiveOperationGate {
  acquire(): ExclusiveOperationLease | undefined;
  release(lease: ExclusiveOperationLease): void;
  isActive(): boolean;
}

export type ContextCompactionRunner = Pick<AgentRunner, "compact">;

export function createExclusiveOperationGate(): ExclusiveOperationGate {
  let owner: ExclusiveOperationLease | undefined;
  return {
    acquire() {
      if (owner) return undefined;
      const lease = {};
      owner = lease;
      return lease;
    },
    release(lease) {
      if (owner === lease) owner = undefined;
    },
    isActive() {
      return owner !== undefined;
    }
  };
}

export function acquireTurnLease(turns: ExclusiveOperationGate, mutations: ExclusiveOperationGate, turnRunning: boolean): ExclusiveOperationLease | undefined {
  if (turnRunning || mutations.isActive()) return undefined;
  return turns.acquire();
}

export function releaseOperationAndSubmit<T>(gate: ExclusiveOperationGate, lease: ExclusiveOperationLease, submit: () => T): T {
  gate.release(lease);
  return submit();
}

export type ModelRefreshToken = object;

export interface ModelRefreshGate {
  begin(): ModelRefreshToken;
  invalidate(): void;
  isCurrent(token: ModelRefreshToken, overlay: string): boolean;
}

export function createModelRefreshGate(): ModelRefreshGate {
  let current: ModelRefreshToken | undefined;
  return {
    begin() {
      const token = {};
      current = token;
      return token;
    },
    invalidate() {
      current = undefined;
    },
    isCurrent(token, overlay) {
      return current === token && overlay === "models";
    }
  };
}

export function requireIdleTurn(turnRunning: boolean, onBusy: (message: string) => void): boolean {
  if (!turnRunning) return true;
  onBusy(ACTIVE_TURN_BUSY_MESSAGE);
  return false;
}

export async function compactActiveContext(
  runner: ContextCompactionRunner | undefined,
  agent: Agent | undefined,
  sessionId: string | undefined,
  append: (role: "system", text: string) => void | Promise<void>
): Promise<void> {
  if (!runner || !agent || !sessionId) {
    await append("system", "Unable to compact context: active runner, agent, or session is unavailable.");
    return;
  }
  await append("system", "Compacting active context...");
  try {
    const result = await runner.compact(agent, sessionId);
    if (!result.ok) {
      await append("system", clipDisplayLine(`Unable to compact context: ${result.error.message}`));
      return;
    }
    await append("system", clipDisplayLine(`Context compacted. Retained user items: ${result.value.retainedUserItemCount}.`));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Compaction failed";
    await append("system", clipDisplayLine(`Unable to compact context: ${detail}`));
  }
}

export function snapshotTurnReceiptLabels(state: TuiState): { readonly agent: string; readonly model: string } {
  return {
    agent: sanitizeDisplayValue(state.defaultAgent, "default"),
    model: sanitizeDisplayValue(state.modelDisplayName ?? state.model, "mock")
  };
}

export function approvedPlanExecutionForActivation(agentName: string, explicitPlanApproval: boolean): boolean {
  return explicitPlanApproval && getAgentDefinition(agentName)?.id === "bob-the-builder";
}

function shouldUseOpenTui(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): boolean {
  return input === process.stdin && output === process.stdout && process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export function fallbackCommandContainsApiKey(input: string): boolean {
  const command = parseSlashCommand(input);
  if (command?.command !== "connect") return false;
  const parts = command.rawArgs.split(/\s+/);
  return parts.length >= 2 && parts[0]?.toLowerCase() !== "remove";
}

async function runFallbackTui(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void> {
  const readline = await import("node:readline");
  const configPath = resolveConfigPath();
  const configExists = existsSync(configPath);
  const state: TuiState = { provider: "N/A", defaultAgent: "N/A", configPath, configMissing: !configExists };
  let runner: AgentRunner | undefined;
  let agent: Agent | undefined;
  let config: StrongCodeConfig | undefined;
  let systemPrompt: string | undefined;
  let trustedConfig = false;
  let workspaceRoot: string | undefined;
  let sessionStore: SessionStore | undefined;
  const messages: TuiTranscriptMessage[] = [];
  const sessionId = `session-${Date.now()}`;

  if (configExists) {
    try {
      const runtime = await requireRuntime();
      config = runtime.config;
      systemPrompt = runtime.systemPrompt;
      trustedConfig = runtime.trustedConfig;
      workspaceRoot = runtime.context.workspaceRoot;
      const authStore = createRuntimeAuthReader(runtime.authDataDir, undefined, { allowEnvironmentContent: runtime.trustedConfig });
      agent = createAgent(runtime.config, runtime.config.defaultAgent, {
        authStore,
        systemPrompt: runtime.systemPrompt,
        allowEnvironmentCredentials: runtime.trustedConfig,
        allowConfiguredSystemPrompt: runtime.trustedConfig,
        restrictToReadOnlyTools: !runtime.trustedConfig,
        workspaceRoot: runtime.context.workspaceRoot
      });
      const modelConfig = runtime.config.models[agent.config.model];
      state.provider = modelConfig.provider;
      state.providerDisplayName = runtime.config.providers[modelConfig.provider]?.displayName;
      state.model = agent.config.model;
      state.modelDisplayName = modelConfig.displayName;
      state.modelOptions = modelConfig.options;
      state.defaultAgent = agent.displayName ?? agent.name;
      state.agentIdentity = agent.name;
      state.workspace = runtime.config.workspace;
      state.dataDir = runtime.config.dataDir;
      sessionStore = new SessionStore(runtime.context.dataDir);
      const registry = await createRuntimeToolRegistry(runtime.context, { allowMcp: runtime.trustedConfig });
      runner = runtime.runnerFactory.create({
        sessions: sessionStore,
        tools: registry,
        providerOptions: {
          authStore,
          allowEnvironmentCredentials: runtime.trustedConfig,
          workspaceRoot: runtime.context.workspaceRoot
        }
      });
    } catch (error) {
      output.write(`${clipDisplayLine(`Error loading config: ${error instanceof Error ? error.message : String(error)}`)}\n`);
    }
  }

  const servicesDataDir = config
    ? resolveRuntimeAuthDataDir(
      state.configPath,
      path.resolve(path.dirname(path.resolve(state.configPath)), config.dataDir)
    )
    : undefined;
  const services = await createTuiServices(await loadTuiConfig(), servicesDataDir, state, trustedConfig);

  const fallbackRuntime: RuntimeState = {
    state,
    config,
    runner,
    agent,
    activeAgentId: agent?.name,
    systemPrompt,
    trustedConfig,
    workspaceRoot,
    sessionStore,
    currentSessionId: sessionId
  };
  output.write(`${renderHomeWithPrompt(state, true).output}\n`);
  await new Promise<void>(resolve => {
    const rl = readline.createInterface({ input, output, prompt: "" });
    let pending = Promise.resolve();
    const close = () => {
      rl.close();
      resolve();
    };
    const submitTurn = async (value: string, approvedPlan?: ApprovedPlan): Promise<void> => {
      const turnRunner = fallbackRuntime.runner;
      const turnAgent = fallbackRuntime.agent;
      if (!turnRunner || !turnAgent) {
        output.write("\nConfig missing. Run 'strongcode init' first.\n");
        return;
      }
      const planningTurn = turnAgent.name === "jbp";
      if (planningTurn) fallbackRuntime.jbpPlanReceipt = undefined;
      services.history.add(value);
      await services.historyStore?.save(services.history);
      const startedAt = Date.now();
      messages.push({ role: "user", text: value });
      const result = approvedPlan
        ? await turnRunner.runApprovedPlan(turnAgent, value, sessionId, approvedPlan)
        : await turnRunner.run(turnAgent, value, sessionId);
      if (planningTurn) fallbackRuntime.jbpPlanReceipt = result.ok ? result.value.planReceipt : undefined;
      const receipt: TurnReceipt = {
        status: result.ok ? "finished" : "failed",
        agent: state.defaultAgent,
        model: state.modelDisplayName ?? state.model ?? "mock",
        durationMs: Date.now() - startedAt,
        toolCalls: result.ok ? result.value.toolExecutions.length : 0,
        skillsRead: undefined,
        mcpServersUsed: undefined
      };
      services.telemetry.toolCalls += receipt.toolCalls;
      services.lastReceipt = receipt;
      messages.push({ role: "assistant", text: result.ok ? result.value.response : String(result.error), receipt });
      output.write(`\n${renderSessionLayout(state, messages, true)}\n`);
    };
    services.submitTurn = submitTurn;
    rl.on("line", line => {
      const value = line.trim();
      pending = pending.then(async () => {
        const runtime = fallbackRuntime;
        const append = (_role: "assistant" | "system", text: string) => {
          output.write(`\n${text}\n`);
        };
        if (fallbackCommandContainsApiKey(value)) {
          output.write("\nInline API keys are disabled in the fallback terminal.\nInput may be echoed; use the full TUI or run strongcode setup --force.\n");
          return;
        }
        if (await handleSystemCommand(value, runtime, services, append, close)) {
          config = runtime.config;
          agent = runtime.agent;
          return;
        }
        if (value.startsWith("/")) output.write(`\n${clipDisplayLine(`Unknown command: ${value}`)}\n`);
        else if (value) await submitTurn(value);
      }).catch(error => {
        output.write(`\n${clipDisplayLine(`Error: ${error instanceof Error ? error.message : String(error)}`)}\n`);
      });
    });
  });
  await fallbackRuntime.runner?.close();
}

async function runThroughBun(): Promise<void> {
  const entry = require.main?.filename ?? __filename;
  const projectCwd = process.cwd();
  const bootstrapCwd = path.join(resolveStrongCodeHome(), "runtime", "bun-bootstrap");
  await mkdir(bootstrapCwd, { recursive: true, mode: 0o700 });
  const loaded = await loadConfig();
  const configDirectory = loaded.ok ? loaded.value.directory : projectCwd;
  const workspace = loaded.ok ? path.resolve(configDirectory, loaded.value.config.workspace) : projectCwd;
  const resolvedCommand = await resolveDelegatedExecutable("bun", {
    env: process.env,
    cwd: bootstrapCwd,
    // A shell opened in the user's home must not make normal user-installed
    // runtimes (for example ~/.bun/bin) look repository-controlled. Exclude
    // the actual config/project roots and the isolated bootstrap directory.
    excludedRoots: [configDirectory, workspace, bootstrapCwd],
    // Bun's documented per-user install root is pinned explicitly, so a broad
    // home-directory workspace does not authorize arbitrary home executables.
    allowedExecutableRoots: [path.join(os.homedir(), ".bun", "bin")]
  });
  const launch = prepareDelegatedSpawn(resolvedCommand, [entry]);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(launch.executable, launch.args, {
      cwd: bootstrapCwd,
      env: { ...launch.env, STRONGCODE_TUI_BUN: "1", STRONGCODE_TUI_PROJECT_CWD: projectCwd },
      stdio: "inherit",
      windowsHide: true,
      shell: false,
      windowsVerbatimArguments: launch.windowsVerbatimArguments
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
  sessionStore?: SessionStore;
  currentSessionId?: string;
  agent?: Agent;
  activeAgentId?: string;
  systemPrompt?: string;
  jbpPlanReceipt?: PlanReceipt;
  trustedConfig?: boolean;
  workspaceRoot?: string;
  questionBroker?: QuestionBroker;
  questionSimplifier?: DeepSeekQuestionSimplifier;
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
  authProviderEndpoint?: string;
  customProviderForm: CustomProviderFormState;
  controls: ModelUiControls;
  telemetry: SessionTelemetry;
  helpOpen: boolean;
  summaryOpen: boolean;
  turnRunning: boolean;
  lastReceipt?: TurnReceipt;
  submitTurn?: (input: string, approvedPlan?: ApprovedPlan) => Promise<void>;
  onSummary?: () => void;
  onAgentChanged?: () => void;
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

export async function createTuiServices(tuiConfig: TuiConfig, dataDir?: string, state?: TuiState, trustedConfig = false): Promise<TuiServices> {
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
    providerAuth: dataDir
      ? await new ProviderAuthStore(dataDir, { allowEnvironmentContent: trustedConfig }).all()
      : {},
    customProviderForm: defaultCustomProviderForm(),
    controls: modelUiControls(state?.modelOptions, state?.provider),
    telemetry: {
      totalTokens: state?.totalTokens,
      costUsd: state?.costUsd,
      toolCalls: 0,
      skillsRead: undefined,
      mcpServersLoaded: state?.mcpServersLoaded,
      mcpServersUsed: undefined
    },
    helpOpen: false,
    summaryOpen: false,
    turnRunning: false
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
    chatgpt: "(ChatGPT browser/headless login)",
    openai: "(OpenAI API key)",
    anthropic: "(API key)",
    kimi: "(Moonshot API key)",
    grok: "(xAI API key)",
    mock: "(local mock provider)",
    custom: "(OpenAI-compatible custom provider)"
  }[providerId] ?? "";
}

export function providerEndpointLabel(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    return new URL(baseUrl).origin;
  } catch {
    return "invalid provider endpoint";
  }
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

export function isAvailableCustomProviderId(config: StrongCodeConfig | undefined, providerId: string, editingProviderId = "custom"): boolean {
  return isValidCustomProviderId(providerId)
    && (!config?.providers[providerId] || providerId === editingProviderId);
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
  const agent = sanitizeDisplayValue(runtime.state.defaultAgent, runtime.activeAgentId ?? runtime.config.defaultAgent);
  const title = providerFilter
    ? `${sanitizeDisplayValue(runtime.config.providers[providerFilter]?.displayName ?? providerFilter, providerFilter)} · ${agent}`
    : `Select model for ${agent}`;
  return renderPickerSurface(title, models.map(([modelId, model]) => ({
    id: modelId,
    label: `${model.enabled === false ? "○" : "●"} ${sanitizeDisplayValue(model.displayName ?? modelId, "unknown")}`,
    description: sanitizeDisplayValue(model.displayName && model.displayName !== modelId ? `${model.provider}/${modelId}` : model.provider, "unknown")
  })), selectedIndex);
}

function providerDialogOptions(runtime: RuntimeState, services: TuiServices, query = ""): ProviderDialogOption[] {
  if (!runtime.config) return [];
  const catalog = createProviderCatalog(runtime.config, services.providerAuth, {
    allowEnvironmentCredentials: runtime.trustedConfig === true
  });
  const catalogByProvider = new Map(catalog.all.map(provider => [provider.id, provider]));
  const providers = providerPickerEntries(runtime, query);
  return providers.map(([providerId, provider]): ProviderDialogOption => {
    const displayName = sanitizeDisplayValue(provider.displayName, providerId);
    const catalogProvider = catalogByProvider.get(providerId);
    const apiKeyEnv = provider.apiKeyEnv ? sanitizeDisplayValue(provider.apiKeyEnv, "unknown") : undefined;
    const environmentConnected = Boolean(runtime.trustedConfig === true && provider.apiKeyEnv && process.env[provider.apiKeyEnv]);
    const connectedByAuth = Boolean(catalogProvider?.connected && provider.apiKeyEnv && !environmentConnected);
    const endpoint = providerEndpointLabel(provider.baseUrl);
    return {
      id: providerId,
      title: providerDialogTitle(providerId, displayName),
      description: sanitizeDisplayValue([endpoint ? `@ ${endpoint}` : "", providerPickerDescription(providerId)].filter(Boolean).join(" "), providerId),
      category: providerDialogCategory(providerId),
      connected: catalogProvider?.connected ?? provider.enabled !== false,
      footer: connectedByAuth ? "auth.json" : environmentConnected ? `env ${apiKeyEnv}` : undefined
    };
  });
}

export function providerAuthOverlayForMethods(methods: ProviderAuthMethodDetail[]): TuiServices["startupOverlay"] | undefined {
  if (methods.length > 1 || methods.some(method => method.type === "delegated" || method.type === "oauth")) return "providerAuthMethod";
  if (methods.some(method => method.type === "api")) return "providerAuth";
  return undefined;
}

export function connectCommandForProviderAuthMethod(providerId: string, method: ProviderAuthMethodDetail): string | undefined {
  if (providerId === "chatgpt" && method.type === "oauth") {
    return method.id === "device-code" ? "/connect chatgpt headless" : "/connect chatgpt browser";
  }
  return undefined;
}

function authStoreForConfig(config: StrongCodeConfig, configPath = DEFAULT_CONFIG_PATH, allowEnvironmentContent = false): ProviderAuthStore {
  const runtimeDataDir = path.resolve(path.dirname(path.resolve(configPath)), config.dataDir);
  const authDataDir = resolveRuntimeAuthDataDir(configPath, runtimeDataDir);
  return new ProviderAuthStore(authDataDir, { allowEnvironmentContent });
}

function providerAuthMethods(runtime: RuntimeState, providerId: string): ProviderAuthMethodDetail[] {
  if (!runtime.config) return [];
  const service = new ProviderService(runtime.config, authStoreForConfig(runtime.config, runtime.state.configPath, runtime.trustedConfig === true));
  return service.authMethods()[providerId] ?? [];
}

async function reloadProviderAuth(runtime: RuntimeState, services: TuiServices): Promise<void> {
  services.providerAuth = runtime.config
    ? await authStoreForConfig(runtime.config, runtime.state.configPath, runtime.trustedConfig === true).all()
    : {};
}

async function refreshAuthenticatedProviderModels(runtime: RuntimeState): Promise<string[]> {
  if (!runtime.config) return [];
  const providerId = runtime.state.provider && runtime.state.provider !== "N/A" ? runtime.state.provider : "mock";
  const provider = runtime.config.providers[providerId];
  if (!provider || provider.type === "mock" || !provider.baseUrl) return [];
  if (!["openai", "openai-compatible", "anthropic", "google"].includes(provider.type)) return [];

  try {
    const authStore = authStoreForConfig(runtime.config, runtime.state.configPath, runtime.trustedConfig === true);
    const discovered = await discoverProviderModels({
      id: providerId,
      type: provider.type,
      displayName: provider.displayName,
      apiKeyEnv: provider.apiKeyEnv,
      baseUrl: provider.baseUrl,
      modelsEndpoint: provider.modelsEndpoint,
      allowUnauthenticated: provider.allowUnauthenticated,
      enabled: provider.enabled,
      authStore,
      allowEnvironmentCredentials: runtime.trustedConfig === true
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

function renderTextSessionSummary(runtime: RuntimeState, services: TuiServices): string {
  return [
    "Session Summary",
    "────────────────────────────────────────────────────────────────────────────────",
    `Agent       ${sanitizeDisplayValue(runtime.state.defaultAgent, "default")}`,
    `Model       ${activeModelLabel(runtime.state)}`,
    `Usage       ${sessionTelemetryLine(services.telemetry)}`,
    `Tools       ${services.telemetry.toolCalls}`,
    `Skills      ${services.telemetry.skillsRead ?? "—"}`,
    `MCP used    ${services.telemetry.mcpServersUsed ?? "—"}`,
    `Reasoning   ${reasoningLabel(services.controls)}`,
    `Fast mode   ${fastModeLabel(services.controls)}`,
    "",
    "Latest turn",
    services.lastReceipt ? turnReceiptLine(services.lastReceipt) : "No completed turns yet."
  ].map(line => clipDisplayLine(line)).join("\n");
}

export function renderAgentRoster(activeAgentId?: string, config?: StrongCodeConfig): string {
  const activeDefinition = activeAgentId ? getAgentDefinition(activeAgentId) : undefined;
  const rows = listAgentDefinitions().map(agent => {
    const active = activeDefinition?.id === agent.id || (!activeDefinition && activeAgentId === agent.id);
    const tier = agent.tier === "primary" ? "main" : "specialist";
    return `${active ? ">" : " "} ${agent.displayName.padEnd(24)} ${agent.id.padEnd(27)} ${tier} · ${agent.role}`;
  });
  const custom = config
    ? Object.keys(config.agents)
      .filter(name => !getAgentDefinition(name))
      .map(name => `${name === activeAgentId ? ">" : " "} ${name.padEnd(24)} ${name.padEnd(27)} custom`)
    : [];
  return [
    "Agents",
    "Tab / Shift+Tab cycles the four main agents.",
    "Use /agent <name> to activate a specialist.",
    ...rows,
    ...custom
  ].map(line => clipDisplayLine(line)).join("\n");
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

export function slashSelectionValue<T extends { slash: string }>(commands: T[], selectedIndex: number, draft: string): string | undefined {
  const selected = selectedSlashCommand(commands, selectedIndex);
  if (selected) return selected.slash;
  const value = draft.trim();
  return value.startsWith("/") && value.length > 1 ? value : undefined;
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

function slashCommands(services: TuiServices, value = services.promptDraft) {
  const query = slashQuery(value) ?? "";
  return services.palette.search(query).sort((left, right) => left.slash.localeCompare(right.slash));
}

export function draftHomeCommandOverlay(value: string): TuiServices["startupOverlay"] | undefined {
  void value;
  return undefined;
}

export function shouldSubmitHomePrompt(startupOverlay: string): boolean {
  return startupOverlay === "none";
}

export function shouldSubmitHomeValue(startupOverlay: string, value: string): boolean {
  return shouldSubmitHomePrompt(startupOverlay) || (startupOverlay === "slashCommands" && fullTuiRouteForInput(value) !== undefined);
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

function applyRuntimeAgent(runtime: RuntimeState, agent: Agent): void {
  if (!runtime.config) throw new StrongCodeError("CONFIG_ERROR", "Config missing. Run 'strongcode init' first.");
  const modelConfig = runtime.config.models[agent.config.model];
  if (!modelConfig) throw new StrongCodeError("CONFIG_ERROR", `Model not found: ${agent.config.model}`);
  runtime.agent = agent;
  runtime.activeAgentId = agent.name;
  runtime.state.provider = modelConfig.provider;
  runtime.state.providerDisplayName = runtime.config.providers[modelConfig.provider]?.displayName;
  runtime.state.model = agent.config.model;
  runtime.state.modelDisplayName = modelConfig.displayName;
  runtime.state.modelOptions = modelConfig.options;
  runtime.state.defaultAgent = agent.displayName ?? agent.name;
  runtime.state.agentIdentity = agent.name;
}

function activateRuntimeAgent(runtime: RuntimeState, agentName: string, explicitPlanApproval = false): Agent {
  if (!runtime.config) throw new StrongCodeError("CONFIG_ERROR", "Config missing. Run 'strongcode init' first.");
  const definition = getAgentDefinition(agentName);
  const approvedPlanExecution = approvedPlanExecutionForActivation(agentName, explicitPlanApproval);
  const handoffPrompt = approvedPlanExecution
    ? "Trusted StrongCode session state: the user explicitly invoked /start-work after the active JBP planning phase. Treat the JBP plan in this same session as approved for execution, subject to normal safety and scope checks."
    : undefined;
  const agent = createAgent(runtime.config, agentName, {
    authStore: authStoreForConfig(runtime.config, runtime.state.configPath, runtime.trustedConfig === true),
    systemPrompt: [runtime.systemPrompt, handoffPrompt].filter(Boolean).join("\n\n") || undefined,
    allowEnvironmentCredentials: runtime.trustedConfig === true,
    allowConfiguredSystemPrompt: runtime.trustedConfig === true,
    approvedPlanExecution,
    restrictToReadOnlyTools: runtime.trustedConfig !== true && !approvedPlanExecution,
    workspaceRoot: runtime.workspaceRoot ?? path.resolve(path.dirname(path.resolve(runtime.state.configPath)), runtime.config.workspace)
  });
  applyRuntimeAgent(runtime, agent);
  return agent;
}

function refreshRuntimeFromConfig(runtime: RuntimeState, config: StrongCodeConfig): void {
  runtime.config = config;
  const activeAgent = runtime.activeAgentId ?? config.defaultAgent;
  try {
    activateRuntimeAgent(runtime, activeAgent);
  } catch {
    try {
      activateRuntimeAgent(runtime, config.defaultAgent);
    } catch {
      runtime.agent = undefined;
    }
  }
}

function refreshUiControls(runtime: RuntimeState, services: TuiServices): void {
  services.controls = modelUiControls(runtime.state.modelOptions, runtime.state.provider);
}

async function handleSystemCommand(input: string, runtime: RuntimeState, services: TuiServices, append: (role: "assistant" | "system", text: string) => void | Promise<void>, exit: () => void, nestedTurnSubmit?: (input: string, approvedPlan?: ApprovedPlan) => Promise<void>): Promise<boolean> {
  const command = parseSlashCommand(input);
  if (!command || command.command === "unknown") return false;
  if (!slashCommandAllowedDuringTurn(command) && !requireIdleTurn(services.turnRunning, message => { void append("system", message); })) return true;

  switch (command.command) {
    case "exit":
      exit();
      return true;
    case "help":
      await append("system", ["StrongCode commands", "───────────────────", ...commandHelpLines()].join("\n"));
      return true;
    case "summary":
      await append("system", renderTextSessionSummary(runtime, services));
      return true;
    case "compact":
      await compactActiveContext(runtime.runner, runtime.agent, runtime.currentSessionId, append);
      return true;
    case "computer-use": {
      const submitTurn = nestedTurnSubmit ?? services.submitTurn;
      if (!submitTurn) {
        await append("system", "Unable to enable computer use because the turn submission path is unavailable.");
        return true;
      }
      const task = input.trim().replace(/^\/computer\s+use\b/i, "").trim();
      await submitTurn(task
        ? `Use the computer ${/^to\b/i.test(task) ? task : `to ${task}`}`
        : "Use the computer.");
      return true;
    }
    case "agent": {
      if (command.action === "list") {
        await append("system", renderAgentRoster(runtime.activeAgentId, runtime.config));
        return true;
      }
      try {
        const requested = command.action === "select"
          ? command.target
          : cyclePrimaryAgent(runtime.activeAgentId ?? runtime.config?.defaultAgent ?? "tesla", command.action === "next" ? 1 : -1).id;
        const agent = activateRuntimeAgent(runtime, requested);
        refreshUiControls(runtime, services);
        services.onAgentChanged?.();
        const provenance = agent.modelResolution?.preference ?? agent.modelResolution?.provenance ?? "configured model";
        await append("system", clipDisplayLine(`Active agent: ${agent.displayName ?? agent.name} · ${runtime.state.modelDisplayName ?? runtime.state.model ?? "unknown"} · ${provenance}`));
      } catch (error) {
        await append("system", clipDisplayLine(`Unable to activate agent: ${error instanceof Error ? error.message : String(error)}`));
      }
      return true;
    }
    case "start-work": {
      const activeAgentId = getAgentDefinition(runtime.activeAgentId ?? "")?.id;
      const availability = slashCommandAvailability(command.command, activeAgentId);
      if (!availability.available) {
        await append("system", clipDisplayLine(availability.message));
        return true;
      }
      const submitTurn = nestedTurnSubmit ?? services.submitTurn;
      if (!submitTurn) {
        await append("system", clipDisplayLine("Unable to start work because the turn submission path is unavailable. JBP remains active and read-only."));
        return true;
      }
      const runner = runtime.runner;
      const sessionId = runtime.currentSessionId;
      const receipt = runtime.jbpPlanReceipt;
      if (!runner || !sessionId || !receipt) {
        await append("system", clipDisplayLine("No current JBP plan receipt is available for this session. JBP remains active and read-only."));
        return true;
      }
      runtime.jbpPlanReceipt = undefined;
      const approvedPlan = runner.consumePlanReceipt(sessionId, receipt);
      if (!approvedPlan.ok) {
        await append("system", clipDisplayLine("No current JBP plan receipt is available for this session. JBP remains active and read-only."));
        return true;
      }
      let agent: Agent;
      try {
        agent = activateRuntimeAgent(runtime, "bob-the-builder", true);
        refreshUiControls(runtime, services);
        services.onAgentChanged?.();
      } catch (error) {
        runner.discardApprovedPlan(approvedPlan.value);
        await append("system", clipDisplayLine(`Unable to start work: ${error instanceof Error ? error.message : String(error)}`));
        return true;
      }
      await append("system", clipDisplayLine(`Plan approved. Active agent: ${agent.displayName ?? agent.name}. Starting the approved plan now.`));
      try {
        await submitTurn(START_WORK_HANDOFF_PROMPT, approvedPlan.value);
      } finally {
        runner.discardApprovedPlan(approvedPlan.value);
        try {
          activateRuntimeAgent(runtime, "bob-the-builder");
          refreshUiControls(runtime, services);
          services.onAgentChanged?.();
        } catch (error) {
          runtime.agent = undefined;
          await append("system", clipDisplayLine(`Bob returned to read-only mode but could not be reactivated: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
      return true;
    }
    case "connect": {
      const connectInput = command.rawArgs ? `/connect ${command.rawArgs}` : "/connect";
      const response = await handleConnectCommand(connectInput, {
        config: runtime.config,
        configPath: runtime.state.configPath,
        state: runtime.state,
        noColor: true,
        trustedConfig: runtime.trustedConfig,
        onAuthPrompt: prompt => { void append("system", [prompt.instructions, prompt.userCode ? `Code: ${prompt.userCode}` : "", prompt.url].filter(Boolean).join("\n")); },
        onConfigUpdated: config => {
          refreshRuntimeFromConfig(runtime, config);
          refreshUiControls(runtime, services);
          services.toasts.push("success", "Provider connected.");
        }
      });
      await reloadProviderAuth(runtime, services);
      append("system", response);
      return true;
    }
    case "model": {
      if (command.action === "open" || command.action === "list") {
        const failures = services.turnRunning ? [] : await refreshAuthenticatedProviderModels(runtime);
        const failureOutput = failures.length > 0 ? `${failures.map(failure => clipDisplayLine(failure)).join("\n")}\n` : "";
        append("system", runtime.config ? `${failureOutput}${renderAllModelList(runtime.config, runtime.state, true)}` : "Config missing. Run 'strongcode init' first.");
        return true;
      }
      if (!runtime.config) {
        await append("system", "Config missing. Run 'strongcode init' first.");
        return true;
      }
      const requestedAgent = command.agentId
        ? getAgentDefinition(command.agentId)?.id ?? command.agentId
        : runtime.activeAgentId ?? runtime.config.defaultAgent;
      if (!runtime.config.agents[requestedAgent] && !getAgentDefinition(requestedAgent)) {
        await append("system", clipDisplayLine(`Unknown agent '${requestedAgent}'. Use /agents to list available agents.`));
        return true;
      }
      try {
        const updated = await persistConfigUpdate({
          path: runtime.state.configPath,
          directory: path.dirname(runtime.state.configPath),
          config: runtime.config
        }, config => selectModel(config, command.modelId, requestedAgent));
        refreshRuntimeFromConfig(runtime, updated);
        refreshUiControls(runtime, services);
        services.onAgentChanged?.();
        const configured = updated.agents[requestedAgent]?.model ?? command.modelId;
        const model = updated.models[configured];
        const agentLabel = getAgentDefinition(requestedAgent)?.displayName ?? requestedAgent;
        const modelLabel = model?.displayName ?? configured;
        services.toasts.push("success", `${agentLabel} now uses ${modelLabel}.`);
        await append("system", clipDisplayLine(`Model updated: ${agentLabel} → ${modelLabel} (${model?.provider ?? "unknown provider"}).`));
      } catch (error) {
        await append("system", clipDisplayLine(`Unable to set model: ${error instanceof Error ? error.message : String(error)}`));
      }
      return true;
    }
    default:
      return assertNeverCommand(command);
  }
}

function assertNeverCommand(command: never): never {
  throw new Error(`Unexpected slash command: ${String(command)}`);
}

async function loadRuntimeState(currentSessionId: string): Promise<RuntimeState> {
  const configPath = resolveConfigPath();
  const configExists = existsSync(configPath);
  const state: TuiState = {
    provider: "N/A",
    defaultAgent: "N/A",
    configPath,
    configMissing: !configExists
  };

  if (!configExists) return { state, currentSessionId };

  const runtime = await requireRuntime();
  const authStore = createRuntimeAuthReader(runtime.authDataDir, undefined, { allowEnvironmentContent: runtime.trustedConfig });
  const agent = createAgent(runtime.config, runtime.config.defaultAgent, {
    authStore,
    systemPrompt: runtime.systemPrompt,
    allowEnvironmentCredentials: runtime.trustedConfig,
    allowConfiguredSystemPrompt: runtime.trustedConfig,
    restrictToReadOnlyTools: !runtime.trustedConfig,
    workspaceRoot: runtime.context.workspaceRoot
  });
  const modelConfig = runtime.config.models[agent.config.model];
  state.provider = modelConfig.provider;
  state.providerDisplayName = runtime.config.providers[modelConfig.provider]?.displayName;
  state.model = agent.config.model;
  state.modelDisplayName = modelConfig.displayName;
  state.modelOptions = modelConfig.options;
  state.defaultAgent = agent.displayName ?? agent.name;
  state.agentIdentity = agent.name;
  state.workspace = runtime.config.workspace;
  state.dataDir = runtime.config.dataDir;

  const sessionStore = new SessionStore(runtime.context.dataDir);
  const registry = await createRuntimeToolRegistry(runtime.context, { allowMcp: runtime.trustedConfig });
  const questionRuntime = installQuestionRuntime(registry, {
    context: runtime.context,
    authStore,
    allowEnvironmentCredentials: runtime.trustedConfig
  });
  return {
    state,
    config: runtime.config,
    agent,
    activeAgentId: agent.name,
    systemPrompt: runtime.systemPrompt,
    trustedConfig: runtime.trustedConfig,
    workspaceRoot: runtime.context.workspaceRoot,
    currentSessionId,
    sessionStore,
    questionBroker: questionRuntime.broker,
    questionSimplifier: questionRuntime.simplifier,
    runner: runtime.runnerFactory.create({
      sessions: sessionStore,
      tools: registry,
    providerOptions: {
      authStore,
      allowEnvironmentCredentials: runtime.trustedConfig,
        workspaceRoot: runtime.context.workspaceRoot
      }
    })
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

function modelLine(core: OpenTuiCore, state: TuiState, _controls: ModelUiControls) {
  const model = promptStatusLabel(state.model, "mock");
  const modelDisplay = promptStatusLabel(state.modelDisplayName, model);
  const agent = getAgentDisplayName(state.agentIdentity, promptStatusLabel(state.defaultAgent, "default"));
  return core.t`${agent} · ${core.fg(COLORS.text)(modelDisplay)} · 🧠 · ⚡`;
}

export interface PromptElements {
  textarea: OpenTuiTextarea;
  anchor: OpenTuiBox;
  meta: OpenTuiText;
  resize(width: number): void;
}

export function createPrompt(core: OpenTuiCore, renderer: OpenTuiRenderer, parent: OpenTuiBox, state: TuiState, controls: ModelUiControls, initialValue: string, onSubmit: (value: string) => void, onContentChange?: () => void, width = HOME_PROMPT_WIDTH, hintText = "/model switch · Tab agents · Ctrl+H commands · Shift+Enter newline"): PromptElements {
  const promptOuter = new core.BoxRenderable(renderer, {
    width,
    maxWidth: width,
    height: 5,
    flexDirection: "row",
    flexShrink: 0,
    overflow: "hidden"
  });
  parent.add(promptOuter);

  const accent = new core.BoxRenderable(renderer, {
    width: 1,
    height: 5,
    backgroundColor: COLORS.primary,
    flexShrink: 0
  });
  promptOuter.add(accent);

  const promptPanel = new core.BoxRenderable(renderer, {
    flexGrow: 1,
    flexShrink: 1,
    width: Math.max(1, width - 1),
    maxWidth: Math.max(1, width - 1),
    minWidth: 0,
    height: 5,
    backgroundColor: COLORS.element,
    paddingLeft: 3,
    paddingRight: 3,
    paddingTop: 1,
    flexDirection: "column",
    overflow: "hidden"
  });
  promptOuter.add(promptPanel);

  let textarea!: OpenTuiTextarea;
  textarea = new core.TextareaRenderable(renderer, {
    width: "100%",
    maxWidth: "100%",
    minWidth: 0,
    flexShrink: 1,
    height: 1,
    initialValue,
    placeholder: "Ask anything... \"Fix a TODO in the codebase\"  / for commands",
    placeholderColor: COLORS.muted,
    textColor: COLORS.text,
    focusedTextColor: COLORS.text,
    backgroundColor: COLORS.element,
    focusedBackgroundColor: COLORS.element,
    cursorColor: COLORS.text,
    wrapMode: "word",
    overflow: "hidden",
    onSubmit: () => {
      const value = textarea.plainText;
      textarea.clear();
      if (value.trim()) onSubmit(value);
    }
  });
  const syncPromptHeight = (notifyContentChange = false) => setImmediate(() => {
    if (textarea.isDestroyed || promptOuter.isDestroyed || promptPanel.isDestroyed) return;
    const rows = promptHeightForVisualLines(textarea.editorView.getTotalVirtualLineCount() || textarea.lineCount || 1);
    textarea.height = rows;
    promptOuter.height = rows + 4;
    promptPanel.height = rows + 4;
    accent.height = rows + 4;
    if (notifyContentChange) onContentChange?.();
    renderer.requestRender();
  });
  if (initialValue) textarea.cursorOffset = initialValue.length;
  promptPanel.add(textarea);

  const meta = new core.TextRenderable(renderer, {
    content: modelLine(core, state, controls),
    fg: COLORS.primary,
    bg: COLORS.element,
    height: 1,
    marginTop: 1,
    wrapMode: "none",
    truncate: true
  });
  promptPanel.add(meta);

  const hint = new core.TextRenderable(renderer, {
    content: hintText,
    fg: COLORS.muted,
    bg: COLORS.element,
    height: 1,
    wrapMode: "none"
  });
  promptPanel.add(hint);
  syncPromptHeight();
  renderer.once("frame", () => {
    textarea.onContentChange = () => syncPromptHeight(true);
  });

  const resize = (nextWidth: number) => {
    const bounded = Math.max(20, Math.round(nextWidth));
    promptOuter.width = bounded;
    promptOuter.maxWidth = bounded;
    promptPanel.width = Math.max(1, bounded - 1);
    promptPanel.maxWidth = Math.max(1, bounded - 1);
    renderer.once("frame", () => syncPromptHeight());
    renderer.requestRender();
  };
  return { textarea, anchor: promptOuter, meta, resize };
}

function shouldFollowLatest(scroll: OpenTuiScrollBox): boolean {
  return shouldFollowLatestPosition(scroll.scrollHeight, scroll.scrollTop, scroll.height);
}

function followLatestAfterLayout(renderer: OpenTuiRenderer, scroll: OpenTuiScrollBox, shouldFollow: boolean): void {
  if (!shouldFollow) return;
  setImmediate(() => {
    scroll.scrollTo(scroll.scrollHeight);
    renderer.requestRender();
  });
}

function reasoningDisclosureHeaders(root: OpenTuiRoot): OpenTuiRenderable[] {
  return Array.from({ length: reasoningDisclosureCount }, (_, index) => (
    root.findDescendantById(`${REASONING_DISCLOSURE_ID_PREFIX}${index + 1}`)
  )).flatMap(header => header === undefined ? [] : [header]);
}

export function appendMessage(core: OpenTuiCore, renderer: OpenTuiRenderer, scroll: OpenTuiScrollBox, role: "user" | "assistant" | "system", text: string, state: TuiState, receipt?: TurnReceipt, reasoning?: string): OpenTuiBox {
  const follow = shouldFollowLatest(scroll);
  const agent = sanitizeDisplayValue(state.defaultAgent, "default");
  const model = sanitizeDisplayValue(state.modelDisplayName ?? state.model, "mock");
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
    box.add(new core.TextRenderable(renderer, { content: sanitizeMultilineDisplayValue(text, ""), fg: COLORS.text, bg: COLORS.panel, wrapMode: "word", height: "auto" }));
    box.add(new core.TextRenderable(renderer, { content: `Sent to ${agent} · ${model}`, fg: COLORS.muted, bg: COLORS.panel, wrapMode: "none", height: 1, marginTop: 1 }));
    scroll.add(box);
    followLatestAfterLayout(renderer, scroll, follow);
    return box;
  }

  const box = new core.BoxRenderable(renderer, {
    width: "100%",
    paddingLeft: 3,
    marginTop: 1,
    flexDirection: "column"
  });
  const completedReasoning = role === "assistant" ? sanitizeMultilineDisplayValue(reasoning, "") : "";
  if (completedReasoning.trim()) {
    let expanded = false;
    let hovered = false;
    const reasoningPanel = new core.BoxRenderable(renderer, {
      width: "100%",
      flexDirection: "column",
      border: ["left"],
      customBorderChars: { vertical: "┃", topLeft: "", bottomLeft: "", horizontal: " ", topRight: "", bottomRight: "", topT: "", bottomT: "", leftT: "", rightT: "", cross: "" },
      borderColor: COLORS.border,
      backgroundColor: COLORS.panel,
      paddingLeft: 1,
      paddingRight: 1,
      marginBottom: 1
    });
    const body = new core.TextRenderable(renderer, {
      content: completedReasoning,
      fg: COLORS.text,
      bg: COLORS.panel,
      wrapMode: "word",
      height: "auto",
      visible: false
    });
    const header = new core.BoxRenderable(renderer, {
      id: `${REASONING_DISCLOSURE_ID_PREFIX}${++reasoningDisclosureCount}`,
      width: "100%",
      height: 1,
      focusable: true,
      backgroundColor: COLORS.panel,
      onMouseOver: () => {
        hovered = true;
        refreshReasoningStyle();
      },
      onMouseOut: () => {
        hovered = false;
        refreshReasoningStyle();
      },
      onMouseDown: event => {
        if (event.button !== 0) return;
        event.preventDefault();
        toggleReasoning();
      },
      onKeyDown: key => {
        const name = key.name.toLowerCase();
        if (name !== "return" && name !== "enter" && name !== "space") return;
        key.preventDefault();
        key.stopPropagation();
        toggleReasoning();
      }
    });
    const label = new core.TextRenderable(renderer, { content: "[+] Reasoning", fg: COLORS.muted, bg: COLORS.panel, height: 1, wrapMode: "none" });
    const refreshReasoningStyle = (): void => {
      const active = header.focused || expanded;
      const background = !active && hovered ? COLORS.element : COLORS.panel;
      header.backgroundColor = background;
      label.bg = background;
      label.fg = active ? COLORS.primary : hovered ? COLORS.text : COLORS.muted;
      renderer.requestRender();
    };
    const toggleReasoning = (): void => {
      const follow = shouldFollowLatest(scroll);
      expanded = !expanded;
      label.content = expanded ? "[-] Reasoning" : "[+] Reasoning";
      refreshReasoningStyle();
      body.visible = expanded;
      followLatestAfterLayout(renderer, scroll, follow);
    };
    header.on(core.RenderableEvents.FOCUSED, refreshReasoningStyle);
    header.on(core.RenderableEvents.BLURRED, refreshReasoningStyle);
    const cleanupReasoningStyleListeners = (): void => {
      header.off(core.RenderableEvents.FOCUSED, refreshReasoningStyle);
      header.off(core.RenderableEvents.BLURRED, refreshReasoningStyle);
    };
    header.on(core.RenderableEvents.DESTROYED, cleanupReasoningStyleListeners);
    header.add(label);
    reasoningPanel.add(header);
    reasoningPanel.add(body);
    box.add(reasoningPanel);
  }
  box.add(new core.TextRenderable(renderer, { content: sanitizeMultilineDisplayValue(text, ""), fg: role === "system" ? COLORS.warning : COLORS.text, wrapMode: "word", height: "auto" }));
  if (role === "assistant") {
    const completion = receipt ?? { status: "finished", agent, model, durationMs: Number.NaN, toolCalls: Number.NaN };
    box.add(new core.TextRenderable(renderer, {
      content: `${turnStatusIcon(completion.status)} ${turnReceiptLine(completion)}`,
      fg: completion.status === "failed" ? COLORS.warning : COLORS.muted,
      height: 1,
      wrapMode: "none",
      marginTop: 1
    }));
  }
  scroll.add(box);
  followLatestAfterLayout(renderer, scroll, follow);
  return box;
}

export function appendPendingMessage(core: OpenTuiCore, renderer: OpenTuiRenderer, scroll: OpenTuiScrollBox, state: TuiState, startedAt: number): { box: OpenTuiBox; status: OpenTuiText; stop(): void } {
  const follow = shouldFollowLatest(scroll);
  const agent = sanitizeDisplayValue(state.defaultAgent, "default");
  const model = sanitizeDisplayValue(state.modelDisplayName ?? state.model, "mock");
  const box = new core.BoxRenderable(renderer, { width: "100%", paddingLeft: 3, marginTop: 1, flexDirection: "column" });
  const status = new core.TextRenderable(renderer, { content: `◌ ${agent} is working · ${model} · 0s`, fg: COLORS.secondary, height: 1, wrapMode: "none" });
  box.add(status);
  scroll.add(box);
  followLatestAfterLayout(renderer, scroll, follow);
  let stopped = false;
  const timer = setInterval(() => {
    if (status.isDestroyed || renderer.isDestroyed) {
      clearInterval(timer);
      stopped = true;
      return;
    }
    status.content = `◌ ${agent} is working · ${model} · ${Math.max(1, Math.floor((Date.now() - startedAt) / 1000))}s`;
    renderer.requestRender();
  }, 1000);
  return {
    box,
    status,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (!scroll.isDestroyed && scroll.getRenderable(box.id)) scroll.remove(box.id);
      if (!renderer.isDestroyed) renderer.requestRender();
    }
  };
}

function addSlashCommandOverlay(core: OpenTuiCore, renderer: OpenTuiRenderer, parent: OpenTuiBox, services: TuiServices, callbacks: Pick<ProviderDialogCallbacks, "onSlashFocus" | "onSlashSelect">): OpenTuiBox {
  const commands = slashCommands(services);
  const maxStart = Math.max(0, commands.length - SLASH_COMMAND_LIMIT);
  const startIndex = Math.max(0, Math.min(services.slashScrollIndex, maxStart));
  const visibleCommands = commands.slice(startIndex, startIndex + SLASH_COMMAND_LIMIT);
  const height = Math.max(1, visibleCommands.length) + 2;
  const menu = new core.BoxRenderable(renderer, {
    width: Math.max(44, Math.min(HOME_PROMPT_WIDTH, renderer.width - 4)),
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
    return menu;
  }

  const triggerWidth = Math.min(22, Math.max(...visibleCommands.map(command => command.slash.length)) + 2);
  visibleCommands.forEach((command, index) => {
    const commandIndex = index + startIndex;
    const selected = commandIndex === services.slashIndex;
    const background = selected ? COLORS.primary : COLORS.panel;
    const foreground = selected ? COLORS.background : COLORS.text;
    const muted = selected ? COLORS.background : COLORS.muted;
    const row = new core.BoxRenderable(renderer, {
      id: `slash-command-${command.id}`,
      width: "100%",
      height: 1,
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: background,
      flexDirection: "row",
      onMouseOver: () => callbacks.onSlashFocus(commandIndex),
      onMouseDown: event => {
        if (event.button === 0) callbacks.onSlashSelect(commandIndex);
      }
    });
    row.add(new core.TextRenderable(renderer, { content: command.slash.padEnd(triggerWidth), fg: foreground, bg: background, width: triggerWidth, height: 1 }));
    row.add(new core.TextRenderable(renderer, { content: sanitizeDisplayValue(command.description, ""), fg: muted, bg: background, height: 1, wrapMode: "none" }));
    menu.add(row);
  });
  return menu;
}

function removeSessionSlashCommandOverlay(root: OpenTuiRoot): void {
  if (root.getRenderable("session-slash-overlay")) root.remove("session-slash-overlay");
}

function addSessionSlashCommandOverlay(core: OpenTuiCore, renderer: OpenTuiRenderer, services: TuiServices, callbacks: Pick<ProviderDialogCallbacks, "onSlashFocus" | "onSlashSelect">): void {
  removeSessionSlashCommandOverlay(renderer.root);
  const width = Math.max(44, Math.min(HOME_PROMPT_WIDTH, renderer.width - 4));
  const layer = new core.BoxRenderable(renderer, {
    id: "session-slash-overlay",
    position: "absolute",
    left: Math.max(0, Math.floor((renderer.width - width) / 2)),
    bottom: 6,
    width,
    height: Math.min(SLASH_COMMAND_LIMIT, Math.max(1, slashCommands(services).length)) + 2,
    zIndex: 85,
    flexDirection: "column"
  });
  renderer.root.add(layer);
  addSlashCommandOverlay(core, renderer, layer, services, callbacks);
  renderer.requestRender();
}

export interface ProviderDialogCallbacks {
  onSlashFocus(index: number): void;
  onSlashSelect(index: number): void;
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
      onMouseDown: event => {
        if (event.button === 0) callbacks.onProviderSelect(index);
      }
    });
    if (option.connected) row.add(new core.TextRenderable(renderer, { content: "✓", fg: selected ? foreground : COLORS.success, bg: background, width: 2, height: 1 }));
    row.add(new core.TextRenderable(renderer, { content: `${option.description ? `${option.description} · ` : ""}${option.title}`, fg: foreground, bg: background, height: 1, width: option.footer ? 42 : 52, wrapMode: "none" }));
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
  if (services.authProviderEndpoint) {
    body.add(new core.TextRenderable(renderer, {
      content: `Verify endpoint before pasting: ${services.authProviderEndpoint}`,
      fg: COLORS.warning,
      bg: COLORS.panel,
      height: 1,
      wrapMode: "word"
    }));
  }

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
    attributes: core.createTextAttributes({ hidden: true }),
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
    onMouseDown: () => callbacks.onCustomProviderFieldFocus(index)
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
    attributes: field.secret ? core.createTextAttributes({ hidden: true }) : undefined,
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
    onMouseDown: event => {
      if (event.button !== 0) return;
      services.customProviderForm.focusIndex = CUSTOM_PROVIDER_DISCOVER_INDEX;
      callbacks.onCustomProviderDiscover();
    }
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
      onMouseDown: event => {
        if (event.button !== 0) return;
        services.customProviderForm.focusIndex = CUSTOM_PROVIDER_DISCOVER_INDEX;
        services.customProviderForm.selectedModelIndex = index;
        callbacks.onCustomProviderModelToggle(index);
      }
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
      onMouseDown: event => {
        if (event.button === 0) callbacks.onProviderAuthMethodSelect(index);
      }
    });
    row.add(new core.TextRenderable(renderer, { content: method.label, fg: foreground, bg: background, height: 1, width: 52, wrapMode: "none" }));
    scroll.add(row);
  });
  return modal;
}

function addModelSelectDialog(core: OpenTuiCore, renderer: OpenTuiRenderer, parent: OpenTuiBox, runtime: RuntimeState, services: TuiServices, callbacks: ProviderDialogCallbacks): OpenTuiBox {
  const agent = sanitizeDisplayValue(runtime.state.defaultAgent, runtime.activeAgentId ?? runtime.config?.defaultAgent ?? "agent");
  const title = services.modelProviderFilter && runtime.config
    ? `${sanitizeDisplayValue(runtime.config.providers[services.modelProviderFilter]?.displayName ?? services.modelProviderFilter, services.modelProviderFilter)} · ${agent}`
    : `Select model for ${agent}`;
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
      onMouseDown: event => {
        if (event.button === 0) callbacks.onModelSelect(index);
      }
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

const PROVIDER_POPUP_BACKDROP_ID = "provider-popup-backdrop";
const PROVIDER_POPUP_LAYER_ID = "provider-popup-layer";

export function removeProviderPopupLayer(root: OpenTuiRoot): void {
  for (const id of [PROVIDER_POPUP_LAYER_ID, PROVIDER_POPUP_BACKDROP_ID]) {
    if (root.getRenderable(id)) root.remove(id);
  }
}

export function addProviderPopupLayer(core: OpenTuiCore, renderer: OpenTuiRenderer, parent: OpenTuiRoot, runtime: RuntimeState, services: TuiServices, callbacks: ProviderDialogCallbacks): OpenTuiDialogFocus | undefined {
  removeProviderPopupLayer(parent);
  const backdrop = new core.BoxRenderable(renderer, {
    id: PROVIDER_POPUP_BACKDROP_ID,
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
    id: PROVIDER_POPUP_LAYER_ID,
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

export function refreshProviderPopupLayer(core: OpenTuiCore, renderer: OpenTuiRenderer, runtime: RuntimeState, services: TuiServices, callbacks: ProviderDialogCallbacks): OpenTuiDialogFocus | undefined {
  const focus = addProviderPopupLayer(core, renderer, renderer.root, runtime, services, callbacks);
  focus?.focus();
  if (focus) renderer.focusRenderable(focus);
  renderer.requestRender();
  return focus;
}

export function closeProviderPopupLayer(renderer: OpenTuiRenderer, restoreTarget?: OpenTuiRenderable): void {
  removeProviderPopupLayer(renderer.root);
  if (restoreTarget && !restoreTarget.isDestroyed) {
    restoreTarget.focus();
    renderer.focusRenderable(restoreTarget);
  }
  renderer.requestRender();
}

function activeModelLabel(state: TuiState): string {
  return sanitizeDisplayValue(state.modelDisplayName ?? state.model, "mock");
}

function mcpLoadedLabel(count: number | undefined, compact = false): string {
  if (count === undefined || !Number.isFinite(count)) return compact ? "— MCP" : "— MCPs loaded";
  const loaded = Math.max(0, Math.round(count));
  return compact ? `${loaded} MCP` : `${loaded} MCP${loaded === 1 ? "" : "s"} loaded`;
}

interface ResponsiveChrome {
  update(width: number): void;
  setSummary?(summary: string): void;
}

function addAppHeader(core: OpenTuiCore, renderer: OpenTuiRenderer, parent: OpenTuiRoot | OpenTuiBox, title: string, state: TuiState, services: TuiServices): ResponsiveChrome {
  const header = new core.BoxRenderable(renderer, {
    width: "100%",
    height: 3,
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 2,
    paddingRight: 1,
    border: ["bottom"],
    borderColor: COLORS.border,
    backgroundColor: COLORS.panel
  });
  parent.add(header);

  const titleText = new core.TextRenderable(renderer, {
    content: "",
    fg: COLORS.text,
    bg: COLORS.panel,
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 12,
    height: 1,
    wrapMode: "none"
  });
  header.add(titleText);
  const summaryText = new core.TextRenderable(renderer, {
    content: "",
    fg: COLORS.muted,
    bg: COLORS.panel,
    width: 48,
    height: 1,
    wrapMode: "none",
    onMouseDown: event => {
      event.preventDefault();
      event.stopPropagation();
      services.onSummary?.();
    }
  });
  header.add(summaryText);
  header.add(new core.TextRenderable(renderer, {
    content: `v${STRONGCODE_VERSION}`,
    fg: COLORS.primary,
    bg: COLORS.panel,
    width: 7,
    height: 1,
    wrapMode: "none"
  }));

  const update = (width: number) => {
    const compactTokens = services.telemetry.totalTokens === undefined
      ? "—"
      : services.telemetry.totalTokens < 1000
        ? `${Math.round(services.telemetry.totalTokens)}`
        : `${(services.telemetry.totalTokens / 1000).toFixed(services.telemetry.totalTokens < 10_000 ? 1 : 0)}k`;
    const compactCost = services.telemetry.costUsd === undefined ? "$—" : `$${services.telemetry.costUsd.toFixed(2)}`;
    const narrow = width < 100;
    const veryNarrow = width < 72;
    titleText.content = `◆ STRONGCODE / ${compactSessionTitle(title, narrow ? 20 : 42)}`;
    summaryText.content = narrow
      ? veryNarrow
        ? `  ${activeModelLabel(state).slice(0, 6)} ${compactTokens} F2`
        : `  ${activeModelLabel(state).slice(0, 8)} · ${compactTokens} · ${compactCost} · F2`
      : `  ${activeModelLabel(state)}  ${formatTokens(services.telemetry.totalTokens)} · ${formatCost(services.telemetry.costUsd)}  [ Summary F2 ]`;
    summaryText.width = veryNarrow ? 16 : narrow ? 31 : 52;
  };
  update(renderer.width);
  return { update };
}

function addAppFooter(core: OpenTuiCore, renderer: OpenTuiRenderer, parent: OpenTuiRoot | OpenTuiBox, state: TuiState, services: TuiServices): ResponsiveChrome {
  const footer = new core.BoxRenderable(renderer, {
    width: "100%",
    height: 1,
    flexShrink: 0,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingLeft: 2,
    paddingRight: 2
  });
  parent.add(footer);
  const quickSummary = new core.TextRenderable(renderer, {
    content: `Quick summary · ${sanitizeDisplayValue(state.workspace, ".")}`,
    fg: COLORS.muted,
    flexGrow: 1,
    minWidth: 12,
    height: 1,
    wrapMode: "none"
  });
  footer.add(quickSummary);
  const status = new core.TextRenderable(renderer, {
    content: "",
    fg: COLORS.muted,
    width: 36,
    height: 1,
    wrapMode: "none"
  });
  footer.add(status);
  const update = (width: number) => {
    const narrow = width < 100;
    const veryNarrow = width < 72;
    status.content = veryNarrow
      ? `  ${mcpLoadedLabel(services.telemetry.mcpServersLoaded, true)} · Ctrl+H`
      : narrow
        ? `  ${mcpLoadedLabel(services.telemetry.mcpServersLoaded)} · Ctrl+H`
        : `  ${mcpLoadedLabel(services.telemetry.mcpServersLoaded)} · Ctrl+H commands`;
    status.width = veryNarrow ? 18 : narrow ? 26 : 36;
  };
  update(renderer.width);
  return {
    update,
    setSummary(summary: string) {
      quickSummary.content = `Quick summary · ${compactSessionTitle(summary, 44)}`;
    }
  };
}

interface SessionSummaryElements {
  rail: OpenTuiBox;
  refresh(): void;
}

function addSessionSummary(core: OpenTuiCore, renderer: OpenTuiRenderer, parent: OpenTuiBox, runtime: RuntimeState, services: TuiServices): SessionSummaryElements {
  const rail = new core.BoxRenderable(renderer, {
    id: "session-summary-rail",
    width: 32,
    height: "100%",
    flexShrink: 0,
    flexDirection: "column",
    backgroundColor: COLORS.panel,
    border: ["left"],
    borderColor: COLORS.border,
    paddingTop: 1,
    paddingLeft: 2,
    paddingRight: 2
  });
  parent.add(rail);
  addText(core, renderer, rail, "SESSION SUMMARY", { fg: COLORS.primary, bg: COLORS.panel, height: 1 });
  addText(core, renderer, rail, "──────────────────────────", { fg: COLORS.border, bg: COLORS.panel, height: 1 });
  const detail = addText(core, renderer, rail, "", {
    fg: COLORS.muted,
    bg: COLORS.panel,
    height: "auto",
    wrapMode: "word",
    onMouseDown: event => {
      event.preventDefault();
      event.stopPropagation();
      services.onSummary?.();
    }
  });
  const refresh = () => {
    detail.content = summaryRailLines(services.telemetry).join("\n");
  };
  refresh();
  return { rail, refresh };
}

export interface HomeView {
  textarea: OpenTuiTextarea;
  prompt: PromptElements;
  resize(width: number): void;
}

export function buildHome(core: OpenTuiCore, renderer: OpenTuiRenderer, runtime: RuntimeState, services: TuiServices, onSubmit: (input: string) => void, onContentChange: (() => void) | undefined, callbacks: ProviderDialogCallbacks): HomeView {
  const root = renderer.root;
  clearBox(root);
  root.flexDirection = "column";
  let dialogFocus: OpenTuiDialogFocus | undefined;

  const header = addAppHeader(core, renderer, root, "Ready when you are", runtime.state, services);

  const container = new core.BoxRenderable(renderer, {
    flexGrow: 1,
    width: "100%",
    minWidth: 0,
    minHeight: 0,
    flexDirection: "column",
    alignItems: "center",
    paddingLeft: 2,
    paddingRight: 2
  });
  root.add(container);

  const openCodeDialog = isOpenCodeDialogOverlay(services);
  const homeContentWidth = Math.max(44, Math.min(HOME_PROMPT_WIDTH, renderer.width - 4));
  container.add(new core.BoxRenderable(renderer, { flexGrow: 1, minHeight: 0 }));
  const wideLogo = new core.BoxRenderable(renderer, {
    width: STRONGCODE_WORDMARK_WIDTH,
    height: STRONGCODE_WORDMARK_HEIGHT,
    flexShrink: 0,
    flexDirection: "column"
  });
  STRONGCODE_WORDMARK.left.forEach((left, index) => {
    const row = new core.BoxRenderable(renderer, {
      width: STRONGCODE_WORDMARK_WIDTH,
      height: 1,
      flexShrink: 0,
      flexDirection: "row"
    });
    addText(core, renderer, row, decodeWordmarkLine(left), {
      fg: COLORS.muted,
      width: STRONGCODE_WORDMARK_LEFT_WIDTH,
      height: 1,
      wrapMode: "none"
    });
    row.add(new core.BoxRenderable(renderer, { width: STRONGCODE_WORDMARK_GAP, height: 1, flexShrink: 0 }));
    addText(core, renderer, row, decodeWordmarkLine(STRONGCODE_WORDMARK.right[index] ?? ""), {
      fg: COLORS.primary,
      width: STRONGCODE_WORDMARK_RIGHT_WIDTH,
      height: 1,
      wrapMode: "none"
    });
    wideLogo.add(row);
  });
  container.add(wideLogo);
  const compactLogo = addText(core, renderer, container, "◆ STRONGCODE", { fg: COLORS.primary, width: 12, height: 1, wrapMode: "none" });
  wideLogo.visible = renderer.width >= STRONGCODE_WORDMARK_MIN_VIEWPORT;
  compactLogo.visible = renderer.width < STRONGCODE_WORDMARK_MIN_VIEWPORT;
  container.add(new core.BoxRenderable(renderer, { height: 1, minHeight: 0, flexShrink: 1 }));
  let inlineOverlay: OpenTuiBox | undefined;
  if (services.startupOverlay !== "none" || services.dialogs.active()) {
    if (services.startupOverlay !== "slashCommands" && !openCodeDialog) {
      const overlay = new core.BoxRenderable(renderer, { width: homeContentWidth, flexDirection: "column", border: true, borderColor: COLORS.secondary, paddingLeft: 1, paddingRight: 1, paddingTop: 1, paddingBottom: 1, flexShrink: 0 });
      container.add(overlay);
      inlineOverlay = overlay;
      addMultilineText(core, renderer, overlay, renderHomeOverlayText(runtime, services), { fg: COLORS.text, height: 1 });
    }
  }
  if (services.startupOverlay === "slashCommands") {
    inlineOverlay = addSlashCommandOverlay(core, renderer, container, services, callbacks);
  }
  const prompt = createPrompt(core, renderer, container, runtime.state, services.controls, services.promptDraft, onSubmit, onContentChange, homeContentWidth);
  const textarea = prompt.textarea;
  container.add(new core.BoxRenderable(renderer, { flexGrow: 1, minHeight: 1 }));
  const footer = addAppFooter(core, renderer, root, runtime.state, services);

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
  const resize = (width: number) => {
    const contentWidth = Math.max(44, Math.min(HOME_PROMPT_WIDTH, width - 4));
    wideLogo.visible = width >= STRONGCODE_WORDMARK_MIN_VIEWPORT;
    compactLogo.visible = width < STRONGCODE_WORDMARK_MIN_VIEWPORT;
    prompt.resize(contentWidth);
    if (inlineOverlay) {
      inlineOverlay.width = contentWidth;
      inlineOverlay.maxWidth = contentWidth;
    }
    header.update(width);
    footer.update(width);
    renderer.requestRender();
  };
  return { textarea, prompt, resize };
}

export interface SessionView {
  textarea: OpenTuiTextarea;
  scroll: OpenTuiScrollBox;
  promptMeta: OpenTuiText;
  prompt: PromptElements;
  summary: SessionSummaryElements;
  header: ResponsiveChrome;
  footer: ResponsiveChrome;
  resize(width: number): void;
}

export function buildSession(core: OpenTuiCore, renderer: OpenTuiRenderer, runtime: RuntimeState, services: TuiServices, title: string, onSubmit: (input: string, scroll: OpenTuiScrollBox) => void): SessionView {
  clearBox(renderer.root);
  renderer.root.flexDirection = "column";

  const header = addAppHeader(core, renderer, renderer.root, title, runtime.state, services);

  const body = new core.BoxRenderable(renderer, { width: "100%", flexGrow: 1, minHeight: 0, minWidth: 0, flexDirection: "row" });
  renderer.root.add(body);

  const main = new core.BoxRenderable(renderer, { flexGrow: 1, minWidth: 0, height: "100%", paddingLeft: 2, paddingRight: 2, paddingBottom: 1, flexDirection: "column", gap: 1 });
  body.add(main);

  const scroll = new core.ScrollBoxRenderable(renderer, {
    id: "session-scroll",
    flexGrow: 1,
    minHeight: 0,
    scrollY: true,
    stickyScroll: true,
    stickyStart: "bottom",
    scrollAcceleration: new core.MacOSScrollAccel(),
    verticalScrollbarOptions: {
      visible: true,
      trackOptions: { backgroundColor: COLORS.element, foregroundColor: COLORS.border }
    }
  });
  main.add(scroll);
  const summaryVisible = renderer.width >= 110;
  const promptWidth = Math.max(44, renderer.width - 4 - (summaryVisible ? 32 : 0));
  const prompt = createPrompt(core, renderer, main, runtime.state, services.controls, "", input => onSubmit(input, scroll), undefined, promptWidth, "/model list · Tab agents · Ctrl+H commands");
  const textarea = prompt.textarea;

  const summary = addSessionSummary(core, renderer, body, runtime, services);
  summary.rail.visible = summaryVisible;
  const footer = addAppFooter(core, renderer, renderer.root, runtime.state, services);

  const resize = (width: number) => {
    const showSummary = width >= 110;
    summary.rail.visible = showSummary;
    prompt.resize(Math.max(44, width - 4 - (showSummary ? 32 : 0)));
    header.update(width);
    footer.update(width);
    renderer.requestRender();
  };

  textarea.focus();
  renderer.focusRenderable(textarea);
  renderer.requestRender();
  return { textarea, scroll, promptMeta: prompt.meta, prompt, summary, header, footer, resize };
}

function removeHelpOverlay(root: OpenTuiRoot): void {
  for (const id of ["help-layer", "help-backdrop"]) {
    if (root.getRenderable(id)) root.remove(id);
  }
}

function addHelpOverlay(core: OpenTuiCore, renderer: OpenTuiRenderer): OpenTuiBox {
  removeHelpOverlay(renderer.root);
  const backdrop = new core.BoxRenderable(renderer, {
    id: "help-backdrop",
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    backgroundColor: COLORS.background,
    opacity: 0.8,
    zIndex: 200
  });
  renderer.root.add(backdrop);

  const layer = new core.BoxRenderable(renderer, {
    id: "help-layer",
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 210
  });
  renderer.root.add(layer);

  const modal = new core.BoxRenderable(renderer, {
    width: Math.max(36, Math.min(82, renderer.width - 4)),
    height: Math.max(12, Math.min(30, renderer.height - 4)),
    flexDirection: "column",
    backgroundColor: COLORS.panel,
    border: true,
    borderColor: COLORS.primary,
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 2,
    paddingRight: 2,
    focusable: true
  });
  layer.add(modal);
  addText(core, renderer, modal, "COMMANDS & SHORTCUTS", { fg: COLORS.primary, bg: COLORS.panel, height: 1 });
  addText(core, renderer, modal, "Ctrl+H or F1 closes · Esc returns to chat", { fg: COLORS.muted, bg: COLORS.panel, height: 1 });
  const scroll = new core.ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    minHeight: 0,
    marginTop: 1,
    scrollY: true,
    focusable: true,
    verticalScrollbarOptions: { visible: true, trackOptions: { backgroundColor: COLORS.element, foregroundColor: COLORS.border } }
  });
  modal.add(scroll);
  for (const line of commandHelpLines()) {
    const section = line.length > 0 && line === line.toUpperCase() && !line.startsWith("  ");
    addText(core, renderer, scroll, line || " ", { fg: section ? COLORS.primary : COLORS.text, bg: COLORS.panel, height: 1, wrapMode: "none" });
  }
  scroll.focus();
  renderer.focusRenderable(scroll);
  renderer.requestRender();
  return scroll;
}

function removeSummaryOverlay(root: OpenTuiRoot): void {
  for (const id of ["summary-layer", "summary-backdrop"]) {
    if (root.getRenderable(id)) root.remove(id);
  }
}

export function addSummaryOverlay(core: OpenTuiCore, renderer: OpenTuiRenderer, runtime: RuntimeState, services: TuiServices, title: string): OpenTuiBox {
  removeSummaryOverlay(renderer.root);
  const backdrop = new core.BoxRenderable(renderer, {
    id: "summary-backdrop",
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    backgroundColor: COLORS.background,
    opacity: 0.8,
    zIndex: 200
  });
  renderer.root.add(backdrop);

  const layer = new core.BoxRenderable(renderer, {
    id: "summary-layer",
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 210
  });
  renderer.root.add(layer);

  const modal = new core.BoxRenderable(renderer, {
    width: Math.max(36, Math.min(72, renderer.width - 4)),
    height: Math.max(12, Math.min(22, renderer.height - 4)),
    flexDirection: "column",
    backgroundColor: COLORS.panel,
    border: true,
    borderColor: COLORS.secondary,
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 2,
    paddingRight: 2,
    focusable: true
  });
  layer.add(modal);
  addText(core, renderer, modal, "SESSION SUMMARY", { fg: COLORS.primary, bg: COLORS.panel, height: 1 });
  addText(core, renderer, modal, compactSessionTitle(title, 54), { fg: COLORS.text, bg: COLORS.panel, height: 1 });
  addText(core, renderer, modal, "F2, Esc, or /summary closes", { fg: COLORS.muted, bg: COLORS.panel, height: 1 });
  const body = new core.ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    minHeight: 0,
    marginTop: 1,
    scrollY: true,
    focusable: true,
    verticalScrollbarOptions: { visible: true, trackOptions: { backgroundColor: COLORS.element, foregroundColor: COLORS.border } }
  });
  modal.add(body);
  addText(core, renderer, body, "────────────────────────────────────────────────────────", { fg: COLORS.border, bg: COLORS.panel, height: 1 });
  for (const line of summaryDetailLines(services.telemetry)) {
    addText(core, renderer, body, line || " ", { fg: line === "FIRST REQUEST" ? COLORS.primary : COLORS.text, bg: COLORS.panel, height: "auto", wrapMode: "word" });
  }
  addText(core, renderer, body, "", { bg: COLORS.panel, height: 1 });
  addText(core, renderer, body, `Agent       ${sanitizeDisplayValue(runtime.state.defaultAgent, "default")}`, { fg: COLORS.text, bg: COLORS.panel, height: 1 });
  addText(core, renderer, body, `Model       ${activeModelLabel(runtime.state)}`, { fg: COLORS.text, bg: COLORS.panel, height: 1 });
  addText(core, renderer, body, "", { bg: COLORS.panel, height: 1 });
  addText(core, renderer, body, `Reasoning   ${reasoningLabel(services.controls)}`, { fg: COLORS.muted, bg: COLORS.panel, height: 1 });
  addText(core, renderer, body, `Fast mode   ${fastModeLabel(services.controls)}`, { fg: COLORS.muted, bg: COLORS.panel, height: 1 });
  addText(core, renderer, body, "", { bg: COLORS.panel, height: 1 });
  addText(core, renderer, body, `Tokens      ${formatTokens(services.telemetry.totalTokens)}`, { fg: COLORS.muted, bg: COLORS.panel, height: 1 });
  addText(core, renderer, body, `Cost        ${formatCost(services.telemetry.costUsd)}`, { fg: COLORS.muted, bg: COLORS.panel, height: 1 });
  addText(core, renderer, body, `Tools       ${services.telemetry.toolCalls}`, { fg: COLORS.muted, bg: COLORS.panel, height: 1 });
  addText(core, renderer, body, `Skills      ${services.telemetry.skillsRead ?? "—"}`, { fg: COLORS.muted, bg: COLORS.panel, height: 1 });
  addText(core, renderer, body, `MCP loaded  ${services.telemetry.mcpServersLoaded ?? "—"}`, { fg: COLORS.muted, bg: COLORS.panel, height: 1 });
  addText(core, renderer, body, `MCP used    ${services.telemetry.mcpServersUsed ?? "—"}`, { fg: COLORS.muted, bg: COLORS.panel, height: 1 });
  addText(core, renderer, body, "", { bg: COLORS.panel, height: 1 });
  addText(core, renderer, body, "LATEST TURN", { fg: COLORS.primary, bg: COLORS.panel, height: 1 });
  addText(core, renderer, body, services.lastReceipt ? turnReceiptLine(services.lastReceipt) : "No completed turns yet.", { fg: COLORS.muted, bg: COLORS.panel, height: "auto", wrapMode: "word" });
  body.focus();
  renderer.focusRenderable(body);
  renderer.requestRender();
  return body;
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

export async function runTui(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  createRenderer?: OpenTuiCore["createCliRenderer"]
): Promise<void> {
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
  const currentSessionId = `session-${Date.now()}`;
  const runtime = await loadRuntimeState(currentSessionId).catch(error => {
    const state: TuiState = { provider: "N/A", defaultAgent: "N/A", configPath: resolveConfigPath(), configMissing: true };
    return { state, currentSessionId, error } as RuntimeState & { error: unknown };
  });
  const servicesDataDir = runtime.config
    ? resolveRuntimeAuthDataDir(
      runtime.state.configPath,
      path.resolve(path.dirname(path.resolve(runtime.state.configPath)), runtime.config.dataDir)
    )
    : undefined;
  const services = await createTuiServices(await loadTuiConfig(), servicesDataDir, runtime.state, runtime.trustedConfig === true);

  const renderer = await (createRenderer ?? core.createCliRenderer)({
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
    bindings: [
      { key: "shift+return", cmd: "input.newline", desc: "Insert new line", group: "Text Editing" },
      { key: "return", cmd: "input.submit", desc: "Submit prompt", group: "Text Editing" }
    ]
  });
  const questionSurface: QuestionSurfaceController | undefined = runtime.questionBroker
    ? mountQuestionSurface({
        core,
        renderer,
        keymap,
        theme: services.tuiConfig.theme,
        broker: runtime.questionBroker,
        simplifier: runtime.questionSimplifier
      })
    : undefined;

  let activeScroll: OpenTuiScrollBox | undefined;
  let activeHomeView: HomeView | undefined;
  let activeSessionView: SessionView | undefined;
  let sessionTitle = "New session";
  let textarea!: OpenTuiTextarea;
  let stopActivePending: (() => void) | undefined;
  let focusBeforeHelp: OpenTuiRenderable | undefined;
  let focusBeforeSummary: OpenTuiRenderable | undefined;
  let focusBeforeProviderPopup: OpenTuiRenderable | undefined;
  let customProviderDiscoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let customProviderDiscoveryRequestId = 0;
  const turnOperations = createExclusiveOperationGate();
  const mutationOperations = createExclusiveOperationGate();
  const modelRefreshes = createModelRefreshGate();
  const scrollTranscript = (action: "page-up" | "page-down" | "start" | "end" | "step-up" | "step-down"): boolean => {
    if (!activeScroll || services.startupOverlay !== "none" || services.helpOpen || services.summaryOpen) return false;
    if (action === "start") activeScroll.scrollTo(0);
    else if (action === "end") activeScroll.scrollTo(activeScroll.scrollHeight);
    else {
      const direction = action === "page-up" || action === "step-up" ? -1 : 1;
      const distance = action === "page-up" || action === "page-down" ? Math.max(3, activeScroll.height - 2) : 3;
      activeScroll.scrollBy({ x: 0, y: direction * distance });
    }
    renderer.requestRender();
    return true;
  };
  const focusReasoningDisclosure = (): boolean => {
    if (!activeSessionView || services.startupOverlay !== "none" || services.helpOpen || services.summaryOpen || services.dialogs.active()) return false;
    const headers = reasoningDisclosureHeaders(renderer.root).reverse();
    const currentFocus = renderer.currentFocusedRenderable;
    const currentIndex = currentFocus ? headers.indexOf(currentFocus) : -1;
    const target = headers[currentIndex === -1 ? 0 : (currentIndex + 1) % headers.length];
    if (!target) return false;
    target.focus();
    renderer.focusRenderable(target);
    renderer.requestRender();
    return true;
  };
  const unregisterTranscriptNavigationLayer = keymap.registerLayer({
    priority: 300,
    commands: [
      { name: "transcript.page.up", desc: "Scroll transcript up", run: () => scrollTranscript("page-up") },
      { name: "transcript.page.down", desc: "Scroll transcript down", run: () => scrollTranscript("page-down") },
      { name: "transcript.start", desc: "Go to oldest transcript message", run: () => scrollTranscript("start") },
      { name: "transcript.end", desc: "Go to latest transcript message", run: () => scrollTranscript("end") }
    ],
    bindings: [
      { key: "pageup", cmd: "transcript.page.up" },
      { key: "pagedown", cmd: "transcript.page.down" },
      { key: "ctrl+home", cmd: "transcript.start" },
      { key: "ctrl+end", cmd: "transcript.end" }
    ]
  });
  const exit = () => {
    clearCustomProviderDiscoveryTimer();
    stopActivePending?.();
    stopActivePending = undefined;
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

  const closeHelp = (): boolean => {
    if (!services.helpOpen) return false;
    services.helpOpen = false;
    removeHelpOverlay(renderer.root);
    const target = focusBeforeHelp && !focusBeforeHelp.isDestroyed
      ? focusBeforeHelp
      : activeSessionView?.textarea ?? textarea;
    focusBeforeHelp = undefined;
    target?.focus();
    if (target) renderer.focusRenderable(target);
    renderer.requestRender();
    return true;
  };
  const closeSummary = (): boolean => {
    if (!services.summaryOpen) return false;
    services.summaryOpen = false;
    removeSummaryOverlay(renderer.root);
    const target = focusBeforeSummary && !focusBeforeSummary.isDestroyed
      ? focusBeforeSummary
      : activeSessionView?.textarea ?? textarea;
    focusBeforeSummary = undefined;
    target?.focus();
    if (target) renderer.focusRenderable(target);
    renderer.requestRender();
    return true;
  };
  const toggleHelp = (): void => {
    if (closeHelp()) return;
    if (services.summaryOpen) closeSummary();
    focusBeforeHelp = renderer.currentFocusedRenderable ?? undefined;
    services.helpOpen = true;
    addHelpOverlay(core, renderer);
  };
  const toggleSummary = (): void => {
    if (closeSummary()) return;
    if (services.helpOpen) closeHelp();
    focusBeforeSummary = renderer.currentFocusedRenderable ?? undefined;
    services.summaryOpen = true;
    addSummaryOverlay(core, renderer, runtime, services, sessionTitle);
  };
  services.onSummary = toggleSummary;
  const updateSessionReceipt = (receipt: TurnReceipt) => {
    if (!activeSessionView) return;
    activeSessionView.summary.refresh();
    activeSessionView.footer.setSummary?.(turnReceiptLine(receipt));
    if (services.summaryOpen) addSummaryOverlay(core, renderer, runtime, services, sessionTitle);
    renderer.requestRender();
  };
  const refreshSessionTelemetry = async (): Promise<void> => {
    const sessionId = runtime.currentSessionId;
    if (!runtime.sessionStore || !sessionId) return;
    const stored = await runtime.sessionStore.readOrEmpty(sessionId);
    if (!stored.ok) return;
    const projected = projectSessionTelemetry(stored.value.events);
    const telemetry = { ...services.telemetry };
    delete telemetry.totalTokens;
    delete telemetry.costUsd;
    delete telemetry.costProvenance;
    delete telemetry.contextInputTokens;
    delete telemetry.contextWindowTokens;
    services.telemetry = { ...telemetry, ...projected };
    activeSessionView?.header.update(renderer.width);
    activeSessionView?.summary.refresh();
    if (services.summaryOpen) addSummaryOverlay(core, renderer, runtime, services, sessionTitle);
  };
  const reportBusy = (targetScroll = activeScroll): void => {
    if (targetScroll) appendMessage(core, renderer, targetScroll, "system", ACTIVE_TURN_BUSY_MESSAGE, runtime.state);
  };
  const operationIsBusy = (): boolean => services.turnRunning || turnOperations.isActive() || mutationOperations.isActive();
  const acquireMutationOperation = (report = true): ExclusiveOperationLease | undefined => {
    if (services.turnRunning || turnOperations.isActive()) {
      if (report) reportBusy();
      return undefined;
    }
    const lease = mutationOperations.acquire();
    if (!lease && report) reportBusy();
    return lease;
  };

  const handleSubmit = async (input: string, scroll?: OpenTuiScrollBox, approvedPlan?: ApprovedPlan): Promise<void> => {
    const parsedCommand = parseSlashCommand(input);
    const fullRoute = fullTuiRouteForInput(input);
    let mutationLease = parsedCommand && !slashCommandAllowedDuringTurn(parsedCommand)
      ? mutationOperations.acquire()
      : undefined;
    if (parsedCommand && !slashCommandAllowedDuringTurn(parsedCommand) && !mutationLease) {
      reportBusy(scroll ?? activeScroll);
      return;
    }
    const releaseMutationLease = (): void => {
      const lease = mutationLease;
      if (!lease) return;
      mutationOperations.release(lease);
      mutationLease = undefined;
    };
    const submitNestedTurn = (nestedInput: string, approvedPlan?: ApprovedPlan): Promise<void> => {
      const submitTurn = services.submitTurn;
      if (!submitTurn) return Promise.resolve();
      const lease = mutationLease;
      if (!lease) return submitTurn(nestedInput, approvedPlan);
      return releaseOperationAndSubmit(mutationOperations, lease, () => {
        if (mutationLease === lease) mutationLease = undefined;
        return submitTurn(nestedInput, approvedPlan);
      });
    };
    try {
    const busyScroll = scroll ?? activeScroll;
    if ((services.turnRunning || turnOperations.isActive()) && (!parsedCommand || !slashCommandAllowedDuringTurn(parsedCommand))) {
      if (busyScroll) appendMessage(core, renderer, busyScroll, "system", ACTIVE_TURN_BUSY_MESSAGE, runtime.state);
      return;
    }
    if (fullRoute && await openFullTuiRoute(input)) {
      return;
    }
    if (!scroll && parsedCommand) {
      const sessionView = buildSession(core, renderer, runtime, services, sessionTitle, (value, sessionScroll) => void handleSubmit(value, sessionScroll));
      activeHomeView = undefined;
      activeSessionView = sessionView;
      textarea = sessionView.textarea;
      activeScroll = sessionView.scroll;
      scroll = sessionView.scroll;
      sessionView.textarea.focus();
    }
    const append = (role: "assistant" | "system", text: string) => {
      if (scroll) appendMessage(core, renderer, scroll, role, text, runtime.state);
    };
    if (parsedCommand && parsedCommand.command !== "unknown" && await handleSystemCommand(input, runtime, services, append, exit, submitNestedTurn)) return;
    if (parsedCommand?.command === "unknown") {
      if (scroll) appendMessage(core, renderer, scroll, "system", clipDisplayLine(`Unknown command: ${parsedCommand.input}`), runtime.state);
      return;
    }

    if (!activeScroll) {
      sessionTitle = compactSessionTitle(input);
      const sessionView = buildSession(core, renderer, runtime, services, sessionTitle, (value, sessionScroll) => void handleSubmit(value, sessionScroll));
      activeHomeView = undefined;
      activeSessionView = sessionView;
      textarea = sessionView.textarea;
      activeScroll = sessionView.scroll;
      sessionView.textarea.focus();
    }

    const targetScroll = scroll ?? activeScroll;
    if (!targetScroll) return;
    if (mutationOperations.isActive()) {
      reportBusy(targetScroll);
      return;
    }
    const startedAt = Date.now();
    const turnState = { ...runtime.state };
    const receiptLabels = snapshotTurnReceiptLabels(turnState);
    const turnRunner = runtime.runner;
    const turnAgent = runtime.agent;
    if (!turnRunner || !turnAgent) {
      const receipt: TurnReceipt = {
        status: "failed",
        agent: receiptLabels.agent,
        model: receiptLabels.model,
        durationMs: Date.now() - startedAt,
        toolCalls: 0,
        skillsRead: undefined,
        mcpServersUsed: undefined
      };
      services.lastReceipt = receipt;
      updateSessionReceipt(receipt);
      appendMessage(core, renderer, targetScroll, "assistant", "Config missing. Run 'strongcode init' first.", turnState, receipt);
      return;
    }
    const planningTurn = turnAgent.name === "jbp";
    if (planningTurn) runtime.jbpPlanReceipt = undefined;
    const turnLease = acquireTurnLease(turnOperations, mutationOperations, services.turnRunning);
    if (!turnLease) {
      reportBusy(targetScroll);
      return;
    }
    services.turnRunning = true;
    let pending: ReturnType<typeof appendPendingMessage> | undefined;
    try {
      services.history.add(input);
      await services.historyStore?.save(services.history);
      appendMessage(core, renderer, targetScroll, "user", input, turnState);
      pending = appendPendingMessage(core, renderer, targetScroll, turnState, startedAt);
      stopActivePending = pending.stop;
      const result = approvedPlan
        ? await turnRunner.runApprovedPlan(turnAgent, input, currentSessionId, approvedPlan)
        : await turnRunner.run(turnAgent, input, currentSessionId);
      await refreshSessionTelemetry();
      if (planningTurn) runtime.jbpPlanReceipt = result.ok ? result.value.planReceipt : undefined;
      const receipt: TurnReceipt = {
        status: result.ok ? "finished" : "failed",
        agent: receiptLabels.agent,
        model: receiptLabels.model,
        durationMs: Date.now() - startedAt,
        toolCalls: result.ok ? result.value.toolExecutions.length : 0,
        skillsRead: undefined,
        mcpServersUsed: undefined
      };
      services.telemetry.toolCalls += receipt.toolCalls;
      services.lastReceipt = receipt;
      if (renderer.isDestroyed) return;
      updateSessionReceipt(receipt);
      appendMessage(core, renderer, targetScroll, "assistant", result.ok ? result.value.response : String(result.error), turnState, receipt, result.ok ? result.value.reasoning : undefined);
    } catch (error) {
      if (renderer.isDestroyed) return;
      const receipt: TurnReceipt = {
        status: "failed",
        agent: receiptLabels.agent,
        model: receiptLabels.model,
        durationMs: Date.now() - startedAt,
        toolCalls: 0,
        skillsRead: undefined,
        mcpServersUsed: undefined
      };
      services.lastReceipt = receipt;
      updateSessionReceipt(receipt);
      appendMessage(core, renderer, targetScroll, "assistant", error instanceof Error ? error.message : String(error), turnState, receipt);
    } finally {
      pending?.stop();
      if (pending && stopActivePending === pending.stop) stopActivePending = undefined;
      services.turnRunning = false;
      turnOperations.release(turnLease);
    }
    } finally {
      releaseMutationLease();
    }
  };
  services.submitTurn = (input, approvedPlan) => handleSubmit(input, activeScroll, approvedPlan);
  const openFullTuiRoute = async (value: string): Promise<boolean> => {
    const route = fullTuiRouteForInput(value);
    if (!route) return false;
    switch (route) {
      case "help":
        toggleHelp();
        return true;
      case "summary":
        toggleSummary();
        return true;
      case "providers":
      case "models": {
        services.modelProviderFilter = undefined;
        services.providerQuery = "";
        services.authInputDraft = "";
        services.pickerIndex = route === "providers" ? selectedProviderIndex(runtime) : selectedModelIndex(runtime);
        const modelRefresh = showOverlay(route);
        if (route === "models" && !services.turnRunning && modelRefresh) {
          const failures = await refreshAuthenticatedProviderModels(runtime);
          if (!modelRefreshes.isCurrent(modelRefresh, services.startupOverlay)) return true;
          await reloadProviderAuth(runtime, services);
          if (!modelRefreshes.isCurrent(modelRefresh, services.startupOverlay)) return true;
          failures.forEach(failure => services.toasts.push("error", clipDisplayLine(failure)));
          services.pickerIndex = selectedModelIndex(runtime);
          refreshProviderSurface();
        }
        return true;
      }
      default:
        return assertNeverCommand(route);
    }
  };
  const executeCustomProviderModelDiscovery = async (requestId = ++customProviderDiscoveryRequestId, explicit = true): Promise<void> => {
    const mutationLease = acquireMutationOperation(explicit);
    if (!mutationLease) return;
    try {
    clearCustomProviderDiscoveryTimer();
    if (requestId !== customProviderDiscoveryRequestId) return;
    const form = services.customProviderForm;
    const providerId = form.providerId.trim() || "custom";
    const baseUrl = form.baseUrl.trim();
    const apiKey = form.apiKey.trim();
    if (!baseUrl || !apiKey) {
      services.customProviderForm.discovery = { status: "error", models: [], selectedModels: [], error: "Enter Base URL and API key first." };
      refreshProviderSurface();
      return;
    }
    if (!isValidCustomProviderId(providerId)) {
      services.customProviderForm.discovery = { status: "error", models: [], selectedModels: [], error: "Provider ID must be lowercase letters, numbers, hyphens, or underscores." };
      refreshProviderSurface();
      return;
    }
    if (!isAvailableCustomProviderId(runtime.config, providerId, services.authProviderId ?? "custom")) {
      services.customProviderForm.discovery = { status: "error", models: [], selectedModels: [], error: `Provider ID '${providerId}' already exists. Use a new ID.` };
      refreshProviderSurface();
      return;
    }
    if (runtime.trustedConfig === false && !isLocalProviderBaseUrl(baseUrl)) {
      services.customProviderForm.discovery = {
        status: "error",
        models: [],
        selectedModels: [],
        error: `Refusing repository-defined endpoint ${sanitizeDisplayValue(baseUrl, "unknown")}. Review and explicitly trust the project config first.`
      };
      refreshProviderSurface();
      return;
    }
    try {
      buildModelsUrl({ baseUrl, modelsEndpoint: "/models" });
    } catch (error) {
      services.customProviderForm.discovery = { status: "error", models: [], selectedModels: [], error: `Invalid Base URL: ${error instanceof Error ? error.message : String(error)}` };
      refreshProviderSurface();
      return;
    }

    services.customProviderForm.discovery = { status: "loading", models: [], selectedModels: [] };
    refreshProviderSurface();
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
      refreshProviderSurface();
    }
    } finally {
      mutationOperations.release(mutationLease);
    }
  };
  const scheduleCustomProviderModelDiscovery = (): void => {
    clearCustomProviderDiscoveryTimer();
    const form = services.customProviderForm;
    customProviderDiscoveryRequestId += 1;
    if (operationIsBusy()) return;
    if (!shouldAutoDiscoverCustomProviderModels(form.baseUrl, form.apiKey)) {
      services.customProviderForm.discovery = defaultCustomProviderDiscovery();
      services.customProviderForm.selectedModelIndex = 0;
      return;
    }
    services.customProviderForm.discovery = { status: "loading", models: [], selectedModels: [] };
    services.customProviderForm.selectedModelIndex = 0;
    refreshProviderSurface();
    const requestId = customProviderDiscoveryRequestId;
    customProviderDiscoveryTimer = setTimeout(() => {
      customProviderDiscoveryTimer = undefined;
      void executeCustomProviderModelDiscovery(requestId, false);
    }, 450);
  };
  const executeCustomProviderFormSubmit = async (): Promise<void> => {
    const mutationLease = acquireMutationOperation();
    if (!mutationLease) return;
    try {
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
    if (!isAvailableCustomProviderId(runtime.config, providerId, services.authProviderId ?? "custom")) {
      services.toasts.push("error", `Provider ID '${providerId}' already exists. Use a new ID so saved credentials cannot be redirected.`);
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
    if (runtime.trustedConfig === false && !isLocalProviderBaseUrl(baseUrl)) {
      services.toasts.push("error", `Refusing repository-defined endpoint ${sanitizeDisplayValue(baseUrl, "unknown")}. Review and explicitly trust the project config first.`);
      showOverlay("toasts");
      return;
    }
    try {
      const updated = await persistConfigUpdate({ path: runtime.state.configPath, directory: path.dirname(runtime.state.configPath), config: runtime.config }, config => {
        const nextConfig = structuredClone(config);
        nextConfig.providers[providerId] = {
          type: "openai-compatible",
          displayName,
          apiKeyEnv: apiKeyEnvForProviderId(providerId),
          baseUrl,
          modelsEndpoint: "/models",
          allowUnauthenticated: undefined,
          enabled: true
        };
        const selectedModels = selectedCustomProviderModels(form.discovery.models, form.discovery.selectedModels);
        const configuredModelKeys: string[] = [];
        for (const modelId of selectedModels) {
          const existing = nextConfig.models[modelId];
          const key = existing && existing.provider !== providerId ? `${providerId}:${modelId}` : modelId;
          const existingForProvider = nextConfig.models[key];
          nextConfig.models[key] = {
            provider: providerId,
            model: modelId,
            enabled: true,
            source: "discovered",
            displayName: existingForProvider?.displayName ?? modelId,
            options: existingForProvider?.options
          };
          configuredModelKeys.push(key);
        }
        const firstModel = configuredModelKeys[0];
        if (firstModel && nextConfig.agents[nextConfig.defaultAgent]) {
          nextConfig.agents[nextConfig.defaultAgent].model = firstModel;
        }
        return nextConfig;
      });
      refreshRuntimeFromConfig(runtime, updated);
      refreshUiControls(runtime, services);
      await authStoreForConfig(updated, runtime.state.configPath, runtime.trustedConfig === true).set(providerId, {
        type: "api",
        key: apiKey,
        metadata: { providerType: "openai-compatible", origin: baseUrl }
      });
      await reloadProviderAuth(runtime, services);
      services.toasts.push("success", `Connected ${providerId}.`);
      services.authProviderId = undefined;
      services.authProviderTitle = undefined;
      services.authProviderEndpoint = undefined;
      services.authInputDraft = "";
      services.customProviderForm = defaultCustomProviderForm();
      services.modelProviderFilter = providerId;
      services.pickerIndex = selectedModelIndexForProvider(runtime, providerId);
      showOverlay("models");
    } catch (error) {
      services.toasts.push("error", `Error: ${error instanceof Error ? error.message : String(error)}`);
      showOverlay("toasts");
    }
    } finally {
      mutationOperations.release(mutationLease);
    }
  };
  const executeProviderAuthSubmit = async (apiKey: string): Promise<void> => {
    if (services.authProviderId === "custom") {
      await executeCustomProviderFormSubmit();
      return;
    }
    const mutationLease = acquireMutationOperation();
    if (!mutationLease) return;
    try {
    const providerId = services.authProviderId;
    if (!providerId || !apiKey.trim()) {
      services.authInputDraft = "";
      showOverlay("none");
      return;
    }
    const response = await handleConnectCommand(`/connect ${providerId} ${apiKey.trim()}`, {
      config: runtime.config,
      configPath: runtime.state.configPath,
      state: runtime.state,
      noColor: true,
      trustedConfig: runtime.trustedConfig,
      onConfigUpdated: config => {
        refreshRuntimeFromConfig(runtime, config);
        refreshUiControls(runtime, services);
        services.toasts.push("success", `Connected ${providerId}.`);
      }
    });
    await reloadProviderAuth(runtime, services);
    services.authProviderId = undefined;
    services.authProviderTitle = undefined;
    services.authProviderEndpoint = undefined;
    services.authInputDraft = "";
    if (response.startsWith("Error:") || response.startsWith("Unknown provider") || response.startsWith("Usage:") || response.startsWith("Refusing")) {
      services.toasts.push("error", response);
      showOverlay("toasts");
      return;
    }
    services.modelProviderFilter = providerId;
    services.pickerIndex = selectedModelIndexForProvider(runtime, providerId);
    showOverlay("models");
    } finally {
      mutationOperations.release(mutationLease);
    }
  };
  const submitHomeValue = async (value: string): Promise<void> => {
    if (services.startupOverlay === "providerAuth") {
      services.promptDraft = "";
      void executeProviderAuthSubmit(value);
      return;
    }
    services.promptDraft = "";
    services.startupOverlay = "none";
    if (fullTuiRouteForInput(value) && await openFullTuiRoute(value)) return;
    if (value) void handleSubmit(value);
  };
  const submitPrompt = () => {
    const value = textarea.plainText.trim();
    textarea.clear();
    void submitHomeValue(value);
  };
  const refreshProviderSurface = (): void => {
    if (activeSessionView) {
      refreshProviderPopupLayer(core, renderer, runtime, services, providerDialogCallbacks);
      return;
    }
    rebuildHome();
  };
  const providerDialogCallbacks: ProviderDialogCallbacks = {
    onSlashFocus(index) {
      if (services.slashIndex === index) return;
      services.slashIndex = index;
      rebuildHome();
    },
    onSlashSelect(index) {
      services.slashIndex = index;
      void executeSlashSelection(textarea.plainText);
    },
    onProviderSelect(index) {
      services.pickerIndex = index;
      executeProviderSelection();
    },
    onProviderQueryChange() {
      refreshProviderSurface();
    },
    onProviderAuthMethodSelect(index) {
      if (operationIsBusy()) {
        reportBusy();
        return;
      }
      services.pickerIndex = index;
      void executeProviderAuthMethodSelection();
    },
    onProviderAuthSubmit(value) {
      if (operationIsBusy()) {
        reportBusy();
        return;
      }
      services.authInputDraft = value;
      void executeProviderAuthSubmit(value);
    },
    onCustomProviderFieldFocus(index) {
      services.customProviderForm.focusIndex = Math.max(0, Math.min(index, CUSTOM_PROVIDER_FOCUS_COUNT - 1));
      refreshProviderSurface();
    },
    onCustomProviderFieldChange(field) {
      if (field === "baseUrl" || field === "apiKey") {
        clearCustomProviderDiscoveryTimer();
        customProviderDiscoveryRequestId += 1;
        services.customProviderForm.discovery = defaultCustomProviderDiscovery();
        services.customProviderForm.selectedModelIndex = 0;
      }
    },
    onCustomProviderDiscover() {
      void executeCustomProviderModelDiscovery();
    },
    onCustomProviderModelToggle(index) {
      if (operationIsBusy()) {
        reportBusy();
        return;
      }
      const discovery = services.customProviderForm.discovery;
      const modelId = discovery.models[index];
      if (!modelId) return;
      services.customProviderForm.selectedModelIndex = index;
      services.customProviderForm.discovery = {
        ...discovery,
        selectedModels: toggleCustomProviderSelectedModel(discovery.models, discovery.selectedModels, modelId)
      };
      refreshProviderSurface();
    },
    onCustomProviderSubmit() {
      void executeCustomProviderFormSubmit();
    },
    onModelSelect(index) {
      if (operationIsBusy()) {
        reportBusy();
        return;
      }
      services.pickerIndex = index;
      void executeModelSelection();
    }
  };
  const rebuildHome = () => {
    activeSessionView = undefined;
    activeScroll = undefined;
    activeHomeView = buildHome(core, renderer, runtime, services, value => {
      if (shouldSubmitHomeValue(services.startupOverlay, value)) void submitHomeValue(value);
      else if (services.startupOverlay === "slashCommands") void executeSlashSelection(value);
    }, () => syncSlashOverlay(), providerDialogCallbacks);
    textarea = activeHomeView.textarea;
  };
  services.onAgentChanged = () => {
    if (activeHomeView) {
      rebuildHome();
      return;
    }
    if (activeSessionView) {
      activeSessionView.prompt.meta.content = modelLine(core, runtime.state, services.controls);
      activeSessionView.summary.refresh();
      renderer.requestRender();
    }
  };
  const showOverlay = (overlay: TuiServices["startupOverlay"]): ModelRefreshToken | undefined => {
    const modelRefresh = overlay === "models" ? modelRefreshes.begin() : undefined;
    if (!modelRefresh) modelRefreshes.invalidate();
    services.startupOverlay = overlay;
    services.dialogs.close();
    if (activeSessionView) {
      if (isOpenCodeDialogOverlay(services)) {
        if (!focusBeforeProviderPopup || focusBeforeProviderPopup.isDestroyed) {
          focusBeforeProviderPopup = renderer.currentFocusedRenderable ?? activeSessionView.textarea;
        }
        refreshProviderSurface();
      } else {
        const restoreTarget = focusBeforeProviderPopup && !focusBeforeProviderPopup.isDestroyed
          ? focusBeforeProviderPopup
          : activeSessionView.textarea;
        focusBeforeProviderPopup = undefined;
        closeProviderPopupLayer(renderer, restoreTarget);
      }
      return modelRefresh;
    }
    rebuildHome();
    return modelRefresh;
  };
  const refreshSlashSurface = () => {
    if (!activeSessionView) {
      rebuildHome();
      return;
    }
    addSessionSlashCommandOverlay(core, renderer, services, {
      onSlashFocus(index) {
        if (services.slashIndex === index) return;
        services.slashIndex = index;
        refreshSlashSurface();
      },
      onSlashSelect(index) {
        services.slashIndex = index;
        void executeSlashSelection(textarea.plainText);
      }
    });
    activeSessionView.textarea.focus();
    renderer.focusRenderable(activeSessionView.textarea);
  };
  const executePaletteSelection = async (): Promise<void> => {
    const selected = services.palette.selected();
    services.promptDraft = "";
    services.startupOverlay = "none";
    if (selected && await openFullTuiRoute(selected.slash)) {
      return;
    }
    if (selected) void handleSubmit(selected.slash);
  };
  const executeSlashSelection = async (submittedText: string): Promise<void> => {
    const commands = slashCommands(services, submittedText);
    const selected = selectedSlashCommand(commands, services.slashIndex);
    const value = resolveSlashSubmission(submittedText, selected?.slash);
    const sessionScroll = activeScroll;
    services.promptDraft = "";
    services.startupOverlay = "none";
    removeSessionSlashCommandOverlay(renderer.root);
    if (value) {
      textarea.clear();
      if (await openFullTuiRoute(value)) {
        return;
      }
      void handleSubmit(value, sessionScroll);
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
    refreshSlashSurface();
    return true;
  };
  const closeSlashSelection = (): boolean => {
    if (services.startupOverlay !== "slashCommands") return false;
    services.promptDraft = "";
    services.slashIndex = 0;
    services.slashScrollIndex = 0;
    textarea.clear();
    services.startupOverlay = "none";
    if (activeSessionView) {
      removeSessionSlashCommandOverlay(renderer.root);
      activeSessionView.textarea.focus();
      renderer.focusRenderable(activeSessionView.textarea);
      renderer.requestRender();
    } else {
      rebuildHome();
    }
    return true;
  };
  const moveProviderSelection = (delta: -1 | 1): boolean => {
    if (services.startupOverlay !== "providers") return false;
    const providers = providerPickerEntries(runtime, services.providerQuery);
    services.pickerIndex = nextSelectionIndex(services.pickerIndex, providers.length, delta);
    refreshProviderSurface();
    return true;
  };
  const moveProviderAuthMethodSelection = (delta: -1 | 1): boolean => {
    if (services.startupOverlay !== "providerAuthMethod" || !services.authProviderId) return false;
    const methods = providerAuthMethods(runtime, services.authProviderId);
    services.pickerIndex = nextSelectionIndex(services.pickerIndex, methods.length, delta);
    refreshProviderSurface();
    return true;
  };
  const moveCustomProviderFormFocus = (delta: -1 | 1): boolean => {
    if (services.startupOverlay !== "providerAuth" || services.authProviderId !== "custom") return false;
    services.customProviderForm.focusIndex = nextSelectionIndex(services.customProviderForm.focusIndex, CUSTOM_PROVIDER_FOCUS_COUNT, delta);
    services.customProviderForm.selectedModelIndex = Math.max(0, Math.min(services.customProviderForm.selectedModelIndex, Math.max(0, services.customProviderForm.discovery.models.length - 1)));
    refreshProviderSurface();
    return true;
  };
  const moveCustomProviderModelSelection = (delta: -1 | 1): boolean => {
    if (services.startupOverlay !== "providerAuth" || services.authProviderId !== "custom") return false;
    const form = services.customProviderForm;
    if (form.focusIndex !== CUSTOM_PROVIDER_DISCOVER_INDEX || form.discovery.status !== "ready" || form.discovery.models.length === 0) return false;
    const nextIndex = form.selectedModelIndex + delta;
    if (nextIndex < 0 || nextIndex >= form.discovery.models.length) return false;
    form.selectedModelIndex = nextIndex;
    refreshProviderSurface();
    return true;
  };
  const toggleFocusedCustomProviderModel = (): boolean => {
    if (services.startupOverlay !== "providerAuth" || services.authProviderId !== "custom") return false;
    if (operationIsBusy()) {
      reportBusy();
      return true;
    }
    const form = services.customProviderForm;
    if (form.focusIndex !== CUSTOM_PROVIDER_DISCOVER_INDEX || form.discovery.status !== "ready") return false;
    const modelId = form.discovery.models[form.selectedModelIndex];
    if (!modelId) return false;
    form.discovery = {
      ...form.discovery,
      selectedModels: toggleCustomProviderSelectedModel(form.discovery.models, form.discovery.selectedModels, modelId)
    };
    refreshProviderSurface();
    return true;
  };
  const moveModelSelection = (delta: -1 | 1): boolean => {
    if (services.startupOverlay !== "models") return false;
    const models = modelPickerEntriesForProvider(runtime, services.modelProviderFilter);
    services.pickerIndex = nextSelectionIndex(services.pickerIndex, models.length, delta);
    refreshProviderSurface();
    return true;
  };
  const executeProviderSelection = () => {
    if (operationIsBusy()) {
      reportBusy();
      return;
    }
    if (!runtime.config) return;
    const providers = providerPickerEntries(runtime, services.providerQuery);
    const selected = providers[Math.max(0, Math.min(services.pickerIndex, providers.length - 1))];
    if (selected) {
      const [providerId, provider] = selected;
      const authOverlay = provider.type !== "mock" ? providerAuthOverlayForMethods(providerAuthMethods(runtime, providerId)) : undefined;
      const catalogProvider = createProviderCatalog(runtime.config, services.providerAuth, { allowEnvironmentCredentials: runtime.trustedConfig === true })
        .all.find(item => item.id === providerId);
      const requiresAuthentication = authOverlay === "providerAuthMethod"
        || (providerId === "custom" && authOverlay === "providerAuth")
        || (provider.type !== "mock" && !catalogProvider?.connected);
      services.providerQuery = "";
      textarea.clear();
      services.authProviderEndpoint = provider.baseUrl;
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
    if (operationIsBusy()) {
      reportBusy();
      return;
    }
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
    services.authProviderEndpoint = undefined;
    showOverlay("none");
    await handleSubmit(command);
  };
  const executeModelSelection = async () => {
    const mutationLease = acquireMutationOperation();
    if (!mutationLease) return;
    try {
    if (!runtime.config) return;
    const models = modelPickerEntriesForProvider(runtime, services.modelProviderFilter);
    const selected = models[Math.max(0, Math.min(services.pickerIndex, models.length - 1))];
    services.promptDraft = "";
    if (!selected) return;
    textarea.clear();
    try {
      const updated = await persistConfigUpdate({ path: runtime.state.configPath, directory: path.dirname(runtime.state.configPath), config: runtime.config }, config => selectModel(config, selected[0], runtime.activeAgentId ?? config.defaultAgent));
      refreshRuntimeFromConfig(runtime, updated);
      refreshUiControls(runtime, services);
      const agentLabel = sanitizeDisplayValue(runtime.state.defaultAgent, runtime.activeAgentId ?? runtime.config.defaultAgent);
      const modelLabel = sanitizeDisplayValue(selected[1].displayName ?? selected[0], selected[0]);
      services.toasts.push("success", `${agentLabel} now uses ${modelLabel}.`);
      services.onAgentChanged?.();
      services.modelProviderFilter = undefined;
      showOverlay("none");
    } catch (error) {
      services.toasts.push("error", `Error: ${error instanceof Error ? error.message : String(error)}`);
      showOverlay("toasts");
    }
    } finally {
      mutationOperations.release(mutationLease);
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
    services.authProviderEndpoint = undefined;
    services.customProviderForm = defaultCustomProviderForm();
    showOverlay("none");
    return true;
  };
  const syncSlashOverlay = () => {
    if (!shouldSyncSlashOverlay(Boolean(activeSessionView))) return;
    const draft = textarea.plainText;
    const previousQuery = slashQuery(services.promptDraft);
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
      if (activeSessionView) {
        removeSessionSlashCommandOverlay(renderer.root);
        if (services.startupOverlay === "slashCommands") services.startupOverlay = "none";
        services.promptDraft = draft;
        renderer.requestRender();
        return;
      }
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
    if (query !== previousQuery) {
      services.slashIndex = 0;
      services.slashScrollIndex = 0;
    }
    services.slashIndex = Math.max(0, Math.min(services.slashIndex, Math.max(0, commands.length - 1)));
    updateSlashScroll(commands);
    if (activeSessionView) {
      services.startupOverlay = "slashCommands";
      refreshSlashSurface();
      return;
    }
    showOverlay("slashCommands");
  };
  const cycleActivePrimaryAgent = (direction: 1 | -1): boolean => {
    if (operationIsBusy()) {
      reportBusy();
      return true;
    }
    if (services.startupOverlay !== "none" || services.helpOpen || services.summaryOpen) return false;
    try {
      const next = cyclePrimaryAgent(runtime.activeAgentId ?? runtime.config?.defaultAgent ?? "tesla", direction);
      const agent = activateRuntimeAgent(runtime, next.id);
      refreshUiControls(runtime, services);
      services.onAgentChanged?.();
      services.toasts.push("success", `Active agent: ${agent.displayName ?? agent.name}`);
    } catch (error) {
      services.toasts.push("error", `Agent switch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return true;
  };
  const unregisterAgentCycleLayer = keymap.registerLayer({
    priority: 150,
    commands: [
      { name: "agent.cycle.next", desc: "Next main agent", run: () => cycleActivePrimaryAgent(1) },
      { name: "agent.cycle.previous", desc: "Previous main agent", run: () => cycleActivePrimaryAgent(-1) }
    ],
    bindings: [
      ...services.tuiConfig.keybinds.agent_next.map(key => ({ key, cmd: "agent.cycle.next" })),
      ...services.tuiConfig.keybinds.agent_previous.map(key => ({ key, cmd: "agent.cycle.previous" }))
    ]
  });
  const unregisterReasoningFocusLayer = keymap.registerLayer({
    priority: 150,
    commands: [
      { name: "reasoning.disclosure.focus", desc: "Focus completed reasoning", run: focusReasoningDisclosure }
    ],
    bindings: services.tuiConfig.keybinds.reasoning_focus.map(key => ({ key, cmd: "reasoning.disclosure.focus" }))
  });
  const unregisterSlashNavigationLayer = keymap.registerLayer({
    priority: 400,
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
      },
      {
        name: "prompt.slash.submit",
        desc: "Run selected slash command",
        run() {
          if (services.startupOverlay !== "slashCommands") return false;
          void executeSlashSelection(textarea.plainText);
          return true;
        }
      },
      {
        name: "prompt.slash.close",
        desc: "Close slash commands",
        run() {
          return closeSlashSelection();
        }
      }
    ],
    bindings: [
      { key: "up", cmd: "prompt.slash.previous" },
      { key: "down", cmd: "prompt.slash.next" },
      { key: "return", cmd: "prompt.slash.submit" },
      { key: "enter", cmd: "prompt.slash.submit" },
      { key: "escape", cmd: "prompt.slash.close" }
    ]
  });
  const unregisterOpenCodeDialogNavigationLayer = keymap.registerLayer({
    priority: 400,
    commands: [
      {
        name: "dialog.provider.previous",
        desc: "Previous dialog item",
        run() {
          if (services.startupOverlay === "providers") return moveProviderSelection(-1);
          if (services.startupOverlay === "providerAuthMethod") return moveProviderAuthMethodSelection(-1);
          if (services.startupOverlay === "providerAuth") return moveCustomProviderModelSelection(-1) || moveCustomProviderFormFocus(-1);
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
          if (services.startupOverlay === "providerAuth") return moveCustomProviderModelSelection(1) || moveCustomProviderFormFocus(1);
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
    if (inputKey === "ctrl+h" || inputKey === "f1") {
      key.preventDefault();
      key.stopPropagation();
      toggleHelp();
      return;
    }
    if (inputKey === "f2") {
      key.preventDefault();
      key.stopPropagation();
      toggleSummary();
      return;
    }
    if (services.helpOpen) {
      if (navigationKey === "escape") {
        key.preventDefault();
        key.stopPropagation();
        closeHelp();
      }
      return;
    }
    if (services.summaryOpen) {
      if (navigationKey === "escape") {
        key.preventDefault();
        key.stopPropagation();
        closeSummary();
      }
      return;
    }
    const scrollKey = key.name.toLowerCase();
    if (activeScroll && services.startupOverlay === "none" && (scrollKey === "pageup" || scrollKey === "pagedown" || inputKey === "ctrl+home" || inputKey === "ctrl+end" || inputKey === "ctrl+up" || inputKey === "ctrl+down")) {
      key.preventDefault();
      key.stopPropagation();
      if (inputKey === "ctrl+home") scrollTranscript("start");
      else if (inputKey === "ctrl+end") scrollTranscript("end");
      else if (scrollKey === "pageup") scrollTranscript("page-up");
      else if (scrollKey === "pagedown") scrollTranscript("page-down");
      else scrollTranscript(inputKey === "ctrl+up" ? "step-up" : "step-down");
      return;
    }
    if (shouldCopySelectionForInput(inputKey, selectedTextForClipboard(renderer.getSelection())) && copyCurrentSelection()) {
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    // Modal navigation is owned exclusively by the high-priority keymap layer.
    // Letting this raw listener process the same key caused every arrow/Enter
    // event to run twice and could advance through two dialogs at once.
    if (isOpenCodeDialogOverlay(services)) return;
    if (services.startupOverlay === "whichkey") {
      const command = commandForKey(services, inputKey);
      key.preventDefault();
      key.stopPropagation();
      if (command === "command_palette") showOverlay("palette");
      else if (command === "help") toggleHelp();
      else if (command === "theme_picker") showOverlay("themes");
      else if (command === "model_picker") showOverlay("models");
      else if (command === "session_list") showOverlay("sessions");
      else if (command === "agent_next") { showOverlay("none"); void handleSubmit("/agent next"); }
      else if (command === "agent_previous") { showOverlay("none"); void handleSubmit("/agent previous"); }
      else if (command === "app_exit") exit();
      else showOverlay("none");
      return;
    }
    if (services.tuiConfig.leader && inputKey === services.tuiConfig.leader) {
      key.preventDefault();
      key.stopPropagation();
      if (activeSessionView) return;
      showOverlay("whichkey");
      return;
    }
    // Slash navigation and submission are handled by the slash keymap layer.
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
      if (activeSessionView && services.startupOverlay === "slashCommands") {
        key.preventDefault();
        key.stopPropagation();
        services.startupOverlay = "none";
        services.promptDraft = "";
        activeSessionView.textarea.clear();
        removeSessionSlashCommandOverlay(renderer.root);
        activeSessionView.textarea.focus();
        renderer.focusRenderable(activeSessionView.textarea);
        renderer.requestRender();
        return;
      }
      if (activeSessionView && services.startupOverlay === "none" && !services.dialogs.active()) {
        key.preventDefault();
        key.stopPropagation();
        activeSessionView.textarea.focus();
        renderer.focusRenderable(activeSessionView.textarea);
        return;
      }
      services.dialogs.close();
      services.promptDraft = promptDraftAfterEscape(services.startupOverlay, textarea.plainText);
      if (services.startupOverlay === "slashCommands" || services.startupOverlay === "providerAuthMethod" || services.startupOverlay === "providerAuth") textarea.clear();
      if (services.startupOverlay === "providerAuthMethod" || services.startupOverlay === "providerAuth") {
        services.authProviderId = undefined;
        services.authProviderTitle = undefined;
        services.authProviderEndpoint = undefined;
        services.authInputDraft = "";
      }
      showOverlay("none");
      return;
    }
    if (shouldSyncSlashOverlay(Boolean(activeSessionView), key.ctrl, key.meta)) setImmediate(syncSlashOverlay);
  });
  const handleRendererResize = (width: number) => {
    activeSessionView?.resize(width);
    activeHomeView?.resize(width);
    if (services.helpOpen) addHelpOverlay(core, renderer);
    if (services.summaryOpen) addSummaryOverlay(core, renderer, runtime, services, sessionTitle);
  };
  renderer.on("resize", handleRendererResize);
  rebuildHome();

  await new Promise<void>(resolve => {
    renderer.once("destroy", () => {
      void (async () => {
        clearCustomProviderDiscoveryTimer();
        renderer.off("resize", handleRendererResize);
        questionSurface?.destroy();
        unregisterTranscriptNavigationLayer();
        unregisterOpenCodeDialogNavigationLayer();
        unregisterAgentCycleLayer();
        unregisterReasoningFocusLayer();
        unregisterSlashNavigationLayer();
        unregisterTextareaLayer();
        unregisterBaseLayout();
        await runtime.runner?.close();
        resolve();
      })();
    });
  });
}

if (require.main === module) {
  void runTui();
}
