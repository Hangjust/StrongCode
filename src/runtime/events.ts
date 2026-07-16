export type RuntimeEventType =
  | "run_started"
  | "tool_started"
  | "tool_finished"
  | "run_finished"
  | "run_failed"
  | "run_cancelled";

export interface RuntimeEvent {
  type: RuntimeEventType;
  timestamp: string;
  message: string;
}

export type RuntimeEventSink = (event: RuntimeEvent) => void;

export function createRuntimeEvent(type: RuntimeEventType, message: string): RuntimeEvent {
  return {
    type,
    timestamp: new Date().toISOString(),
    message
  };
}
