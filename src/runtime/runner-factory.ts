import { randomUUID } from "node:crypto";
import type { ModelConfig } from "../config/schema";
import { AgentRunner, type AgentRunnerOptions } from "../agents/runner";
import { createPreflightAgent, type CreatePreflightAgentOptions } from "../agents/preflight/factory";
import { resolvePreflightModel } from "../agents/preflight/routing";
import { PreflightScheduler } from "../agents/preflight/scheduler";
import { PreflightRunRegistry } from "../agents/preflight/scheduler-registry";
import type { PreflightClock } from "../agents/preflight/scheduler-types";
import type { SessionStore } from "../sessions/session-store";
import type { ToolRegistry } from "../tools/registry";
import type { ToolInvocationContext } from "./context";

type RuntimeRunnerInput = Readonly<{
  sessions: SessionStore;
  tools: ToolRegistry;
  providerOptions?: CreatePreflightAgentOptions;
  runnerOptions?: AgentRunnerOptions;
}>;

const PROCESS_PREFLIGHT_RUN_REGISTRY = new PreflightRunRegistry();

function configuredModelSnapshot(
  modelRef: string,
  providerRef: string,
  displayName: string,
  configured: ModelConfig | undefined
): Readonly<{
  modelRef: string;
  providerRef: string;
  displayName: string;
  contextWindowTokens?: number;
  pricing?: ModelConfig["pricing"];
}> {
  return {
    modelRef,
    providerRef,
    displayName,
    ...(configured?.contextWindowTokens === undefined ? {} : { contextWindowTokens: configured.contextWindowTokens }),
    ...(configured?.pricing === undefined ? {} : { pricing: configured.pricing })
  };
}

function runtimeClock(): PreflightClock {
  let nextTimerId = 0;
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  return {
    now: () => Date.now(),
    setTimer: (callback, delayMs) => {
      const timerId = ++nextTimerId;
      timers.set(timerId, setTimeout(() => {
        timers.delete(timerId);
        callback();
      }, delayMs));
      return timerId;
    },
    clearTimer: handle => {
      if (typeof handle !== "number") return;
      const timer = timers.get(handle);
      if (timer === undefined) return;
      clearTimeout(timer);
      timers.delete(handle);
    }
  };
}

export class RuntimeAgentRunnerFactory {
  private readonly registry = PROCESS_PREFLIGHT_RUN_REGISTRY;

  constructor(private readonly context: ToolInvocationContext) {}

  create(input: RuntimeRunnerInput): AgentRunner {
    const configured = this.context.config.preflight;
    if (configured === undefined || configured.enabled === false) {
      return new AgentRunner(this.context, input.sessions, input.tools, input.runnerOptions);
    }
    const scheduler = new PreflightScheduler({
      sessions: input.sessions,
      registry: this.registry,
      clock: runtimeClock(),
      ids: { next: randomUUID },
      createAgent: (config, role) => createPreflightAgent(config, role, input.providerOptions),
      resolveModelSnapshot: ({ role, directAttempt }) => {
        if (directAttempt !== undefined) {
          const directConfigured = this.context.config.models[directAttempt.model];
          const trustedConfigured = directConfigured?.provider === directAttempt.provider
            ? directConfigured
            : undefined;
          return configuredModelSnapshot(
            directAttempt.model,
            directAttempt.provider,
            trustedConfigured?.displayName ?? directAttempt.model,
            trustedConfigured
          );
        }
        if (role === "primary") throw new Error("Primary snapshots are resolved by the primary runner");
        const route = resolvePreflightModel(this.context.config, role);
        return configuredModelSnapshot(route.modelId, route.providerId, route.model.displayName ?? route.modelId, route.model);
      }
    });
    return new AgentRunner(this.context, input.sessions, input.tools, {
      ...input.runnerOptions,
      preflight: scheduler
    });
  }
}
