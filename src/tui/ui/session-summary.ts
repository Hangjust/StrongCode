import type { SessionEvent } from "../../sessions/session";
import { projectSessionLedger } from "../../sessions/session-ledger-projection";
import { sanitizeTerminalMultiline } from "../../core/terminal-text";
import { formatCost, formatTokens, sanitizeChromeText } from "./session-chrome";

export type SummaryDisplayStatus = "unavailable" | "pending" | "committed" | "failed-open" | "cancelled";
export type TelemetryProvenance = "provider-reported" | "estimated";

export interface ImmutableSessionSummary {
  readonly status: SummaryDisplayStatus;
  readonly originalPrompt?: string;
  readonly title?: string;
  readonly generalSummary?: string;
  readonly requestedItems: readonly string[];
}

export interface SessionTelemetryProjection {
  readonly totalTokens?: number;
  readonly costUsd?: number;
  readonly costProvenance?: TelemetryProvenance;
  readonly contextInputTokens?: number;
  readonly contextWindowTokens?: number;
  readonly summary?: ImmutableSessionSummary;
}

function summaryFromEvents(events: readonly SessionEvent[]): ImmutableSessionSummary | undefined {
  const projection = projectSessionLedger(events);
  const reservation = events.find(event => event.type === "summary_reserved");
  const originalPrompt = reservation?.type === "summary_reserved" ? reservation.originalPrompt : undefined;
  switch (projection.summary.kind) {
    case "committed":
      return {
        status: "committed",
        originalPrompt,
        title: projection.summary.result.title,
        generalSummary: projection.summary.result.generalSummary,
        requestedItems: projection.summary.result.requestedItems
      };
    case "failed-open":
      return { status: "failed-open", originalPrompt, requestedItems: [] };
    case "cancelled":
      return { status: "cancelled", originalPrompt, requestedItems: [] };
    case "reserved":
      return { status: "pending", originalPrompt: projection.summary.reservation.originalPrompt, requestedItems: [] };
    case "unavailable":
      return { status: "unavailable", requestedItems: [] };
    case "unreserved":
      return undefined;
    default:
      return assertNever(projection.summary);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected summary projection: ${JSON.stringify(value)}`);
}

export function projectSessionTelemetry(events: readonly SessionEvent[]): SessionTelemetryProjection {
  const projection = projectSessionLedger(events);
  const attempts = Array.from(projection.attempts.values());
  const started = attempts.filter(attempt => attempt.started);
  const reportedTotals = started.map(attempt => attempt.usage?.usageProvenance === "provider-reported"
    ? attempt.usage.usage?.totalTokens
    : undefined);
  const totalTokens = started.length > 0 && reportedTotals.every(value => value !== undefined)
    ? safeSum(reportedTotals, true)
    : undefined;
  const costs = started.map(attempt => attempt.usage?.cost);
  const firstCost = costs[0];
  const costUsd = firstCost !== undefined
    && firstCost.currency === "USD"
    && costs.every(cost => cost?.currency === "USD" && cost.kind === firstCost.kind)
    ? safeSum(costs.map(cost => cost?.amount), false)
    : undefined;
  const contextAttempt = [...attempts].reverse().find(attempt => (
    attempt.created.role === "primary"
    && attempt.created.context?.provenance === "provider-reported"
    && attempt.created.context.usedTokens !== undefined
    && attempt.created.model.contextWindowTokens !== undefined
  ));
  const context = contextAttempt?.created.context;
  return {
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(costUsd === undefined || firstCost === undefined ? {} : { costUsd, costProvenance: firstCost.kind }),
    ...(context?.usedTokens === undefined ? {} : { contextInputTokens: context.usedTokens }),
    ...(contextAttempt?.created.model.contextWindowTokens === undefined ? {} : { contextWindowTokens: contextAttempt.created.model.contextWindowTokens }),
    ...(summaryFromEvents(events) === undefined ? {} : { summary: summaryFromEvents(events) })
  };
}

function safeSum(values: readonly (number | undefined)[], requireSafeInteger: boolean): number | undefined {
  let total = 0;
  for (const value of values) {
    if (value === undefined || !Number.isFinite(value)) return undefined;
    total += value;
    if (requireSafeInteger ? !Number.isSafeInteger(total) : !Number.isFinite(total)) return undefined;
  }
  return total;
}

export function contextPercentage(telemetry: SessionTelemetryProjection): string {
  const input = telemetry.contextInputTokens;
  const window = telemetry.contextWindowTokens;
  if (input === undefined || window === undefined || window <= 0) return "—";
  return `${((input / window) * 100).toFixed(1)}%`;
}

function summaryStatusLine(summary: ImmutableSessionSummary | undefined): string {
  if (summary === undefined || summary.status === "unavailable") return "Generated summary unavailable";
  if (summary.status === "pending") return "Summary pending";
  if (summary.status === "failed-open") return "Generated summary unavailable (failed-open)";
  if (summary.status === "cancelled") return "Generated summary unavailable (cancelled)";
  return "";
}

export function summaryRailLines(telemetry: SessionTelemetryProjection): readonly string[] {
  const summary = telemetry.summary;
  const lines = [
    summary?.status === "committed" ? sanitizeChromeText(summary.title ?? "") : summaryStatusLine(summary),
    ...(summary?.status === "committed" ? [sanitizeChromeText(summary.generalSummary ?? "")] : []),
    `Tokens ${telemetry.totalTokens === undefined ? "—" : formatTokens(telemetry.totalTokens)}${telemetry.totalTokens === undefined ? "" : " provider-reported"}`,
    `Context ${contextPercentage(telemetry)}`,
    `Spend ${telemetry.costUsd === undefined ? "—" : formatCost(telemetry.costUsd)}${telemetry.costProvenance === undefined ? "" : ` ${telemetry.costProvenance}`}`,
    ...(summary?.originalPrompt === undefined ? [] : ["Summary ->"]),
    ...(summary?.status === "committed"
      ? summary.requestedItems.map((item, index) => `${index + 1}. ${sanitizeChromeText(item)}`)
      : [])
  ];
  return lines.filter(Boolean);
}

export function summaryDetailLines(telemetry: SessionTelemetryProjection): readonly string[] {
  const summary = telemetry.summary;
  return [
    ...summaryRailLines(telemetry),
    "",
    "FIRST REQUEST",
    ...(summary?.originalPrompt === undefined
      ? ["Unavailable"]
      : sanitizeTerminalMultiline(summary.originalPrompt).replace(/\r\n?/g, "\n").split("\n"))
  ];
}
