import { Message, ToolExecution } from "../core/types";

export type SessionEvent =
  | {
      type: "message";
      timestamp: string;
      role: Message["role"];
      content: string;
    }
  | {
      type: "tool";
      timestamp: string;
      tool: string;
      input: unknown;
      output: string;
    };

export interface Session {
  id: string;
  events: SessionEvent[];
}

export function messageEvent(role: Message["role"], content: string): SessionEvent {
  return {
    type: "message",
    timestamp: new Date().toISOString(),
    role,
    content
  };
}

export function toolEvent(execution: ToolExecution): SessionEvent {
  return {
    type: "tool",
    timestamp: new Date().toISOString(),
    tool: execution.tool,
    input: execution.input,
    output: execution.output
  };
}

export function eventsToMessages(events: SessionEvent[]): Message[] {
  return events.map(event => {
    if (event.type === "message") {
      return { role: event.role, content: event.content };
    }

    return { role: "tool", content: event.output };
  });
}
