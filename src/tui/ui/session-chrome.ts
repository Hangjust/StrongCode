import { sanitizeTerminalLine } from "../../core/terminal-text";
import { slashCommandHelpRows } from "../slash-command-registry";
import type { ImmutableSessionSummary, TelemetryProvenance } from "./session-summary";

export const STRONGCODE_VERSION = (require("../../../package.json") as { version?: string }).version ?? "unknown";

export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "max"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function sanitizeChromeText(value: string): string {
  return sanitizeTerminalLine(value);
}

export interface ModelUiControls {
  reasoningEnabled: boolean;
  reasoningAvailable: boolean;
  effort: ReasoningEffort;
  availableEfforts: ReasoningEffort[];
  fastMode: boolean;
  fastModeAvailable: boolean;
  fastModeMultiplier: number;
}

export interface SessionTelemetry {
  totalTokens?: number;
  costUsd?: number;
  costProvenance?: TelemetryProvenance;
  contextInputTokens?: number;
  contextWindowTokens?: number;
  summary?: ImmutableSessionSummary;
  toolCalls: number;
  skillsRead?: number;
  mcpServersLoaded?: number;
  mcpServersUsed?: number;
}

export interface TurnReceipt {
  status: "finished" | "failed" | "cancelled";
  agent: string;
  model: string;
  durationMs: number;
  toolCalls: number;
  skillsRead?: number;
  mcpServersUsed?: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function booleanOption(options: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    if (typeof options[key] === "boolean") return options[key] as boolean;
  }
  return undefined;
}

function numberOption(options: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = options[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

export function normalizeReasoningEffort(value: unknown, fallback: ReasoningEffort = "medium"): ReasoningEffort {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return REASONING_EFFORTS.includes(normalized as ReasoningEffort) ? normalized as ReasoningEffort : fallback;
}

function availableReasoningEfforts(options: Record<string, unknown>): ReasoningEffort[] {
  const configured = options.reasoningEfforts ?? options.reasoning_efforts;
  if (!Array.isArray(configured)) return [...REASONING_EFFORTS];
  const normalized = configured
    .map(value => normalizeReasoningEffort(value, "medium"))
    .filter((value, index, values) => values.indexOf(value) === index);
  return normalized.length > 0 ? normalized : [...REASONING_EFFORTS];
}

/**
 * Produces one provider-neutral control model. Provider adapters can expose
 * capability flags through model.options without changing the UI vocabulary.
 */
export function modelUiControls(modelOptions: unknown, providerId = ""): ModelUiControls {
  void providerId;
  const options = record(modelOptions);
  const capabilities = { ...options, ...record(options.capabilities), ...record(options.ui) };
  const efforts = availableReasoningEfforts(capabilities);
  const effort = normalizeReasoningEffort(capabilities.reasoningEffort ?? capabilities.reasoning_effort, efforts.includes("medium") ? "medium" : efforts[0]);
  const reasoningAvailable = booleanOption(capabilities, "reasoningAvailable", "reasoning_available", "supportsReasoning", "supports_reasoning") ?? false;
  const fastModeMultiplier = numberOption(capabilities, "fastModeMultiplier", "fast_mode_multiplier") ?? 1.5;
  const fastModeAvailable = booleanOption(capabilities, "fastModeAvailable", "fast_mode_available", "supportsFastMode", "supports_fast_mode") ?? false;

  return {
    reasoningEnabled: reasoningAvailable && (booleanOption(capabilities, "reasoningEnabled", "reasoning_enabled", "reasoning", "thinking") ?? false),
    reasoningAvailable,
    effort,
    availableEfforts: efforts,
    fastMode: fastModeAvailable && (booleanOption(capabilities, "fastMode", "fast_mode") ?? capabilities.serviceTier === "priority"),
    fastModeAvailable,
    fastModeMultiplier
  };
}

export function cycleReasoningEffort(controls: ModelUiControls): ModelUiControls {
  const available = controls.availableEfforts.length > 0 ? controls.availableEfforts : [...REASONING_EFFORTS];
  const current = Math.max(0, available.indexOf(controls.effort));
  return { ...controls, effort: available[(current + 1) % available.length] };
}

export function compactSessionTitle(prompt: string, maxLength = 42): string {
  const compact = sanitizeChromeText(prompt.replace(/\r\n?|\n/g, " ")).replace(/\s+/g, " ").trim();
  if (!compact) return "New session";
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

export function promptHeightForVisualLines(visualLines: number, minRows = 1, maxRows = 6): number {
  return Math.max(minRows, Math.min(maxRows, Math.max(1, Math.ceil(visualLines))));
}

export function shouldFollowLatestPosition(scrollHeight: number, scrollTop: number, viewportHeight: number, threshold = 1): boolean {
  return scrollHeight <= scrollTop + viewportHeight + Math.max(0, threshold);
}

export function shouldSyncSlashOverlay(sessionActive: boolean, ctrl = false, meta = false): boolean {
  void sessionActive;
  return !ctrl && !meta;
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "—";
  if (durationMs < 1000) return `${Math.max(1, Math.round(durationMs))}ms`;
  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

export function formatCount(value: number | undefined, singular: string, plural = `${singular}s`): string {
  if (value === undefined || !Number.isFinite(value)) return `— ${plural}`;
  const count = Math.max(0, Math.round(value));
  return `${count} ${count === 1 ? singular : plural}`;
}

export function formatTokens(tokens: number | undefined): string {
  if (tokens === undefined || !Number.isFinite(tokens)) return "— tok";
  if (tokens < 1000) return `${Math.max(0, Math.round(tokens))} tok`;
  return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k tok`;
}

export function formatCost(costUsd: number | undefined): string {
  if (costUsd === undefined || !Number.isFinite(costUsd)) return "$—";
  return `$${Math.max(0, costUsd).toFixed(costUsd < 1 ? 4 : 2)}`;
}

export function reasoningLabel(controls: ModelUiControls): string {
  if (!controls.reasoningAvailable) return "🧠 Reasoning unavailable";
  return controls.reasoningEnabled
    ? `🧠 Reasoning ${controls.effort[0].toUpperCase()}${controls.effort.slice(1)}`
    : "🧠 Reasoning Off";
}

export function fastModeLabel(controls: ModelUiControls): string {
  if (!controls.fastModeAvailable) return "⚡ Fast unavailable";
  return controls.fastMode
    ? `⚡ Fast On · ×${controls.fastModeMultiplier} cost`
    : `⚡ Fast Off · ×${controls.fastModeMultiplier} cost`;
}

export function turnReceiptLine(receipt: TurnReceipt): string {
  const status = receipt.status[0].toUpperCase() + receipt.status.slice(1);
  return [
    status,
    sanitizeChromeText(receipt.agent),
    sanitizeChromeText(receipt.model),
    formatDuration(receipt.durationMs),
    formatCount(receipt.toolCalls, "tool"),
    formatCount(receipt.skillsRead, "skill"),
    formatCount(receipt.mcpServersUsed, "MCP", "MCPs")
  ].join(" · ");
}

export function turnStatusIcon(status: TurnReceipt["status"]): string {
  if (status === "failed") return "×";
  if (status === "cancelled") return "■";
  return "✓";
}

export function sessionTelemetryLine(telemetry: SessionTelemetry): string {
  const loaded = telemetry.mcpServersLoaded === undefined || !Number.isFinite(telemetry.mcpServersLoaded)
    ? "— MCPs loaded"
    : `${Math.max(0, Math.round(telemetry.mcpServersLoaded))} MCP${telemetry.mcpServersLoaded === 1 ? "" : "s"} loaded`;
  return [
    formatTokens(telemetry.totalTokens),
    formatCost(telemetry.costUsd),
    loaded
  ].join(" · ");
}

export function commandHelpLines(): string[] {
  const modelAndAgentCommands = slashCommandHelpRows
    .filter(row => row.section === "models-agents")
    .map(row => row.text);
  const sessionCommands = slashCommandHelpRows
    .filter(row => row.section === "session")
    .map(row => row.text);
  return [
    "CHAT",
    "  Enter              Send message",
    "  Shift+Enter        New line",
    "  PgUp / PgDn        Scroll transcript",
    "  Ctrl+Home/End      Oldest / latest message",
    "",
    "MODELS & AGENTS",
    ...modelAndAgentCommands,
    "  Tab / Shift+Tab    Cycle Tesla · Newton · JBP · Bob",
    "  Composer strip     Active agent and model",
    "  ↑/↓ · Enter · Esc  Navigate, choose, or close menus",
    "  Mouse              Hover and click menu rows",
    "",
    "REASONING",
    "  Brain status       Off · minimal · low · medium · high · max",
    "  Fast status        Availability and cost multiplier",
    "  Controls follow the active model's capabilities",
    "",
    "SESSION",
    "  Ctrl+H / F1        Toggle this command sheet",
    ...sessionCommands.slice(0, -1),
    "  Esc                Close the active panel",
    ...sessionCommands.slice(-1)
  ];
}
