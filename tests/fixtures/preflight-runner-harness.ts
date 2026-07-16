import type { Agent } from "../../src/agents/agent";
import type { SummaryResult } from "../../src/agents/preflight/contracts";
import { summaryResultSchema } from "../../src/agents/preflight/contracts";
import type {
  PreflightOutcome,
  PreflightFailureCode,
  PreflightScheduleInput,
  PreflightTerminalOutcome
} from "../../src/agents/preflight/scheduler-types";
import { StrongCodeError } from "../../src/core/errors";
import { err, ok, type Result } from "../../src/core/result";
import type { ModelRequest, ModelResponse } from "../../src/models/provider";
import { SessionStore } from "../../src/sessions/session-store";
import { createDefaultToolRegistry } from "../../src/tools/registry";
import { AgentRunner } from "../../src/agents/runner";
import { tempWorkspace } from "../helpers";

export type RunnerPreflight = Readonly<{
  run: (input: PreflightScheduleInput) => Promise<Result<PreflightOutcome>>;
  close: (reason?: unknown) => Promise<void>;
}>;

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
}>;

export function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>(resolve => {
    resolvePromise = resolve;
  });
  if (resolvePromise === undefined) throw new Error("Deferred initialization failed");
  return { promise, resolve: resolvePromise };
}

export const committedResult = (generalSummary = "Generated summary"): SummaryResult => summaryResultSchema.parse({
  title: "Generated title",
  generalSummary,
  requestedItems: ["Keep the original request"]
});

export const terminalOutcome = (
  outcome: PreflightTerminalOutcome
): RunnerPreflight => ({
  async run() {
    return ok(outcome);
  },
  async close() {}
});

type RunnerFailureCode = Extract<PreflightFailureCode,
  "route_exhausted" | "root_json_invalid" | "tool_permission_denied" | "finalizer_provider_failed" | "overall_timeout">;

export const failedOpen = (reasonCode: RunnerFailureCode): PreflightTerminalOutcome => ({
  kind: "failed-open",
  reservationId: "reservation",
  logicalOperationId: "operation",
  reasonCode
});

export const cancelled = (): PreflightTerminalOutcome => ({
  kind: "cancelled",
  reservationId: "reservation",
  logicalOperationId: "operation",
  reasonCode: "user_cancelled",
  reasonAvailable: true,
  reason: "fixture cancellation"
});

export class RecordingPreflight implements RunnerPreflight {
  readonly inputs: PreflightScheduleInput[] = [];
  closeCalls = 0;

  constructor(private readonly response: Result<PreflightOutcome>) {}

  async run(input: PreflightScheduleInput): Promise<Result<PreflightOutcome>> {
    this.inputs.push(input);
    return this.response;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

export class PendingPreflight implements RunnerPreflight {
  readonly started = deferred<void>();
  readonly done = deferred<Result<PreflightTerminalOutcome>>();

  async run(): Promise<Result<PreflightOutcome>> {
    this.started.resolve();
    return ok({
      kind: "in-progress",
      reservationId: "reservation",
      logicalOperationId: "operation",
      done: this.done.promise
    });
  }

  async close(): Promise<void> {
    this.done.resolve(ok(cancelled()));
  }
}

export type PrimaryHarness = Readonly<{
  runner: AgentRunner;
  sessions: SessionStore;
  requests: ModelRequest[];
  agent: Agent;
}>;

export async function primaryHarness(preflight: RunnerPreflight): Promise<PrimaryHarness> {
  const workspace = await tempWorkspace();
  const requests: ModelRequest[] = [];
  const sessions = new SessionStore(workspace.context.dataDir);
  const agent: Agent = {
    name: "primary-fixture",
    runtimeRole: "primary",
    config: workspace.config.agents.default,
    systemPrompt: "Trusted primary instructions",
    model: {
      name: "shared-model",
      async complete(request): Promise<ModelResponse> {
        requests.push(request);
        return { message: "primary complete", toolCalls: [] };
      }
    }
  };
  const options = { maxToolCalls: 8, preflight };
  return {
    runner: new AgentRunner(workspace.context, sessions, createDefaultToolRegistry(), options),
    sessions,
    requests,
    agent
  };
}

export const committed = (summary = "Generated summary"): PreflightTerminalOutcome => ({
  kind: "committed",
  reservationId: "reservation",
  logicalOperationId: "operation",
  attemptId: "attempt",
  result: committedResult(summary)
});

export const storageFailure = (): RunnerPreflight => ({
  async run() {
    return err(new StrongCodeError("SESSION_ERROR", "fixture storage failure"));
  },
  async close() {}
});
