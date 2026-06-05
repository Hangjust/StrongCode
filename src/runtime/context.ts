import path from "node:path";
import { StrongCodeConfig } from "../config/schema";
import { RuntimeEventSink } from "./events";

export interface RuntimeContext {
  config: StrongCodeConfig;
  configPath: string;
  workspaceRoot: string;
  dataDir: string;
  emit: RuntimeEventSink;
}

export function createRuntimeContext(config: StrongCodeConfig, configPath: string, configDirectory: string, emit: RuntimeEventSink = () => undefined): RuntimeContext {
  return {
    config,
    configPath,
    workspaceRoot: path.resolve(configDirectory, config.workspace),
    dataDir: path.resolve(configDirectory, config.dataDir),
    emit
  };
}
