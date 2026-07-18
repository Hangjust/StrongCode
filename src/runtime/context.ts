import path from "node:path";
import { StrongCodeConfig } from "../config/schema";
import type { PathReceipt } from "../core/path-identity";
import { RuntimeEventSink } from "./events";

export interface RuntimeContext {
  config: StrongCodeConfig;
  configPath: string;
  workspaceRoot: string;
  dataDir: string;
  emit: RuntimeEventSink;
  readonly automaticHomeReceipt?: PathReceipt;
}

export interface RuntimeContextOptions {
  readonly automaticHomeReceipt?: PathReceipt | undefined;
  readonly emit?: RuntimeEventSink | undefined;
  readonly workspaceRootOverride?: string | undefined;
}

export type EffectiveToolPermission = "allow" | "ask" | "deny";

export interface ToolInvocationContext extends RuntimeContext {
  readonly signal?: AbortSignal;
  readonly taskId?: string;
  readonly effectivePermissions?: Readonly<Record<string, EffectiveToolPermission>>;
  readonly ownership?: readonly string[];
  readonly computerUse?: "explicit-user-request";
}

export function createRuntimeContext(
  config: StrongCodeConfig,
  configPath: string,
  configDirectory: string,
  options: RuntimeContextOptions = {}
): RuntimeContext {
  return {
    config,
    configPath,
    workspaceRoot: path.resolve(options.workspaceRootOverride ?? path.resolve(configDirectory, config.workspace)),
    dataDir: path.resolve(configDirectory, config.dataDir),
    emit: options.emit ?? (() => undefined),
    ...(options.automaticHomeReceipt === undefined ? {} : { automaticHomeReceipt: options.automaticHomeReceipt })
  };
}
