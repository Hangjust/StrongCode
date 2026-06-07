import type { ProviderConfig, StrongCodeConfig } from "../config/schema";
import type { ProviderCatalog } from "../models/catalog";
import { orderedProviders } from "../models/registry";

export interface TuiState {
  provider: string;
  model?: string;
  defaultAgent: string;
  configPath: string;
  configMissing: boolean;
  workspace?: string;
  dataDir?: string;
}

export interface HomeRenderResult {
  output: string;
  promptPrefix: string;
}

const STYLE = {
  reset: "\x1b[0m",
  primary: "\x1b[38;2;255;184;112m",
  secondary: "\x1b[38;2;119;169;255m",
  accent: "\x1b[38;2;237;132;91m",
  success: "\x1b[38;2;136;218;153m",
  warning: "\x1b[38;2;245;190;102m",
  error: "\x1b[38;2;235;111;103m",
  text: "\x1b[38;2;242;238;230m",
  muted: "\x1b[38;2;154;145;132m",
  border: "\x1b[38;2;92;77;64m",
  panel: "\x1b[48;2;23;20;18m",
  element: "\x1b[48;2;34;29;25m"
};

const SCREEN_WIDTH = 80;
const HOME_PROMPT_WIDTH = 75;
const HOME_PROMPT_LEFT = Math.floor((SCREEN_WIDTH - HOME_PROMPT_WIDTH) / 2);
const HOME_INPUT_COLUMN = HOME_PROMPT_LEFT + 3;
const SIDEBAR_WIDTH = 42;
const SPLIT_WIDTH = 1;
const FEED_WIDTH = SCREEN_WIDTH - SIDEBAR_WIDTH - SPLIT_WIDTH;
const LOGO = [
  ["██████", "██████", "█████ ", "██████", "██  ██", "██████", "██████", "██████", "█████ ", "██████"].join(" "),
  ["██    ", "  ██  ", "██  ██", "██  ██", "███ ██", "██    ", "██    ", "██  ██", "██  ██", "██    "].join(" "),
  ["█████ ", "  ██  ", "█████ ", "██  ██", "██████", "██ ███", "██    ", "██  ██", "██  ██", "█████ "].join(" "),
  ["   ██ ", "  ██  ", "██ ██ ", "██  ██", "██ ███", "██  ██", "██    ", "██  ██", "██  ██", "██    "].join(" "),
  ["██ ██ ", "  ██  ", "██  ██", "██  ██", "██  ██", "██  ██", "██    ", "██  ██", "██  ██", "██    "].join(" "),
  ["██████", "  ██  ", "██  ██", "██████", "██  ██", "██████", "██████", "██████", "█████ ", "██████"].join(" ")
];

function applyStyle(text: string, style: string, noColor: boolean): string {
  return noColor ? text : `${style}${text}${STYLE.reset}`;
}

function paint(text: string, fg: string, noColor: boolean, bg?: string): string {
  return noColor ? text : `${bg ?? ""}${fg}${text}${STYLE.reset}`;
}

function visibleLength(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

export function sanitizeDisplayValue(value: string | undefined, fallback = "N/A"): string {
  return (value ?? fallback)
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[P^_][\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1F\x7F-\x9F]/g, "");
}

function clip(text: string, width: number): string {
  if (visibleLength(text) <= width) return text;
  if (width <= 1) return text.slice(0, width);

  let clipped = "";
  let visible = 0;
  let index = 0;
  while (index < text.length && visible < width - 1) {
    const sequence = /^\x1b\[[0-9;]*m/.exec(text.slice(index));
    if (sequence) {
      clipped += sequence[0];
      index += sequence[0].length;
      continue;
    }
    clipped += text[index];
    visible += 1;
    index += 1;
  }
  return `${clipped}.${text.includes("\x1b[") ? STYLE.reset : ""}`;
}

export function clipDisplayLine(value: string | undefined, width = SCREEN_WIDTH): string {
  return clip(sanitizeDisplayValue(value, ""), width);
}

function padVisible(text: string, width: number): string {
  const clipped = clip(text, width);
  return `${clipped}${" ".repeat(Math.max(0, width - visibleLength(clipped)))}`;
}

function center(text: string, width = SCREEN_WIDTH): string {
  const clipped = clip(text, width);
  const left = Math.max(0, Math.floor((width - visibleLength(clipped)) / 2));
  const right = Math.max(0, width - visibleLength(clipped) - left);
  return `${" ".repeat(left)}${clipped}${" ".repeat(right)}`;
}

function rule(label: string, width: number, noColor: boolean): string {
  const safe = sanitizeDisplayValue(label, "").toUpperCase();
  const marker = safe ? ` ${safe} ` : "";
  return paint(`${marker}${"─".repeat(Math.max(0, width - visibleLength(marker)))}`, STYLE.border, noColor);
}

function sectionTitle(icon: string, title: string, noColor: boolean): string {
  return `${paint(icon, STYLE.accent, noColor)} ${paint(title, STYLE.primary, noColor)}`;
}

function metric(label: string, value: string, width = FEED_WIDTH): string {
  return clip(`${sanitizeDisplayValue(label, "").padEnd(10)} ${sanitizeDisplayValue(value, "")}`, width);
}

function wrapText(message: string, width: number): string[] {
  const words = sanitizeDisplayValue(message, "").split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];

  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (word.length > width) {
      if (current) {
        lines.push(current);
        current = "";
      }
      for (let offset = 0; offset < word.length; offset += width) lines.push(word.slice(offset, offset + width));
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (next.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function titlecase(value: string): string {
  const safe = sanitizeDisplayValue(value, "");
  return safe ? `${safe[0].toUpperCase()}${safe.slice(1)}` : safe;
}

function providerLabel(state: TuiState): string {
  const provider = sanitizeDisplayValue(state.provider, "");
  return provider && provider !== "N/A" ? provider : "local";
}

function modelLabel(state: TuiState): string {
  const model = sanitizeDisplayValue(state.model, "");
  return model && model !== "N/A" ? model : "mock";
}

function agentLabel(state: TuiState): string {
  const agent = sanitizeDisplayValue(state.defaultAgent, "");
  return titlecase(agent && agent !== "N/A" ? agent : "default");
}

function splitRows(left: string[], right: string[], noColor: boolean): string {
  const height = Math.max(left.length, right.length);
  const split = paint("┃", STYLE.border, noColor);
  const rows: string[] = [];
  for (let index = 0; index < height; index += 1) {
    rows.push(`${padVisible(left[index] ?? "", FEED_WIDTH)}${split}${padVisible(right[index] ?? "", SIDEBAR_WIDTH)}`);
  }
  return rows.join("\n");
}

function footer(state: TuiState, noColor: boolean): string {
  const directory = clip(sanitizeDisplayValue(state.workspace, "."), 32);
  const connected = !state.configMissing;
  const lsp = connected ? paint("•", STYLE.success, noColor) : paint("•", STYLE.muted, noColor);
  const mcp = connected ? paint("⊙", STYLE.success, noColor) : paint("⊙", STYLE.muted, noColor);
  const right = `${lsp} 0 LSP  ${mcp} 0 MCP  ${paint("/status", STYLE.muted, noColor)}`;
  return `${paint("▔", STYLE.border, noColor)} ${padVisible(paint(directory, STYLE.muted, noColor), SCREEN_WIDTH - visibleLength(right) - 2)}${right}`;
}

function sidebar(title: string, state: TuiState, content: string[], noColor: boolean): string[] {
  return [
    "",
    `  ${paint("STRONGCODE", STYLE.primary, noColor)} ${paint("//", STYLE.border, noColor)} ${paint(clip(sanitizeDisplayValue(title, "local"), 20), STYLE.text, noColor)}`,
    `  ${paint("─".repeat(SIDEBAR_WIDTH - 4), STYLE.border, noColor)}`,
    ...content.map(line => `  ${paint("›", STYLE.accent, noColor)} ${paint(clip(sanitizeDisplayValue(line, ""), SIDEBAR_WIDTH - 6), STYLE.muted, noColor)}`),
    ...Array(Math.max(0, 10 - content.length)).fill(""),
    `  ${paint("●", STYLE.success, noColor)} ${paint("StrongCode", STYLE.text, noColor)} ${paint("0.1.0", STYLE.muted, noColor)}`,
    `  ${paint("⌁", STYLE.border, noColor)} ${paint(clip(sanitizeDisplayValue(state.workspace, "."), SIDEBAR_WIDTH - 6), STYLE.muted, noColor)}`
  ];
}

function promptBlock(state: TuiState, width: number, noColor: boolean, placeholder: string): string[] {
  const inner = width - 3;
  const meta = `StrongCode · ${agentLabel(state)} · ${modelLabel(state)} · ${providerLabel(state)}`;
  const hints = "";
  const accent = paint("┃", STYLE.primary, noColor);
  return [
    `${accent}${paint(padVisible(`  Ask anything... \"${placeholder}\"`, inner), STYLE.muted, noColor, STYLE.element)}`,
    `${accent}${paint(padVisible(`  ${meta}`, inner), STYLE.primary, noColor, STYLE.element)}`,
    padVisible(paint(hints, STYLE.text, noColor), width)
  ];
}

function homePromptPrefix(noColor: boolean): string {
  if (noColor) return "";
  return `\x1b[4A\x1b[${HOME_INPUT_COLUMN + 2}G`;
}

function userMessage(text: string, index: number, width: number, noColor: boolean): string[] {
  const lines = wrapText(text, width - 4);
  const top = index === 0 ? [] : [""];
  return [
    ...top,
    `${paint("╭", STYLE.secondary, noColor)}${rule("you", width - 1, noColor)}`,
    ...lines.map(line => `${paint("┃", STYLE.secondary, noColor)}${paint(padVisible(`  ${line}`, width - 1), STYLE.text, noColor, STYLE.panel)}`),
    `${paint("╰", STYLE.secondary, noColor)}${paint("─".repeat(Math.max(0, width - 1)), STYLE.border, noColor)}`
  ];
}

function assistantMessage(text: string, state: TuiState, width: number, noColor: boolean): string[] {
  const lines = wrapText(text, width - 3).map(line => `   ${line}`);
  return [
    "",
    sectionTitle("▣", "Build", noColor),
    ...lines.map(line => paint(clip(line, width), STYLE.text, noColor)),
    `   ${paint("▣", STYLE.secondary, noColor)} ${paint("Build", STYLE.text, noColor)}${paint(` · ${modelLabel(state)} ${providerLabel(state)}`, STYLE.muted, noColor)}`
  ];
}

function renderTranscript(messages: string[], state: TuiState, noColor: boolean): string[] {
  if (messages.length === 0) return [paint("No messages in session.", STYLE.muted, noColor)];

  return messages.flatMap((message, index) => {
    const safe = sanitizeDisplayValue(message, "");
    if (safe.startsWith("user: ")) return userMessage(safe.slice(6), index, FEED_WIDTH, noColor);
    if (safe.startsWith("assistant: ")) return assistantMessage(safe.slice(11), state, FEED_WIDTH, noColor);
    return assistantMessage(safe, state, FEED_WIDTH, noColor);
  }).slice(-20);
}

export function renderHome(state: TuiState, noColor: boolean = false): string {
  return renderHomeWithPrompt(state, noColor).output;
}

export function renderHomeWithPrompt(state: TuiState, noColor: boolean = false): HomeRenderResult {
  const prompt = promptBlock(state, HOME_PROMPT_WIDTH, noColor, "Fix a TODO in the codebase");
  const lines = [
    "",
    "",
    ...LOGO.map(line => center(paint(line, STYLE.primary, noColor))),
    center(paint("LOCAL AGENT FORGE  //  TUI OPERATIONS CONSOLE", STYLE.muted, noColor)),
    "",
    ...prompt.map(line => center(line)),
    "",
    footer(state, noColor)
  ];
  return {
    output: lines.map(line => clip(line, SCREEN_WIDTH)).join("\n"),
    promptPrefix: homePromptPrefix(noColor)
  };
}

export function renderSessionLayout(state: TuiState, messages: string[], noColor: boolean = false): string {
  const left = [
    "",
    sectionTitle("◆", "Session", noColor),
    rule("transcript", FEED_WIDTH, noColor),
    ...renderTranscript(messages, state, noColor),
    "",
    ...promptBlock(state, FEED_WIDTH, noColor, "What is the tech stack of this project?")
  ];
  const right = sidebar("local", state, [], noColor);
  return splitRows(left, right, noColor);
}

export function renderHints(noColor: boolean = false): string {
  const lines = [
    sectionTitle("◆", "Command Deck", noColor),
    rule("navigation", SCREEN_WIDTH, noColor),
    "  /help       Show help",
    "  /sessions   List sessions",
    "  /model      Open model picker or /model <id>",
    "  /models     List active provider models",
    "  /connect    Connect provider auth",
    "  /provider   Inspect providers and setup guidance",
    "  /provider configure custom <base-url> <api-key-env>",
    "  /provider models <id>   Discover/list provider models",
    "  /commands   Show command palette",
    "  /toast      Show toast stack",
    "  /plugins    Show TUI plugin slots",
    "  /whichkey   Show leader key hints",
    "  /diff       Show diff review surface",
    "  /approve    Show tool approval surface",
    "  /pick       Show picker surface",
    "  /paste      Show paste/editor surface",
    "  /new        New session",
    "  /undo       Undo previous message",
    "  /redo       Redo",
    "  /compact    Compact session",
    "  /themes     Select theme",
    "  /status     Show status",
    "  /exit       Quit",
    "",
    sectionTitle("◆", "Prompt Grammar", noColor),
    "  @ files   ! shell mode   / commands"
  ];
  return lines.map(line => clip(line, SCREEN_WIDTH)).join("\n");
}

export function renderStatus(state: TuiState, noColor: boolean = false): string {
  const connected = !state.configMissing;
  const left = [
    "",
    sectionTitle("◆", "Status", noColor),
    rule("runtime", FEED_WIDTH, noColor),
    `State      ${connected ? paint("connected", STYLE.success, noColor) : paint("disconnected", STYLE.warning, noColor)}`,
    metric("Session", "local"),
    metric("Directory", sanitizeDisplayValue(state.workspace, ".")),
    metric("Provider", providerLabel(state)),
    metric("Model", modelLabel(state)),
    metric("Agent", sanitizeDisplayValue(state.defaultAgent, "build")),
    metric("DataDir", sanitizeDisplayValue(state.dataDir)),
    "",
    ...promptBlock(state, FEED_WIDTH, noColor, "Fix broken tests")
  ];
  return splitRows(left, sidebar("local", state, [], noColor), noColor);
}

function providerEnabled(provider: ProviderConfig): boolean {
  return provider.enabled !== false;
}

function providerCredentialStatus(provider: ProviderConfig, connectedByAuth = false): string {
  if (!provider.apiKeyEnv) return "no key required";
  const env = sanitizeDisplayValue(provider.apiKeyEnv, "unknown");
  if (connectedByAuth && !process.env[provider.apiKeyEnv]) return "auth.json (set)";
  return process.env[provider.apiKeyEnv] ? `env ${env} (set)` : `env ${env} (missing)`;
}

export function renderProviderList(config: StrongCodeConfig, state: TuiState, noColor: boolean = false, catalog?: ProviderCatalog): string {
  const left = ["", sectionTitle("◆", "Providers", noColor), rule("connections", FEED_WIDTH, noColor)];
  const catalogByProvider = new Map((catalog?.all ?? []).map(provider => [provider.id, provider]));
  for (const provider of orderedProviders(config.providers)) {
    const catalogProvider = catalogByProvider.get(provider.id);
    const marker = catalogProvider?.connected || providerEnabled(provider.config) ? paint("●", STYLE.success, noColor) : paint("○", STYLE.muted, noColor);
    const providerId = sanitizeDisplayValue(provider.id, "unknown");
    const displayName = sanitizeDisplayValue(provider.config.displayName, providerId);
    const status = `${providerEnabled(provider.config) ? "enabled" : "disabled"} · ${catalogProvider?.runtimeSupport ?? "supported"}`;
    const env = providerCredentialStatus(provider.config, catalogProvider?.connected ?? false);
    const baseUrl = provider.config.baseUrl ? `base ${sanitizeDisplayValue(provider.config.baseUrl, "")}` : "base not configured";
    left.push(`${marker} ${providerId}`);
    left.push(`   ${displayName} · ${status}`);
    left.push(`   ${env}`);
    left.push(`   ${baseUrl}`);
  }
  return splitRows(left, sidebar("providers", state, [], noColor), noColor);
}

export function renderProviderPanel(config: StrongCodeConfig, state: TuiState, noColor: boolean = false, catalog?: ProviderCatalog): string {
  const agent = config.agents[config.defaultAgent];
  const model = config.models[agent.model];
  if (!model) return splitRows(["", "Configured default model is missing."], sidebar("provider", state, [], noColor), noColor);

  const provider = config.providers[model.provider];
  const catalogProvider = catalog?.all.find(item => item.id === model.provider);
  const providerName = sanitizeDisplayValue(provider?.displayName ?? model.provider, "unknown");
  const providerId = sanitizeDisplayValue(model.provider, "unknown");
  const modelName = sanitizeDisplayValue(agent.model, "unknown");
  const apiKey = provider ? providerCredentialStatus(provider, catalogProvider?.connected ?? false) : "provider missing";
  const baseUrl = provider?.baseUrl ? sanitizeDisplayValue(provider.baseUrl, "") : "not configured";
  const left = [
    "",
    sectionTitle("◆", "Provider", noColor),
    rule("active route", FEED_WIDTH, noColor),
    `Current provider  ${providerId} (${providerName})`,
    `Current status    ${providerEnabled(provider ?? { type: "unknown", displayName: model.provider }) ? "enabled" : "disabled"}`,
    `Current model     ${modelName}`,
    `API key           ${apiKey}`,
    `Base URL          ${baseUrl}`,
    `Runtime           ${catalogProvider?.runtimeSupport ?? "supported"}`,
    "",
    "Connect /connect",
    "Next /provider list",
    "Models /provider models <id>",
    "Setup /provider configure custom",
    "",
    ...promptBlock(state, FEED_WIDTH, noColor, "Connect a provider")
  ];
  return splitRows(left, sidebar("provider", state, [], noColor), noColor);
}

export function renderConnectPanel(config: StrongCodeConfig, state: TuiState, noColor: boolean = false, catalog?: ProviderCatalog): string {
  const connected = catalog?.connected.length ? catalog.connected.join(", ") : "none";
  const left = [
    "",
    sectionTitle("◆", "Connect", noColor),
    rule("provider auth", FEED_WIDTH, noColor),
    `Connected ${sanitizeDisplayValue(connected, "none")}`,
    "",
    "Use /connect <provider-id> <api-key>",
    "Use /connect openai chatgpt-browser",
    "Use /connect openai chatgpt-headless",
    "Use /connect remove <provider-id>",
    "",
    ...orderedProviders(config.providers).map(provider => {
      const catalogProvider = catalog?.all.find(item => item.id === provider.id);
      const marker = catalogProvider?.connected ? "●" : "○";
      const runtime = catalogProvider?.runtimeSupport ?? "supported";
      return `${marker} ${sanitizeDisplayValue(provider.id, "unknown")} · ${runtime}`;
    }),
    "",
    ...promptBlock(state, FEED_WIDTH, noColor, "Connect a provider")
  ];
  return splitRows(left, sidebar("connect", state, [], noColor), noColor);
}

export function renderModelList(config: StrongCodeConfig, providerId: string, state: TuiState, noColor: boolean = false): string {
  const safeProviderId = sanitizeDisplayValue(providerId, "unknown");
  const left = ["", sectionTitle("◆", "Models", noColor), rule(`for ${safeProviderId}`, FEED_WIDTH, noColor), ""];
  const models = Object.entries(config.models).filter(([, model]) => model.provider === providerId);
  if (models.length === 0) left.push(`No models configured. Use /provider models ${safeProviderId} to discover.`);
  for (const [modelId, model] of models) {
    const active = state.model === modelId;
    const marker = active ? paint(">", STYLE.secondary, noColor) : model.enabled !== false ? paint("●", STYLE.success, noColor) : paint("○", STYLE.muted, noColor);
    left.push(`${marker} ${sanitizeDisplayValue(modelId, "unknown")}`);
  }
  left.push("");
  left.push("Type /model <id> to enable and set the active model.");
  return splitRows(left, sidebar("models", state, [], noColor), noColor);
}
