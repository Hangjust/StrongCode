import { Message, ToolCall } from "../core/types";

export interface ModelRequest {
  prompt: string;
  sessionId: string;
  messages: Message[];
  tools: string[];
}

export interface ModelResponse {
  message: string;
  toolCalls: ToolCall[];
}

export interface ModelProvider {
  name: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}
