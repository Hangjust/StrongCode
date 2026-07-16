import { randomUUID } from "node:crypto";
import type { Agent } from "../agent";
import { StrongCodeError } from "../../core/errors";
import { err, ok, type Result } from "../../core/result";
import type { ToolInvocationContext } from "../../runtime/context";
import type { SessionEvent } from "../../sessions/session";
import { projectSessionLedger, type SummaryProjection } from "../../sessions/session-ledger-projection";
import type { ToolRegistry } from "../../tools/registry";
import { cancelledError } from "../runner-outcome";
import { committedPreflightAdvice, type UntrustedPreflightAdvice } from "./advice";
import type { PreflightOutcome, PreflightScheduleInput, PreflightTerminalOutcome } from "./scheduler-types";

export type PrimaryPreflightScheduler = Readonly<{
  run: (input: PreflightScheduleInput) => Promise<Result<PreflightOutcome>>;
  close: (reason?: unknown) => Promise<void>;
}>;

type PrimaryPreflightInput = Readonly<{
  scheduler: PrimaryPreflightScheduler;
  agent: Agent;
  prompt: string;
  sessionId: string;
  events: readonly SessionEvent[];
  context: ToolInvocationContext;
  tools: ToolRegistry;
}>;

function scheduleIdentity(
  summary: SummaryProjection,
  prompt: string
): Readonly<{ sourceMessageId: string; originalPrompt: string }> | undefined {
  switch (summary.kind) {
    case "unreserved":
      return { sourceMessageId: randomUUID(), originalPrompt: prompt };
    case "reserved":
      return {
        sourceMessageId: summary.reservation.sourceMessageId,
        originalPrompt: summary.reservation.originalPrompt
      };
    case "unavailable":
    case "committed":
    case "failed-open":
    case "cancelled":
      return undefined;
    default: {
      const exhaustiveSummary: never = summary;
      return exhaustiveSummary;
    }
  }
}

function terminalAdvice(outcome: PreflightTerminalOutcome): Result<UntrustedPreflightAdvice | undefined> {
  switch (outcome.kind) {
    case "committed":
      return ok(committedPreflightAdvice(outcome));
    case "failed-open":
      return ok(undefined);
    case "cancelled":
      return err(cancelledError());
    default: {
      const exhaustiveOutcome: never = outcome;
      return exhaustiveOutcome;
    }
  }
}

function failedSchedule(error: unknown, signal: AbortSignal | undefined): Result<undefined> {
  if (signal?.aborted || (error instanceof StrongCodeError && error.code === "CANCELLED")) {
    return err(cancelledError());
  }
  return ok(undefined);
}

export async function runPrimaryPreflight(
  input: PrimaryPreflightInput
): Promise<Result<UntrustedPreflightAdvice | undefined>> {
  if (input.prompt.trim().length === 0 || (input.agent.runtimeRole ?? "primary") !== "primary") return ok(undefined);
  const identity = scheduleIdentity(projectSessionLedger(input.events).summary, input.prompt);
  if (identity === undefined) return ok(undefined);

  let scheduled: Result<PreflightOutcome>;
  try {
    scheduled = await input.scheduler.run({
      sessionId: input.sessionId,
      sourceMessageId: identity.sourceMessageId,
      originalPrompt: identity.originalPrompt,
      context: input.context,
      toolRegistry: input.tools,
      ...(input.context.signal === undefined ? {} : { signal: input.context.signal }),
      ...(input.context.effectivePermissions === undefined
        ? {}
        : { effectivePermissions: input.context.effectivePermissions })
    });
  } catch (error) {
    if (error instanceof Error) return failedSchedule(error, input.context.signal);
    return failedSchedule(error, input.context.signal);
  }
  if (!scheduled.ok) return failedSchedule(scheduled.error, input.context.signal);

  switch (scheduled.value.kind) {
    case "in-progress": {
      try {
        const completed = await scheduled.value.done;
        return completed.ok
          ? terminalAdvice(completed.value)
          : failedSchedule(completed.error, input.context.signal);
      } catch (error) {
        if (error instanceof Error) return failedSchedule(error, input.context.signal);
        return failedSchedule(error, input.context.signal);
      }
    }
    case "committed":
    case "failed-open":
    case "cancelled":
      return terminalAdvice(scheduled.value);
    case "ignored-empty":
    case "existing":
      return ok(undefined);
    default: {
      const exhaustiveOutcome: never = scheduled.value;
      return exhaustiveOutcome;
    }
  }
}
