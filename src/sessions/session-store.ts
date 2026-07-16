import path from "node:path";
import { err, ok, type Result } from "../core/result";
import {
  CompactionCheckpointStore,
  type CheckpointCommitFaultInjector,
  type CompactionSessionSnapshot,
  type SessionRevision
} from "./compaction-checkpoint-store";
import {
  isMissing,
  SessionFileSecurity,
  sessionError,
  toSessionError
} from "./session-file-security";
import {
  parseConversationSessionEvent,
  type CompactionCheckpointSessionEvent,
  type ConversationSessionEvent,
  type Session,
} from "./session";
import { parseSessionJsonl } from "./session-jsonl";
import {
  parseSessionLedgerEvent,
  type LedgerCommitEvent
} from "./session-ledger-events";
import {
  decideLedgerCommit,
  decideSummaryReservation,
  type SessionLedgerCommitOutcome,
  type SnapshotDecision,
  type SummaryReservationInput,
  type SummaryReservationOutcome
} from "./session-ledger-store";
import {
  SessionStoreIo,
  type SessionWriteGuard,
  type SessionWriteOutcome
} from "./session-store-io";
import { listSessionIds, SESSION_FILE_SUFFIX, SESSION_ID_PATTERN } from "./session-store-list";

export interface SessionStoreOptions {
  readonly checkpointCommitFault?: CheckpointCommitFaultInjector;
}

export type SessionCommitGuard = SessionWriteGuard;
export type SessionCommitOutcome = SessionWriteOutcome;
export type { SessionLedgerCommitOutcome, SummaryReservationInput, SummaryReservationOutcome };

export class SessionStore {
  private static readonly writeQueues = new Map<string, Promise<void>>();
  private readonly dataDir: string;
  private readonly sessionsDir: string;
  private readonly security: SessionFileSecurity;
  private readonly checkpoints: CompactionCheckpointStore;
  private readonly io: SessionStoreIo;

  constructor(dataDir: string, options?: SessionStoreOptions) {
    this.dataDir = path.resolve(dataDir);
    this.sessionsDir = path.join(this.dataDir, "sessions");
    this.security = new SessionFileSecurity(this.dataDir);
    this.io = new SessionStoreIo(this.security);
    this.checkpoints = new CompactionCheckpointStore({
      security: this.security,
      ...(options?.checkpointCommitFault === undefined
        ? {}
        : { fault: options.checkpointCommitFault })
    });
  }

  pathFor(sessionId: string): Result<string> {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return err(sessionError("Session id may only contain letters, numbers, dot, underscore, and dash"));
    }
    return ok(path.join(this.sessionsDir, `${sessionId}${SESSION_FILE_SUFFIX}`));
  }

  operationKey(sessionId: string): Result<string> {
    const filePath = this.pathFor(sessionId);
    if (!filePath.ok) return filePath;
    const resolved = path.resolve(filePath.value);
    return ok(process.platform === "win32" ? resolved.toLowerCase() : resolved);
  }

  async append(sessionId: string, event: ConversationSessionEvent): Promise<Result<void>> {
    const filePath = this.pathFor(sessionId);
    if (!filePath.ok) return filePath;
    try {
      const payload = `${JSON.stringify(parseConversationSessionEvent(event))}\n`;
      await this.enqueueOperation(filePath.value, () => this.io.append(filePath.value, payload));
      return ok(undefined);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return err(toSessionError(error));
    }
  }

  async commitGuarded(
    sessionId: string,
    event: ConversationSessionEvent | undefined,
    guard: SessionCommitGuard
  ): Promise<Result<SessionCommitOutcome>> {
    const filePath = this.pathFor(sessionId);
    if (!filePath.ok) return filePath;
    try {
      const outcome = await this.enqueueOperation(filePath.value, async () => {
        if (event !== undefined) {
          const parsed = parseConversationSessionEvent(event);
          return this.io.append(filePath.value, `${JSON.stringify(parsed)}\n`, guard);
        }
        const decision = guard();
        const allowed = typeof decision === "boolean" ? decision : await decision;
        return allowed ? { kind: "committed" as const } : { kind: "rejected" as const };
      });
      return ok(outcome);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return err(toSessionError(error));
    }
  }

  async reserveFirstSummary(
    sessionId: string,
    input: SummaryReservationInput
  ): Promise<Result<SummaryReservationOutcome>> {
    const filePath = this.pathFor(sessionId);
    if (!filePath.ok) return filePath;
    if (input.originalPrompt.trim().length === 0) return ok({ kind: "ignored-empty" });
    try {
      const outcome = await this.enqueueOperation(filePath.value, () => this.commitFromSnapshot<SummaryReservationOutcome>(
        filePath.value,
        sessionId,
        session => decideSummaryReservation(session, input)
      ));
      return ok(outcome);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return err(toSessionError(error));
    }
  }

  async commitLedgerEvent(
    sessionId: string,
    input: LedgerCommitEvent,
    isCurrent: SessionWriteGuard = () => true
  ): Promise<Result<SessionLedgerCommitOutcome>> {
    const filePath = this.pathFor(sessionId);
    if (!filePath.ok) return filePath;
    try {
      const event = parseSessionLedgerEvent(input);
      if (event.type === "summary_reserved") throw sessionError("Summary reservation requires reserveFirstSummary");
      const outcome = await this.enqueueOperation(filePath.value, () => this.commitFromSnapshot<SessionLedgerCommitOutcome>(
        filePath.value,
        sessionId,
        session => decideLedgerCommit(session, event),
        isCurrent,
        { kind: "rejected", reason: "stale" }
      ));
      return ok(outcome);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return err(toSessionError(error));
    }
  }

  async read(sessionId: string): Promise<Result<Session>> {
    const filePath = this.pathFor(sessionId);
    if (!filePath.ok) return filePath;
    try {
      const source = await this.enqueueOperation(filePath.value, () => this.io.read(filePath.value));
      if (source === undefined) return err(sessionError(`Session not found: ${sessionId}`));
      return ok(parseSessionJsonl(sessionId, source));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return err(toSessionError(error));
    }
  }

  async readOrEmpty(sessionId: string): Promise<Result<Session>> {
    const filePath = this.pathFor(sessionId);
    if (!filePath.ok) return filePath;
    try {
      const source = await this.enqueueOperation(filePath.value, () => this.io.read(filePath.value));
      return source === undefined
        ? ok({ id: sessionId, events: [] })
        : ok(parseSessionJsonl(sessionId, source));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (isMissing(error)) return ok({ id: sessionId, events: [] });
      return err(toSessionError(error));
    }
  }

  async readForCompaction(sessionId: string): Promise<Result<CompactionSessionSnapshot>> {
    const filePath = this.pathFor(sessionId);
    if (!filePath.ok) return filePath;
    try {
      return ok(await this.enqueueOperation(
        filePath.value,
        () => this.checkpoints.readSnapshot(filePath.value, sessionId)
      ));
    } catch (error) {
      return err(toSessionError(error instanceof Error ? error : String(error)));
    }
  }

  async commitCompactionCheckpoint(
    sessionId: string,
    expectedRevision: SessionRevision,
    checkpoint: CompactionCheckpointSessionEvent
  ): Promise<Result<void>> {
    const filePath = this.pathFor(sessionId);
    if (!filePath.ok) return filePath;
    try {
      await this.enqueueOperation(
        filePath.value,
        () => this.checkpoints.commit(filePath.value, expectedRevision, checkpoint)
      );
      return ok(undefined);
    } catch (error) {
      return err(toSessionError(error instanceof Error ? error : String(error)));
    }
  }

  async list(): Promise<Result<string[]>> {
    try {
      return ok(await listSessionIds(this.security, this.sessionsDir));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return err(toSessionError(error));
    }
  }

  private async enqueueOperation<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    const queueKey = process.platform === "win32" ? filePath.toLowerCase() : filePath;
    const previous = SessionStore.writeQueues.get(queueKey) ?? Promise.resolve();
    const current = previous.then(operation);
    const gate = current.then(() => undefined, () => undefined);
    SessionStore.writeQueues.set(queueKey, gate);
    try {
      return await current;
    } finally {
      if (SessionStore.writeQueues.get(queueKey) === gate) SessionStore.writeQueues.delete(queueKey);
    }
  }

  private async commitFromSnapshot<T>(filePath: string, sessionId: string,
    decide: (session: Session) => SnapshotDecision<T>,
    writeGuard?: SessionWriteGuard,
    writeRejected?: T
  ): Promise<T> {
    const source = await this.io.read(filePath);
    const session = source === undefined
      ? { id: sessionId, events: [] }
      : parseSessionJsonl(sessionId, source);
    const decision = decide(session);
    if (decision.event !== undefined) {
      const written = await this.io.append(filePath, `${JSON.stringify(decision.event)}\n`, writeGuard);
      if (written.kind === "rejected") {
        if (writeRejected === undefined) throw sessionError("Session write guard rejected without an outcome");
        return writeRejected;
      }
    }
    return decision.outcome;
  }

}
