import type { Session } from "./session";
import { parseSessionEvent } from "./session";
import { projectSessionLedger } from "./session-ledger-projection";

export function parseSessionJsonl(sessionId: string, source: string): Session {
  const events = source
    .split("\n")
    .filter(line => line.trim().length > 0)
    .map(parseSessionEvent);
  projectSessionLedger(events);
  return { id: sessionId, events };
}
