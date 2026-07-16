import type { PreflightLimits, PreflightScheduleInput } from "./scheduler-types";
import type { PreflightTerminalOutcome } from "./scheduler-types";
import type { Result } from "../../core/result";
import type { PreflightTerminalAuthority } from "./scheduler-terminal-authority";
import type { PreflightTraceWriter } from "./scheduler-trace";

export type PreflightRunContext = Readonly<{
  input: PreflightScheduleInput;
  reservationId: string;
  logicalOperationId: string;
  limits: PreflightLimits;
  signal: AbortSignal;
  externalTerminal: () => Result<PreflightTerminalOutcome> | undefined;
  terminalAuthority: PreflightTerminalAuthority;
  overallDeadlineAt: number;
  timedOut: () => boolean;
  closed: () => boolean;
  trace: PreflightTraceWriter;
}>;
