import { AgentConfig } from "../config/schema";
import { ModelProvider } from "../models/provider";

export interface Agent {
  name: string;
  config: AgentConfig;
  model: ModelProvider;
}
