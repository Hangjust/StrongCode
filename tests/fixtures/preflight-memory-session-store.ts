import { err, ok, type Result } from "../../src/core/result";
import type { Session } from "../../src/sessions/session";
import { parseSessionLedgerEvent, type LedgerCommitEvent } from "../../src/sessions/session-ledger-events";
import {
  decideLedgerCommit,
  decideSummaryReservation,
  type SessionLedgerCommitOutcome,
  type SummaryReservationInput,
  type SummaryReservationOutcome
} from "../../src/sessions/session-ledger-store";
import { SessionStore } from "../../src/sessions/session-store";
import type { SessionWriteGuard } from "../../src/sessions/session-store-io";
import { StrongCodeError } from "../../src/core/errors";

export class PreflightMemorySessionStore extends SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor() {
    super(".");
  }

  override operationKey(sessionId: string): Result<string> {
    return ok(`memory:${sessionId}`);
  }

  override async reserveFirstSummary(
    sessionId: string,
    input: SummaryReservationInput
  ): Promise<Result<SummaryReservationOutcome>> {
    const session = this.session(sessionId);
    const decision = decideSummaryReservation(session, input);
    if (decision.event !== undefined) this.appendEvent(sessionId, decision.event);
    return ok(decision.outcome);
  }

  override async commitLedgerEvent(
    sessionId: string,
    input: LedgerCommitEvent,
    isCurrent: SessionWriteGuard = () => true
  ): Promise<Result<SessionLedgerCommitOutcome>> {
    const event = parseSessionLedgerEvent(input);
    if (event.type === "summary_reserved") {
      return err(new StrongCodeError("SESSION_ERROR", "Reservation requires reserveFirstSummary"));
    }
    const decision = decideLedgerCommit(this.session(sessionId), event);
    if (decision.event === undefined) return ok(decision.outcome);
    const guard = isCurrent();
    const allowed = typeof guard === "boolean" ? guard : await guard;
    if (!allowed) return ok({ kind: "rejected", reason: "stale" });
    this.appendEvent(sessionId, decision.event);
    return ok(decision.outcome);
  }

  override async read(sessionId: string): Promise<Result<Session>> {
    const session = this.sessions.get(sessionId);
    return session === undefined
      ? err(new StrongCodeError("SESSION_ERROR", `Session not found: ${sessionId}`))
      : ok(session);
  }

  childAttemptCommits(sessionId: string): number {
    return this.session(sessionId).events.filter(event => (
      event.type === "attempt_created" && (event.role === "analysis" || event.role === "explorer")
    )).length;
  }

  private session(sessionId: string): Session {
    return this.sessions.get(sessionId) ?? { id: sessionId, events: [] };
  }

  private appendEvent(sessionId: string, event: Session["events"][number]): void {
    const session = this.session(sessionId);
    this.sessions.set(sessionId, { id: sessionId, events: [...session.events, event] });
  }
}
