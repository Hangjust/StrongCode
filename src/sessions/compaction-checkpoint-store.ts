import { createHash } from "node:crypto";
import { open, rename } from "node:fs/promises";
import type { Session } from "./session";
import type { CompactionCheckpointSessionEvent } from "./compaction-checkpoint";
import { parseSessionJsonl } from "./session-jsonl";
import {
  identitiesMatch,
  type OwnedSessionTempFile,
  type SecuredSessionFile,
  type SessionFileSecurity,
  sessionError,
  type StoreDirectoryStats
} from "./session-file-security";

const sessionRevisionState: unique symbol = Symbol("SessionRevision");
const MAX_TEMP_CREATE_ATTEMPTS = 3;

type RevisionState = Readonly<{
  existence: "absent" | "present";
  byteLength: number;
  sha256: string;
}>;

export type SessionRevision = Readonly<{
  readonly [sessionRevisionState]: RevisionState;
}>;

export interface CompactionSessionSnapshot {
  readonly session: Session;
  readonly revision: SessionRevision;
}

export type CheckpointCommitFaultStage =
  | "before_temp_create"
  | "after_source_write"
  | "after_checkpoint_write"
  | "after_temp_sync"
  | "before_target_revalidation"
  | "before_rename"
  | "rename_after_effect"
  | "before_directory_sync"
  | "after_directory_sync"
  | "before_temp_cleanup";

export type CheckpointCommitFaultInjector = (
  stage: CheckpointCommitFaultStage
) => void | Promise<void>;

type CompactionCheckpointStoreOptions = {
  readonly security: SessionFileSecurity;
  readonly fault?: CheckpointCommitFaultInjector;
};

type CheckpointPublication = {
  readonly filePath: string;
  readonly directories: StoreDirectoryStats;
  readonly original: SecuredSessionFile | undefined;
  readonly expectedRevision: SessionRevision;
  readonly expectedBytes: Buffer;
};

function revisionFor(source: Buffer | undefined): SessionRevision {
  const bytes = source ?? Buffer.alloc(0);
  return Object.freeze({
    [sessionRevisionState]: Object.freeze({
      existence: source === undefined ? "absent" : "present",
      byteLength: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    })
  });
}

function revisionsMatch(left: SessionRevision, right: SessionRevision): boolean {
  const leftState = left[sessionRevisionState];
  const rightState = right[sessionRevisionState];
  return leftState.existence === rightState.existence
    && leftState.byteLength === rightState.byteLength
    && leftState.sha256 === rightState.sha256;
}

export class CompactionCheckpointStore {
  private readonly security: SessionFileSecurity;
  private readonly fault: CheckpointCommitFaultInjector | undefined;

  constructor(options: CompactionCheckpointStoreOptions) {
    this.security = options.security;
    this.fault = options.fault;
  }

  async readSnapshot(filePath: string, sessionId: string): Promise<CompactionSessionSnapshot> {
    const directories = await this.security.storeDirectoryStatsForRead();
    if (directories === undefined) {
      return { session: { id: sessionId, events: [] }, revision: revisionFor(undefined) };
    }
    const source = await this.security.readSecuredFile(filePath, directories);
    if (source === undefined) {
      return { session: { id: sessionId, events: [] }, revision: revisionFor(undefined) };
    }
    return { session: parseSessionJsonl(sessionId, source.bytes.toString("utf8")), revision: revisionFor(source.bytes) };
  }

  async commit(
    filePath: string,
    expectedRevision: SessionRevision,
    checkpoint: CompactionCheckpointSessionEvent
  ): Promise<void> {
    const directories = await this.security.prepareStoreForWrite();
    const original = await this.security.readSecuredFile(filePath, directories);
    if (!revisionsMatch(revisionFor(original?.bytes), expectedRevision)) {
      throw sessionError("Session changed during compaction; run /compact again");
    }

    const sourceBytes = original?.bytes ?? Buffer.alloc(0);
    const separator = sourceBytes.length > 0 && sourceBytes.at(-1) !== 0x0a ? "\n" : "";
    const checkpointBytes = Buffer.from(`${separator}${JSON.stringify(checkpoint)}\n`, "utf8");
    const expectedBytes = Buffer.concat([sourceBytes, checkpointBytes]);
    const publication: CheckpointPublication = {
      filePath,
      directories,
      original,
      expectedRevision,
      expectedBytes
    };
    await this.inject("before_temp_create");

    let temp: OwnedSessionTempFile | undefined;
    let tempHandleOpen = false;
    let tempMayExist = false;
    let committed = false;
    let primaryError: unknown;
    let cleanupError: unknown;
    try {
      temp = await this.security.createExclusiveTemp(filePath, directories, MAX_TEMP_CREATE_ATTEMPTS);
      tempHandleOpen = true;
      tempMayExist = true;
      await temp.handle.writeFile(sourceBytes);
      await this.inject("after_source_write");
      await temp.handle.writeFile(checkpointBytes);
      await this.inject("after_checkpoint_write");
      await temp.handle.sync();
      await this.inject("after_temp_sync");
      await temp.handle.close();
      tempHandleOpen = false;

      await this.inject("before_target_revalidation");
      this.security.assertDirectoryIdentities(directories, await this.security.assertStoreDirectories());
      const current = await this.security.readSecuredFile(filePath, directories);
      this.assertUnchangedTarget(publication, current);
      await this.inject("before_rename");

      try {
        await rename(temp.path, filePath);
        tempMayExist = false;
        await this.inject("rename_after_effect");
        committed = true;
      } catch (error) {
        const outcome = await this.reconcileRename(publication);
        if (outcome === "committed") committed = true;
        else if (outcome === "original") throw error;
        else throw sessionError(`Checkpoint publication outcome is unknown: ${error instanceof Error ? error.message : String(error)}`);
      }

      await this.syncDirectoryAfterCommit();
    } catch (error) {
      primaryError = error instanceof Error ? error : sessionError(String(error));
    } finally {
      if (temp !== undefined && tempHandleOpen) {
        try {
          await temp.handle.close();
        } catch (error) {
          cleanupError = error instanceof Error ? error : sessionError(String(error));
        }
      }
      if (temp !== undefined) {
        try {
          await this.inject("before_temp_cleanup");
          if (tempMayExist) await this.security.removeOwnedTemp(temp);
        } catch (error) {
          cleanupError = error instanceof Error ? error : sessionError(String(error));
        }
      }
    }

    if (committed) return;
    if (primaryError !== undefined) throw primaryError;
    if (cleanupError !== undefined) throw cleanupError;
    throw sessionError("Checkpoint publication failed before commit");
  }

  private assertUnchangedTarget(
    publication: CheckpointPublication,
    current: SecuredSessionFile | undefined
  ): void {
    if (!revisionsMatch(revisionFor(current?.bytes), publication.expectedRevision)) {
      throw sessionError("Session changed during compaction; run /compact again");
    }
    if (publication.original !== undefined
      && current !== undefined
      && !identitiesMatch(publication.original.stats, current.stats)) {
      throw sessionError(`Session record changed before checkpoint publication: ${publication.filePath}`);
    }
  }

  private async reconcileRename(publication: CheckpointPublication): Promise<"committed" | "original" | "unknown"> {
    try {
      const current = await this.security.readSecuredFile(publication.filePath, publication.directories);
      if (current?.bytes.equals(publication.expectedBytes)) return "committed";
      if (current === undefined && publication.original === undefined) return "original";
      if (current !== undefined
        && publication.original !== undefined
        && current.bytes.equals(publication.original.bytes)) return "original";
      return "unknown";
    } catch (error) {
      if (error instanceof Error) return "unknown";
      return "unknown";
    }
  }

  private async syncDirectoryAfterCommit(): Promise<void> {
    if (process.platform === "win32") return;
    try {
      await this.inject("before_directory_sync");
      const handle = await open(this.security.sessionsDir, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.inject("after_directory_sync");
    } catch (error) {
      if (error instanceof Error) return;
      return;
    }
  }

  private async inject(stage: CheckpointCommitFaultStage): Promise<void> {
    await this.fault?.(stage);
  }
}
