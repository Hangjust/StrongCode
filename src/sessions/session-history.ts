import type { SessionEvent } from "./session";

export function isMeaningfulUserEvent(event: SessionEvent): boolean {
  switch (event.type) {
    case "message":
      return event.role === "user" && event.content.trim().length > 0;
    case "conversation_item":
      return event.item.type === "text" && event.item.role === "user" && event.item.content.trim().length > 0;
    case "tool":
    case "compaction_checkpoint":
    case "summary_reserved":
    case "summary_committed":
    case "summary_failed_open":
    case "summary_cancelled":
    case "attempt_created":
    case "attempt_lifecycle":
    case "attempt_usage":
      return false;
    default: {
      const exhaustiveEvent: never = event;
      return exhaustiveEvent;
    }
  }
}
