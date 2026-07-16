import { execFile, spawnSync } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  projectSessionTelemetry,
  summaryDetailLines,
  summaryRailLines
} from "../src/tui/ui/session-summary";
import { creation, ledgerEvent, reservation, succeeded, usage } from "./session-ledger-fixtures";

const execFileAsync = promisify(execFile);
const visualIt = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0 ? it : it.skip;

describe("preflight session TUI projection", () => {
  it("renders immutable committed summary metadata with provider provenance", () => {
    // Given
    const events = [
      reservation(),
      creation("attempt-summary", { context: { windowTokens: 10_000, usedTokens: 8_500, provenance: "provider-reported" } }),
      ...succeeded("attempt-summary"),
      usage("attempt-summary", 0.0123, {
        usage: { inputTokens: 8_500, outputTokens: 200, totalTokens: 8_700 },
        cost: { kind: "provider-reported", amount: 0.0123, currency: "USD" }
      }),
      ledgerEvent("summary_committed", "commit", {
        reservationId: "reservation-1",
        attemptId: "attempt-summary",
        result: { title: "Stable title", generalSummary: "General summary", requestedItems: ["First item", "Second item"] }
      })
    ];

    // When
    const telemetry = projectSessionTelemetry(events);

    // Then
    const rail = summaryRailLines(telemetry);
    const title = rail.indexOf("Stable title");
    const general = rail.indexOf("General summary");
    const tokens = rail.indexOf("Tokens 8.7k tok provider-reported");
    const context = rail.indexOf("Context —");
    const spend = rail.indexOf("Spend $0.0123 provider-reported");
    const summaryLink = rail.indexOf("Summary ->");
    const firstItem = rail.indexOf("1. First item");
    const secondItem = rail.indexOf("2. Second item");
    expect(title).toBeGreaterThanOrEqual(0);
    expect(general).toBeGreaterThan(title);
    expect(tokens).toBeGreaterThan(general);
    expect(context).toBeGreaterThan(tokens);
    expect(spend).toBeGreaterThan(context);
    expect(summaryLink).toBeGreaterThan(spend);
    expect(firstItem).toBeGreaterThan(summaryLink);
    expect(secondItem).toBeGreaterThan(firstItem);
    expect(summaryDetailLines(telemetry)).toContain("  exact prompt bytes  ");
  });

  it("keeps failed-open and cancelled prompts reachable without generated fields", () => {
    // Given
    const failed = [reservation(), ledgerEvent("summary_failed_open", "failed", { reservationId: "reservation-1", reasonCode: "route_exhausted" })];
    const cancelled = [reservation(), ledgerEvent("summary_cancelled", "cancelled", { reservationId: "reservation-1", reasonCode: "user_cancelled" })];

    // When
    const failedTelemetry = projectSessionTelemetry(failed);
    const cancelledTelemetry = projectSessionTelemetry(cancelled);

    // Then
    expect(summaryRailLines(failedTelemetry)).toContain("Generated summary unavailable (failed-open)");
    expect(summaryRailLines(cancelledTelemetry)).toContain("Generated summary unavailable (cancelled)");
    expect(summaryDetailLines(failedTelemetry)).toContain("  exact prompt bytes  ");
    expect(summaryDetailLines(cancelledTelemetry)).toContain("  exact prompt bytes  ");
  });

  it("renders unavailable telemetry as em dashes and sanitizes only render output", () => {
    // Given
    const original = "  Long CJK request 日本語\x1b[2J  ";
    const events = [ledgerEvent("summary_reserved", "reservation-control", {
      reservationId: "reservation-control", logicalOperationId: "operation-control", sourceMessageId: "message-control", originalPrompt: original
    })];

    // When
    const telemetry = projectSessionTelemetry(events);
    const detail = summaryDetailLines(telemetry).join("\n");

    // Then
    expect(summaryRailLines(telemetry)).toEqual(expect.arrayContaining(["Tokens —", "Context —", "Spend —"]));
    expect(detail).toContain("Long CJK request 日本語");
    expect(detail).not.toContain("\x1b");
    expect(telemetry.summary?.originalPrompt).toBe(original);
  });

  it("uses only complete provider totals and the latest primary context", () => {
    const events = [
      creation("attempt-summary", { context: { windowTokens: 10_000, usedTokens: 9_000, provenance: "provider-reported" } }),
      ...succeeded("attempt-summary"),
      usage("attempt-summary", 0.01),
      creation("attempt-primary-old", { role: "primary", context: { windowTokens: 10_000, usedTokens: 1_000, provenance: "provider-reported" } }),
      ...succeeded("attempt-primary-old"),
      usage("attempt-primary-old", 0.02),
      creation("attempt-primary-latest", { role: "primary", context: { windowTokens: 10_000, usedTokens: 2_500, provenance: "provider-reported" } }),
      ...succeeded("attempt-primary-latest"),
      usage("attempt-primary-latest", 0.03, { usage: { inputTokens: 3, outputTokens: 2 } })
    ];

    const telemetry = projectSessionTelemetry(events);

    expect(telemetry.totalTokens).toBeUndefined();
    expect(telemetry.contextInputTokens).toBe(2_500);
    expect(summaryRailLines(telemetry)).toContain("Tokens —");
    expect(summaryRailLines(telemetry)).toContain("Context 25.0%");
  });

  it("prefers provider-reported cost over configured estimates for a physical attempt", () => {
    const events = [
      creation("attempt-primary", { role: "primary" }),
      ...succeeded("attempt-primary"),
      usage("attempt-primary", 0.01, { cost: { kind: "provider-reported", amount: 0.04, currency: "USD" } })
    ];

    const telemetry = projectSessionTelemetry(events);

    expect(telemetry.costUsd).toBe(0.04);
    expect(telemetry.costProvenance).toBe("provider-reported");
  });

  visualIt("keeps Summary projection bounded across wide, narrow, and terminal outcomes", async () => {
    // Given
    const fixture = path.resolve(__dirname, "fixtures", "render-preflight-summary.ts");
    const cases = [
      ["110", "success"],
      ["109", "success"],
      ["110", "fallback"],
      ["110", "failed-open"],
      ["110", "cancelled"]
    ] as const;

    // When
    const output = await Promise.all(cases.map(async ([width, mode]) => (
      execFileAsync("bun", [fixture, width, mode], { cwd: path.resolve(__dirname, "..") })
    )));

    // Then
    expect(output[0].stdout).toContain('"railVisible":true');
    expect(output[0].stdout).toContain('"hasContext":true');
    expect(output[0].stdout).toContain('"hasRequestedItems":true');
    expect(output[0].stdout).toContain('"hasGeneratedUnicode":true');
    expect(output[0].stdout).toContain('"hasGeneratedEscapeControl":false');
    expect(output[1].stdout).toContain('"railVisible":false');
    expect(output[2].stdout).toContain('"hasRequestedItems":true');
    expect(output[3].stdout).toContain('"hasOriginalPrompt":true');
    expect(output[4].stdout).toContain('"hasOriginalPrompt":true');
    for (const [index, [width]] of cases.entries()) expect(output[index]?.stdout).toContain(`"maxCellWidth":${width}`);
  });
});
