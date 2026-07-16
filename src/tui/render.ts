import type { ProviderConfig, StrongCodeConfig } from "../config/schema";
import type { ProviderCatalog } from "../models/catalog";
import { getAgentDisplayName } from "../agents/registry";
import { orderedProviders } from "../models/registry";
import {
  SessionTelemetry,
  STRONGCODE_VERSION,
  TurnReceipt,
  compactSessionTitle,
  fastModeLabel,
  formatCost,
  formatTokens,
  reasoningLabel,
  sanitizeChromeText,
  sessionTelemetryLine,
  turnReceiptLine,
  turnStatusIcon
} from "./ui/session-chrome";
import { STRONGCODE_WORDMARK, STRONGCODE_WORDMARK_GAP, decodeWordmarkLine } from "./ui/wordmark";

export interface TuiState {
  provider: string;
  providerDisplayName?: string;
  model?: string;
  modelDisplayName?: string;
  defaultAgent: string;
  agentIdentity?: string;
  configPath: string;
  configMissing: boolean;
  workspace?: string;
  dataDir?: string;
  modelOptions?: Record<string, unknown>;
  mcpServersLoaded?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface TuiTranscriptMessage {
  role: "user" | "assistant" | "system";
  text: string;
  receipt?: TurnReceipt;
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
const SIDEBAR_WIDTH = 42;
const SPLIT_WIDTH = 1;
const FEED_WIDTH = SCREEN_WIDTH - SIDEBAR_WIDTH - SPLIT_WIDTH;
const HOME_PROMPT_WIDTH = 72;
const HOME_PROMPT_LEFT = Math.floor((SCREEN_WIDTH - HOME_PROMPT_WIDTH) / 2);
const HOME_INPUT_COLUMN = HOME_PROMPT_LEFT + 3;

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
  return sanitizeChromeText(value ?? fallback);
}

export function sanitizeMultilineDisplayValue(value: string | undefined, fallback = "N/A"): string {
  return (value ?? fallback)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(line => sanitizeDisplayValue(line, ""))
    .join("\n");
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
  const lines: string[] = [];
  for (const paragraph of sanitizeMultilineDisplayValue(message, "").split("\n")) {
    const words = paragraph.split(/[\t ]+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
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
  }
  return lines.length > 0 ? lines : [""];
}

function providerLabel(state: TuiState): string {
  const provider = sanitizeDisplayValue(state.provider, "");
  return provider && provider !== "N/A" ? provider : "local";
}

function modelLabel(state: TuiState): string {
  const model = sanitizeDisplayValue(state.model, "");
  return model && model !== "N/A" ? model : "mock";
}

function providerDisplayLabel(state: TuiState): string {
  const id = providerLabel(state);
  const displayName = sanitizeDisplayValue(state.providerDisplayName, "").trim();
  return displayName && displayName !== id ? `${displayName} (${id})` : id;
}

function modelDisplayLabel(state: TuiState): string {
  const id = modelLabel(state);
  const displayName = sanitizeDisplayValue(state.modelDisplayName, "").trim();
  return displayName && displayName !== id ? `${displayName} (${id})` : id;
}

function strongCodeModelLine(state: TuiState): string {
  return `Strong Code · ${modelDisplayLabel(state)}`;
}

function telemetry(state: TuiState): SessionTelemetry {
  return {
    totalTokens: state.totalTokens,
    costUsd: state.costUsd,
    toolCalls: 0,
    skillsRead: undefined,
    mcpServersLoaded: state.mcpServersLoaded,
    mcpServersUsed: undefined
  };
}

function topBar(title: string, state: TuiState, noColor: boolean): string[] {
  const left = `${paint("◆", STYLE.primary, noColor)} ${paint("STRONGCODE", STYLE.text, noColor)} ${paint("/", STYLE.border, noColor)} ${paint(clip(sanitizeDisplayValue(title, "New session"), 28), STYLE.muted, noColor)}`;
  const version = paint(`v${STRONGCODE_VERSION}`, STYLE.muted, noColor);
  const model = paint(clip(modelDisplayLabel(state), 18), STYLE.primary, noColor);
  const usage = paint(`${formatTokens(state.totalTokens)} · ${formatCost(state.costUsd)}`, STYLE.muted, noColor);
  const summary = paint("[ Summary F2 ]", STYLE.secondary, noColor);
  const right = `${model}  ${usage}  ${summary}  ${version}`;
  const leftWidth = Math.max(0, SCREEN_WIDTH - visibleLength(right) - 2);
  return [
    `${padVisible(left, leftWidth)}  ${right}`,
    paint("─".repeat(SCREEN_WIDTH), STYLE.border, noColor)
  ];
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
  const directory = clip(sanitizeDisplayValue(state.workspace, "."), 28);
  const mcpCount = state.mcpServersLoaded;
  const quick = paint(`Quick summary · ${directory}`, STYLE.muted, noColor);
  const loaded = mcpCount === undefined ? "— MCPs loaded" : `${mcpCount} MCP${mcpCount === 1 ? "" : "s"} loaded`;
  const right = `${paint(loaded, STYLE.text, noColor)}  ${paint("Ctrl+H commands", STYLE.muted, noColor)}`;
  return `${padVisible(quick, SCREEN_WIDTH - visibleLength(right))}${right}`;
}

function sidebar(title: string, state: TuiState, content: string[], noColor: boolean): string[] {
  const details = content.length > 0 ? content : [
    `Active model: ${modelDisplayLabel(state)}`,
    `Provider: ${providerDisplayLabel(state)}`
  ];
  return [
    "",
    `  ${paint("STRONGCODE", STYLE.primary, noColor)} ${paint("//", STYLE.border, noColor)} ${paint(clip(sanitizeDisplayValue(title, "local"), 20), STYLE.text, noColor)}`,
    `  ${paint("─".repeat(SIDEBAR_WIDTH - 4), STYLE.border, noColor)}`,
    ...details.map(line => `  ${paint("›", STYLE.accent, noColor)} ${paint(clip(sanitizeDisplayValue(line, ""), SIDEBAR_WIDTH - 6), STYLE.muted, noColor)}`),
    ...Array(Math.max(0, 10 - details.length)).fill(""),
    `  ${paint("●", STYLE.success, noColor)} ${paint("StrongCode", STYLE.text, noColor)} ${paint(STRONGCODE_VERSION, STYLE.muted, noColor)}`,
    `  ${paint("⌁", STYLE.border, noColor)} ${paint(clip(sanitizeDisplayValue(state.workspace, "."), SIDEBAR_WIDTH - 6), STYLE.muted, noColor)}`
  ];
}

function promptBlock(state: TuiState, width: number, noColor: boolean, placeholder: string): string[] {
  const inner = width - 3;
  const agent = getAgentDisplayName(state.agentIdentity, sanitizeDisplayValue(state.defaultAgent, "default"));
  const model = modelDisplayLabel(state);
  const meta = `  ${agent} · ${model} · 🧠 · ⚡`;
  const styledMeta = noColor
    ? padVisible(meta, inner)
    : clip([
      paint(`  ${agent} · `, STYLE.primary, false, STYLE.element),
      paint(model, STYLE.text, false, STYLE.element),
      paint(" · 🧠 · ⚡", STYLE.primary, false, STYLE.element),
      paint(" ".repeat(Math.max(0, inner - visibleLength(meta))), STYLE.primary, false, STYLE.element)
    ].join(""), inner);
  const hint = "/model switch · Tab agents · Ctrl+H commands";
  const top = `${paint("╭", STYLE.primary, noColor)}${paint("─ message ", STYLE.primary, noColor)}${paint("─".repeat(Math.max(0, width - 12)), STYLE.border, noColor)}${paint("╮", STYLE.border, noColor)}`;
  const bottom = `${paint("╰", STYLE.border, noColor)}${paint("─".repeat(Math.max(0, width - 2)), STYLE.border, noColor)}${paint("╯", STYLE.border, noColor)}`;
  return [
    top,
    `${paint("│", STYLE.primary, noColor)}${paint(padVisible(`  Ask anything… “${placeholder}”`, inner), STYLE.muted, noColor, STYLE.element)}${paint(" │", STYLE.border, noColor)}`,
    `${paint("│", STYLE.primary, noColor)}${paint(padVisible("", inner), STYLE.text, noColor, STYLE.element)}${paint(" │", STYLE.border, noColor)}`,
    `${paint("│", STYLE.primary, noColor)}${styledMeta}${paint(" │", STYLE.border, noColor)}`,
    `${paint("│", STYLE.primary, noColor)}${paint(padVisible(`  ${hint}`, inner), STYLE.muted, noColor, STYLE.element)}${paint(" │", STYLE.border, noColor)}`,
    bottom
  ];
}

function homePromptPrefix(noColor: boolean): string {
  if (noColor) return "";
  return `\x1b[4A\x1b[${HOME_INPUT_COLUMN + 2}G`;
}

function userMessage(text: string, index: number, width: number, noColor: boolean, state: TuiState): string[] {
  const lines = wrapText(text, width - 4);
  const top = index === 0 ? [] : [""];
  const destination = `Sent to ${sanitizeDisplayValue(state.defaultAgent, "default")} · ${modelDisplayLabel(state)}`;
  return [
    ...top,
    `${paint("╭", STYLE.secondary, noColor)}${rule("you", width - 1, noColor)}`,
    ...lines.map(line => `${paint("┃", STYLE.secondary, noColor)}${paint(padVisible(`  ${line}`, width - 1), STYLE.text, noColor, STYLE.panel)}`),
    `${paint("┃", STYLE.secondary, noColor)}${paint(padVisible(`  ${destination}`, width - 1), STYLE.muted, noColor, STYLE.panel)}`,
    `${paint("╰", STYLE.secondary, noColor)}${paint("─".repeat(Math.max(0, width - 1)), STYLE.border, noColor)}`
  ];
}

function assistantMessage(text: string, state: TuiState, width: number, noColor: boolean, receipt?: TurnReceipt): string[] {
  const lines = wrapText(text, width - 3).map(line => `   ${line}`);
  const agent = sanitizeDisplayValue(state.defaultAgent, "default");
  const completion: TurnReceipt = receipt ?? { status: "finished", agent, model: modelDisplayLabel(state), durationMs: Number.NaN, toolCalls: Number.NaN };
  return [
    "",
    sectionTitle("▣", agent, noColor),
    ...lines.map(line => paint(clip(line, width), STYLE.text, noColor)),
    `   ${paint(turnStatusIcon(completion.status), completion.status === "failed" ? STYLE.error : STYLE.success, noColor)} ${paint(clip(turnReceiptLine(completion), width - 5), STYLE.muted, noColor)}`
  ];
}

function normalizedTranscriptMessage(message: string | TuiTranscriptMessage): TuiTranscriptMessage {
  if (typeof message !== "string") return { ...message, text: sanitizeMultilineDisplayValue(message.text, "") };
  const safe = sanitizeMultilineDisplayValue(message, "");
  if (safe.startsWith("user: ")) return { role: "user", text: safe.slice(6) };
  if (safe.startsWith("assistant: ")) return { role: "assistant", text: safe.slice(11) };
  if (safe.startsWith("system: ")) return { role: "system", text: safe.slice(8) };
  return { role: "assistant", text: safe };
}

function renderTranscript(messages: Array<string | TuiTranscriptMessage>, state: TuiState, noColor: boolean): string[] {
  if (messages.length === 0) return [paint("Ready for your first message.", STYLE.muted, noColor)];

  return messages.flatMap((message, index) => {
    const entry = normalizedTranscriptMessage(message);
    if (entry.role === "user") return userMessage(entry.text, index, SCREEN_WIDTH, noColor, state);
    if (entry.role === "system") return ["", `${paint("!", STYLE.warning, noColor)} ${paint(clip(entry.text, SCREEN_WIDTH - 2), STYLE.warning, noColor)}`];
    return assistantMessage(entry.text, state, SCREEN_WIDTH, noColor, entry.receipt);
  }).slice(-32);
}

export function renderHome(state: TuiState, noColor: boolean = false): string {
  return renderHomeWithPrompt(state, noColor).output;
}

export function renderHomeWithPrompt(state: TuiState, noColor: boolean = false): HomeRenderResult {
  const prompt = promptBlock(state, HOME_PROMPT_WIDTH, noColor, "Fix a TODO in the codebase");
  const wordmark = STRONGCODE_WORDMARK.left.map((left, index) => {
    const leftHalf = paint(decodeWordmarkLine(left), STYLE.muted, noColor);
    const rightHalf = paint(decodeWordmarkLine(STRONGCODE_WORDMARK.right[index] ?? ""), STYLE.primary, noColor);
    return center(`${leftHalf}${" ".repeat(STRONGCODE_WORDMARK_GAP)}${rightHalf}`);
  });
  const lines = [
    ...topBar("Ready when you are", state, noColor),
    "",
    ...wordmark,
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

export function renderSessionLayout(state: TuiState, messages: Array<string | TuiTranscriptMessage>, noColor: boolean = false): string {
  const firstUser = messages.map(normalizedTranscriptMessage).find(message => message.role === "user")?.text;
  const lines = [
    ...topBar(compactSessionTitle(firstUser ?? "New session"), state, noColor),
    paint(` ${sessionTelemetryLine(telemetry(state))} · Active ${sanitizeDisplayValue(state.defaultAgent, "default")} / ${modelDisplayLabel(state)}`, STYLE.muted, noColor),
    rule("transcript", SCREEN_WIDTH, noColor),
    ...renderTranscript(messages, state, noColor),
    "",
    ...promptBlock(state, SCREEN_WIDTH, noColor, "What should we build next?"),
    footer(state, noColor)
  ];
  return lines.map(line => clip(line, SCREEN_WIDTH)).join("\n");
}

export function renderHints(noColor: boolean = false): string {
  const lines = [
    sectionTitle("◆", "Command Deck", noColor),
    rule("navigation", SCREEN_WIDTH, noColor),
    "  /connect    Connect provider auth",
    "  /model      Show and switch models",
    "  /help       Show commands and shortcuts",
    "",
    sectionTitle("◆", "Prompt Grammar", noColor),
    "  @ files   ! shell mode   / commands   Ctrl+H / F1 help"
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
    metric("Provider", providerDisplayLabel(state)),
    metric("Model", modelDisplayLabel(state)),
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
  const modelDisplayName = sanitizeDisplayValue(model.displayName, modelName);
  const apiKey = provider ? providerCredentialStatus(provider, catalogProvider?.connected ?? false) : "provider missing";
  const baseUrl = provider?.baseUrl ? sanitizeDisplayValue(provider.baseUrl, "") : "not configured";
  const left = [
    "",
    sectionTitle("◆", "Provider", noColor),
    rule("active route", FEED_WIDTH, noColor),
    `Current provider  ${providerId} (${providerName})`,
    `Current status    ${providerEnabled(provider ?? { type: "unknown", displayName: model.provider }) ? "enabled" : "disabled"}`,
    `Current model     ${modelDisplayName}${modelDisplayName !== modelName ? ` (${modelName})` : ""}`,
    `API key           ${apiKey}`,
    `Base URL          ${baseUrl}`,
    `Runtime           ${catalogProvider?.runtimeSupport ?? "supported"}`,
    "",
    "Connect /connect",
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
    "Use strongcode setup --force for ChatGPT login",
    "Use /connect remove <provider-id>",
    "",
    ...orderedProviders(config.providers).map(provider => {
      const catalogProvider = catalog?.all.find(item => item.id === provider.id);
      const marker = catalogProvider?.connected ? "●" : "○";
      const runtime = catalogProvider?.runtimeSupport ?? "supported";
      const origin = provider.config.baseUrl
        ? (() => { try { return new URL(provider.config.baseUrl).origin; } catch { return "invalid endpoint"; } })()
        : "no remote endpoint";
      return clipDisplayLine(`${marker} ${sanitizeDisplayValue(provider.id, "unknown")} · ${origin} · ${runtime}`, FEED_WIDTH);
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
  if (models.length === 0) left.push(`No models configured for ${safeProviderId}.`);
  for (const [modelId, model] of models) {
    const active = state.model === modelId;
    const marker = active ? paint(">", STYLE.secondary, noColor) : model.enabled !== false ? paint("●", STYLE.success, noColor) : paint("○", STYLE.muted, noColor);
    const modelName = sanitizeDisplayValue(model.displayName, modelId);
    left.push(`${marker} ${modelName}${modelName !== modelId ? ` (${sanitizeDisplayValue(modelId, "unknown")})` : ""}`);
  }
  left.push("");
  left.push("Select a model from the connect flow to set it active.");
  return splitRows(left, sidebar("models", state, [], noColor), noColor);
}

export function renderAllModelList(config: StrongCodeConfig, state: TuiState, noColor: boolean = false): string {
  const left = ["", sectionTitle("◆", "Models", noColor), rule("available", FEED_WIDTH, noColor), ""];
  const models = Object.entries(config.models).sort(([leftId, left], [rightId, right]) => {
    const providerDelta = left.provider.localeCompare(right.provider);
    if (providerDelta !== 0) return providerDelta;
    return leftId.localeCompare(rightId);
  });

  if (models.length === 0) left.push("No models configured.");
  for (const [modelId, model] of models) {
    const active = state.model === modelId;
    const marker = active ? paint(">", STYLE.secondary, noColor) : model.enabled !== false ? paint("●", STYLE.success, noColor) : paint("○", STYLE.muted, noColor);
    const providerName = sanitizeDisplayValue(config.providers[model.provider]?.displayName ?? model.provider, model.provider);
    const modelName = sanitizeDisplayValue(model.displayName ?? model.model, modelId);
    const suffix = modelName !== modelId ? ` (${sanitizeDisplayValue(modelId, "unknown")})` : "";
    left.push(`${marker} ${providerName} · ${modelName}${suffix}`);
  }
  left.push("");
  left.push("Use /model to open the selector and choose one.");
  return splitRows(left, sidebar("models", state, [], noColor), noColor);
}

