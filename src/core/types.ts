export type Role = "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  content: string;
}

export interface ToolCall {
  name: string;
  input: unknown;
}

export interface ToolExecution {
  tool: string;
  input: unknown;
  output: string;
}

export interface AgentRunResult {
  sessionId: string;
  response: string;
  toolExecutions: ToolExecution[];
}
