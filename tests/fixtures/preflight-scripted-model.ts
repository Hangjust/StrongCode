import type { Agent } from "../../src/agents/agent";
import type { PreflightRole } from "../../src/agents/preflight/metadata";
import type { ModelRequest, ModelResponse } from "../../src/models/provider";
import type { RuntimeContext } from "../../src/runtime/context";

export type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
}>;

export function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason: Error) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  if (!resolvePromise || !rejectPromise) throw new Error("Deferred initialization failed");
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

type Completion = ModelResponse | ((request: ModelRequest) => Promise<ModelResponse>);

const FIXTURE_TOOLS = [
  "read_file", "ripgrep", "web_search", "write_file", "shell", "question",
  "worker", "task", "spawn", "scheduler", "mcp__unknown__read"
] as const;

export class ScriptedPreflightModels {
  readonly requests: Readonly<Record<PreflightRole, ModelRequest[]>> = {
    summary: [], analysis: [], explorer: []
  };
  readonly created: PreflightRole[] = [];
  private readonly scripts: Record<PreflightRole, Completion[]> = {
    summary: [], analysis: [], explorer: []
  };
  private readonly requestWaiters: Record<PreflightRole, Array<(request: ModelRequest) => void>> = {
    summary: [], analysis: [], explorer: []
  };
  private readonly countWaiters: Record<PreflightRole, Array<Readonly<{
    count: number;
    resolve: () => void;
  }>>> = { summary: [], analysis: [], explorer: [] };

  enqueue(role: PreflightRole, ...completions: readonly Completion[]): void {
    this.scripts[role].push(...completions);
  }

  nextRequest(role: PreflightRole): Promise<ModelRequest> {
    return new Promise(resolve => this.requestWaiters[role].push(resolve));
  }

  waitForRequests(role: PreflightRole, count: number): Promise<void> {
    if (this.requests[role].length >= count) return Promise.resolve();
    return new Promise(resolve => this.countWaiters[role].push({ count, resolve }));
  }

  factory = (_config: RuntimeContext["config"], role: PreflightRole): Agent => {
    this.created.push(role);
    return {
      name: `$fixture-${role}`,
      runtimeRole: role,
      config: { model: "mock", tools: [...FIXTURE_TOOLS] },
      systemPrompt: `trusted-${role}-protocol`,
      model: {
        name: `fixture-${role}`,
        complete: async request => {
          this.requests[role].push(request);
          this.requestWaiters[role].shift()?.(request);
          for (const waiter of this.countWaiters[role].splice(0)) {
            if (this.requests[role].length >= waiter.count) waiter.resolve();
            else this.countWaiters[role].push(waiter);
          }
          const next = this.scripts[role].shift();
          if (!next) throw new Error(`Missing ${role} completion`);
          return typeof next === "function" ? next(request) : next;
        }
      }
    };
  };
}

export class CompletionBarrier {
  readonly started: number[] = [];
  active = 0;
  peak = 0;
  private readonly gate = deferred<void>();
  private readonly full = deferred<void>();

  constructor(private readonly expectedStarts: number) {}

  completion(index: number, response: ModelResponse): Completion {
    return async () => {
      this.started.push(index);
      this.active += 1;
      this.peak = Math.max(this.peak, this.active);
      if (this.started.length === this.expectedStarts) this.full.resolve(undefined);
      await this.gate.promise;
      this.active -= 1;
      return response;
    };
  }

  release(): void {
    this.gate.resolve(undefined);
  }

  waitUntilFull(): Promise<void> {
    return this.full.promise;
  }
}

export const modelResponse = (message: string, toolCalls: ModelResponse["toolCalls"] = []): ModelResponse => ({
  message,
  toolCalls
});

export const completeDecision = (title = "Fixture title"): ModelResponse => modelResponse(JSON.stringify({
  kind: "complete",
  result: { title, generalSummary: "Fixture summary", requestedItems: ["First"] }
}));

export const finalResult = (title = "Final title"): ModelResponse => modelResponse(JSON.stringify({
  title,
  generalSummary: "Final summary",
  requestedItems: ["First"]
}));

export function researchDecision(count: number): ModelResponse {
  return researchRequests(Array.from({ length: count }, (_, index) => ({
    id: `request-${index}`,
    role: index % 2 === 0 ? "analysis" : "explorer",
    question: `Question ${index}`
  })));
}

export function researchRequests(
  requests: readonly Readonly<{ id: string; role: "analysis" | "explorer"; question: string }>[]
): ModelResponse {
  return modelResponse(JSON.stringify({ kind: "research", requests }));
}

export function finding(
  index: number,
  role: "analysis" | "explorer" = index % 2 === 0 ? "analysis" : "explorer"
): ModelResponse {
  return modelResponse(JSON.stringify({
    requestId: `request-${index}`,
    role,
    summary: `Finding ${index}`,
    sources: []
  }));
}

export function responseWithIdentity(identity: Readonly<{
  requestId?: string;
  responseId?: string;
  directAttempts?: ModelResponse["directAttempts"];
}>): ModelResponse {
  return {
    ...completeDecision(),
    ...(identity.requestId === undefined ? {} : { providerRequestId: identity.requestId }),
    ...(identity.responseId === undefined ? {} : { providerResponseId: identity.responseId }),
    ...(identity.directAttempts === undefined ? {} : { directAttempts: identity.directAttempts })
  };
}
