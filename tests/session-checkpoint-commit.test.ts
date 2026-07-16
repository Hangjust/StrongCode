import {
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import type { Result } from "../src/core/result";
import type {
  CheckpointCommitFaultInjector,
  CheckpointCommitFaultStage,
  CompactionSessionSnapshot
} from "../src/sessions/compaction-checkpoint-store";
import { SessionStore } from "../src/sessions/session-store";
import {
  compactionCheckpointEvent,
  messageEvent,
  type CompactionCheckpointSessionEvent
} from "../src/sessions/session";
import { COMPACTION_SUMMARY_PREFIX } from "../src/sessions/compaction";
import { tempWorkspace } from "./helpers";

const ORIGINAL_EVENT = {
  type: "message",
  timestamp: "2026-07-14T00:00:00.000Z",
  role: "user",
  content: "alpha"
} as const;

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>(resolve => {
    resolvePromise = resolve;
  });
  if (resolvePromise === undefined) throw new Error("Deferred resolver was not initialized");
  return { promise, resolve: resolvePromise };
}

function valueOf<T>(result: Result<T>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

function checkpoint(body = "Continue from this exact state."): CompactionCheckpointSessionEvent {
  const summary = `${COMPACTION_SUMMARY_PREFIX}\n${body}`;
  return compactionCheckpointEvent("newton", summary, [
    { type: "text", role: "user", content: summary }
  ]);
}

function expectedBytes(source: Buffer, event: CompactionCheckpointSessionEvent): Buffer {
  const separator = source.length > 0 && source.at(-1) !== 0x0a ? "\n" : "";
  return Buffer.concat([source, Buffer.from(`${separator}${JSON.stringify(event)}\n`, "utf8")]);
}

async function sessionPath(dataDir: string, sessionId = "checkpoint"): Promise<string> {
  return path.join(dataDir, "sessions", `${sessionId}.jsonl`);
}

async function tempNames(dataDir: string): Promise<readonly string[]> {
  try {
    return (await readdir(path.join(dataDir, "sessions"))).filter(name => name.endsWith(".tmp"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function snapshotFor(source: Buffer): Promise<{
  readonly dataDir: string;
  readonly filePath: string;
  readonly snapshot: CompactionSessionSnapshot;
}> {
  const workspace = await tempWorkspace();
  const dataDir = path.join(workspace.root, ".strongcode");
  const filePath = await sessionPath(dataDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, source);
  const snapshot = valueOf(await new SessionStore(dataDir).readForCompaction("checkpoint"));
  return { dataDir, filePath, snapshot };
}

async function createLink(target: string, linkPath: string, type: "dir" | "file"): Promise<boolean> {
  try {
    await symlink(target, linkPath, process.platform === "win32" && type === "dir" ? "junction" : type);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "ENOTSUP")) return false;
    throw error;
  }
}

describe("compaction checkpoint snapshots", () => {
  it("returns an absent revision and empty session without creating directories", async () => {
    // Given
    const workspace = await tempWorkspace();
    const dataDir = path.join(workspace.root, ".strongcode");
    const store = new SessionStore(dataDir);

    // When
    const snapshot = valueOf(await store.readForCompaction("missing"));

    // Then
    expect(snapshot.session).toEqual({ id: "missing", events: [] });
    await expect(lstat(dataDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("distinguishes a missing revision from a present empty file", async () => {
    // Given
    const workspace = await tempWorkspace();
    const dataDir = path.join(workspace.root, ".strongcode");
    const store = new SessionStore(dataDir);
    const missing = valueOf(await store.readForCompaction("state"));
    const filePath = await sessionPath(dataDir, "state");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, Buffer.alloc(0));

    // When
    const stale = await store.commitCompactionCheckpoint("state", missing.revision, checkpoint());
    const empty = valueOf(await store.readForCompaction("state"));
    const committed = await store.commitCompactionCheckpoint("state", empty.revision, checkpoint("Empty file state."));

    // Then
    expect(stale.ok).toBe(false);
    expect(committed.ok).toBe(true);
  });

  it("changes revision when one exact source byte changes", async () => {
    // Given
    const original = Buffer.from(`${JSON.stringify(ORIGINAL_EVENT)}\n`, "utf8");
    const fixture = await snapshotFor(original);
    const changed = Buffer.from(original.toString("utf8").replace("alpha", "bravo"), "utf8");
    await writeFile(fixture.filePath, changed);

    // When
    const result = await new SessionStore(fixture.dataDir).commitCompactionCheckpoint(
      "checkpoint",
      fixture.snapshot.revision,
      checkpoint()
    );

    // Then
    expect(result.ok).toBe(false);
    expect(await readFile(fixture.filePath)).toEqual(changed);
  });

  it("rejects a revision made stale by an external append", async () => {
    // Given
    const workspace = await tempWorkspace();
    const dataDir = path.join(workspace.root, ".strongcode");
    const reader = new SessionStore(dataDir);
    const writer = new SessionStore(dataDir);
    valueOf(await writer.append("stale", messageEvent("user", "original")));
    const snapshot = valueOf(await reader.readForCompaction("stale"));
    valueOf(await writer.append("stale", messageEvent("assistant", "external append")));
    const before = await readFile(await sessionPath(dataDir, "stale"));

    // When
    const result = await reader.commitCompactionCheckpoint("stale", snapshot.revision, checkpoint());

    // Then
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("Session changed during compaction");
    expect(await readFile(await sessionPath(dataDir, "stale"))).toEqual(before);
  });

  it("allows exactly one of two commits that share a revision", async () => {
    // Given
    const fixture = await snapshotFor(Buffer.from(`${JSON.stringify(ORIGINAL_EVENT)}\n`, "utf8"));
    const first = new SessionStore(fixture.dataDir);
    const second = new SessionStore(fixture.dataDir);

    // When
    const results = await Promise.all([
      first.commitCompactionCheckpoint("checkpoint", fixture.snapshot.revision, checkpoint("First.")),
      second.commitCompactionCheckpoint("checkpoint", fixture.snapshot.revision, checkpoint("Second."))
    ]);

    // Then
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toHaveLength(1);
    expect((await readFile(fixture.filePath, "utf8")).match(/compaction_checkpoint/g)).toHaveLength(1);
  });
});

describe("atomic compaction checkpoint publication", () => {
  it.each([
    { label: "missing", source: undefined },
    { label: "empty", source: Buffer.alloc(0) },
    { label: "without final LF", source: Buffer.from(JSON.stringify(ORIGINAL_EVENT), "utf8") },
    { label: "with final LF", source: Buffer.from(`${JSON.stringify(ORIGINAL_EVENT)}\n`, "utf8") }
  ] satisfies readonly { readonly label: string; readonly source: Buffer | undefined }[])(
    "publishes exact expected bytes for a $label source",
    async ({ source }) => {
      // Given
      const workspace = await tempWorkspace();
      const dataDir = path.join(workspace.root, ".strongcode");
      const filePath = await sessionPath(dataDir);
      if (source !== undefined) {
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, source);
      }
      const store = new SessionStore(dataDir);
      const snapshot = valueOf(await store.readForCompaction("checkpoint"));
      const event = checkpoint();

      // When
      const result = await store.commitCompactionCheckpoint("checkpoint", snapshot.revision, event);

      // Then
      expect(result.ok).toBe(true);
      expect(await readFile(filePath)).toEqual(expectedBytes(source ?? Buffer.alloc(0), event));
      expect(await tempNames(dataDir)).toEqual([]);
    }
  );

  it.each([
    "before_temp_create",
    "after_source_write",
    "after_checkpoint_write",
    "after_temp_sync",
    "before_target_revalidation",
    "before_rename"
  ] satisfies readonly CheckpointCommitFaultStage[])(
    "preserves exact original bytes when $stage fails before publication",
    async stage => {
      // Given
      const original = Buffer.from(`${JSON.stringify(ORIGINAL_EVENT)}\n`, "utf8");
      const fixture = await snapshotFor(original);
      const fault = new Error(`fault:${stage}`);
      const store = new SessionStore(fixture.dataDir, {
        checkpointCommitFault: injectedStage => {
          if (injectedStage === stage) throw fault;
        }
      });

      // When
      const result = await store.commitCompactionCheckpoint(
        "checkpoint",
        fixture.snapshot.revision,
        checkpoint()
      );

      // Then
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toBe(fault.message);
      expect(await readFile(fixture.filePath)).toEqual(original);
      expect(await tempNames(fixture.dataDir)).toEqual([]);
    }
  );

  it("returns success when rename takes effect before an injected ambiguous failure", async () => {
    // Given
    const original = Buffer.from(`${JSON.stringify(ORIGINAL_EVENT)}\n`, "utf8");
    const fixture = await snapshotFor(original);
    const event = checkpoint();
    const store = new SessionStore(fixture.dataDir, {
      checkpointCommitFault: stage => {
        if (stage === "rename_after_effect") throw new Error("rename result was ambiguous");
      }
    });

    // When
    const result = await store.commitCompactionCheckpoint("checkpoint", fixture.snapshot.revision, event);

    // Then
    expect(result.ok).toBe(true);
    expect(await readFile(fixture.filePath)).toEqual(expectedBytes(original, event));
    expect(await tempNames(fixture.dataDir)).toEqual([]);
  });

  it("returns an error with original bytes when an ambiguous rename is confirmed uncommitted", async () => {
    // Given
    const original = Buffer.from(`${JSON.stringify(ORIGINAL_EVENT)}\n`, "utf8");
    const fixture = await snapshotFor(original);
    const store = new SessionStore(fixture.dataDir, {
      checkpointCommitFault: async stage => {
        if (stage !== "rename_after_effect") return;
        await writeFile(fixture.filePath, original);
        throw new Error("rename result was ambiguous");
      }
    });

    // When
    const result = await store.commitCompactionCheckpoint("checkpoint", fixture.snapshot.revision, checkpoint());

    // Then
    expect(result.ok).toBe(false);
    expect(await readFile(fixture.filePath)).toEqual(original);
  });

  it("reports an unknown outcome without unlinking an uninspectable target", async () => {
    // Given
    const original = Buffer.from(`${JSON.stringify(ORIGINAL_EVENT)}\n`, "utf8");
    const fixture = await snapshotFor(original);
    const store = new SessionStore(fixture.dataDir, {
      checkpointCommitFault: async stage => {
        if (stage !== "rename_after_effect") return;
        await unlink(fixture.filePath);
        await mkdir(fixture.filePath);
        throw new Error("rename result was ambiguous");
      }
    });

    // When
    const result = await store.commitCompactionCheckpoint("checkpoint", fixture.snapshot.revision, checkpoint());

    // Then
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("outcome is unknown");
    expect((await lstat(fixture.filePath)).isDirectory()).toBe(true);
  });

  it.skipIf(process.platform === "win32").each([
    "before_directory_sync",
    "after_directory_sync"
  ] satisfies readonly CheckpointCommitFaultStage[])(
    "keeps a confirmed commit successful when $stage fails",
    async stage => {
      // Given
      const original = Buffer.from(`${JSON.stringify(ORIGINAL_EVENT)}\n`, "utf8");
      const fixture = await snapshotFor(original);
      const event = checkpoint();
      const store = new SessionStore(fixture.dataDir, {
        checkpointCommitFault: injectedStage => {
          if (injectedStage === stage) throw new Error(`fault:${stage}`);
        }
      });

      // When
      const result = await store.commitCompactionCheckpoint("checkpoint", fixture.snapshot.revision, event);

      // Then
      expect(result.ok).toBe(true);
      expect(await readFile(fixture.filePath)).toEqual(expectedBytes(original, event));
    }
  );

  it("does not let a cleanup fault mask the primary pre-commit failure", async () => {
    // Given
    const original = Buffer.from(`${JSON.stringify(ORIGINAL_EVENT)}\n`, "utf8");
    const fixture = await snapshotFor(original);
    const injector: CheckpointCommitFaultInjector = stage => {
      if (stage === "after_source_write") throw new Error("primary write failure");
      if (stage === "before_temp_cleanup") throw new Error("secondary cleanup failure");
    };
    const store = new SessionStore(fixture.dataDir, { checkpointCommitFault: injector });

    // When
    const result = await store.commitCompactionCheckpoint("checkpoint", fixture.snapshot.revision, checkpoint());

    // Then
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("primary write failure");
    expect(await readFile(fixture.filePath)).toEqual(original);
  });

  it("does not turn a confirmed commit into an error when post-commit cleanup faults", async () => {
    // Given
    const original = Buffer.from(`${JSON.stringify(ORIGINAL_EVENT)}\n`, "utf8");
    const fixture = await snapshotFor(original);
    const event = checkpoint();
    const store = new SessionStore(fixture.dataDir, {
      checkpointCommitFault: stage => {
        if (stage === "before_temp_cleanup") throw new Error("post-commit cleanup fault");
      }
    });

    // When
    const result = await store.commitCompactionCheckpoint("checkpoint", fixture.snapshot.revision, event);

    // Then
    expect(result.ok).toBe(true);
    expect(await readFile(fixture.filePath)).toEqual(expectedBytes(original, event));
  });

  it("resolves an injected non-Error value to a SESSION_ERROR Result", async () => {
    // Given
    const fixture = await snapshotFor(Buffer.alloc(0));
    const store = new SessionStore(fixture.dataDir, {
      checkpointCommitFault: stage => {
        if (stage === "before_temp_create") return Promise.reject("non-error fault");
      }
    });

    // When
    const result = await store.commitCompactionCheckpoint("checkpoint", fixture.snapshot.revision, checkpoint());

    // Then
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SESSION_ERROR");
      expect(result.error.message).toBe("non-error fault");
    }
  });

  it.skipIf(process.platform === "win32")("creates private directories, target, and temp file", async () => {
    // Given
    const workspace = await tempWorkspace();
    const dataDir = path.join(workspace.root, ".strongcode");
    const observedModes: number[] = [];
    const store = new SessionStore(dataDir, {
      checkpointCommitFault: async stage => {
        if (stage !== "before_rename") return;
        for (const name of await tempNames(dataDir)) {
          observedModes.push((await stat(path.join(dataDir, "sessions", name))).mode & 0o777);
        }
      }
    });
    const snapshot = valueOf(await store.readForCompaction("checkpoint"));

    // When
    const result = await store.commitCompactionCheckpoint("checkpoint", snapshot.revision, checkpoint());

    // Then
    expect(result.ok).toBe(true);
    expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(dataDir, "sessions"))).mode & 0o777).toBe(0o700);
    expect((await stat(await sessionPath(dataDir))).mode & 0o777).toBe(0o600);
    expect(observedModes).toEqual([0o600]);
  });

  it("uses a random exclusive temp name in the target directory", async () => {
    // Given
    const fixture = await snapshotFor(Buffer.alloc(0));
    const observedNames: string[] = [];
    const store = new SessionStore(fixture.dataDir, {
      checkpointCommitFault: async stage => {
        if (stage === "before_rename") observedNames.push(...await tempNames(fixture.dataDir));
      }
    });

    // When
    const result = await store.commitCompactionCheckpoint("checkpoint", fixture.snapshot.revision, checkpoint());

    // Then
    expect(result.ok).toBe(true);
    expect(observedNames).toHaveLength(1);
    expect(observedNames[0]).toMatch(/^\.checkpoint\.jsonl\.\d+\.[0-9a-f]{32}\.tmp$/);
  });

  it("holds the shared store queue until publication completes", async () => {
    // Given
    const original = Buffer.from(`${JSON.stringify(ORIGINAL_EVENT)}\n`, "utf8");
    const fixture = await snapshotFor(original);
    const atRename = deferred<void>();
    const releaseRename = deferred<void>();
    const committingStore = new SessionStore(fixture.dataDir, {
      checkpointCommitFault: async stage => {
        if (stage !== "before_rename") return;
        atRename.resolve(undefined);
        await releaseRename.promise;
      }
    });
    const appendingStore = new SessionStore(fixture.dataDir);
    const event = checkpoint();
    const commit = committingStore.commitCompactionCheckpoint("checkpoint", fixture.snapshot.revision, event);
    await atRename.promise;
    let appendSettled = false;
    const append = appendingStore.append("checkpoint", messageEvent("assistant", "after checkpoint")).then(result => {
      appendSettled = true;
      return result;
    });
    await Promise.resolve();

    // When
    expect(appendSettled).toBe(false);
    releaseRename.resolve(undefined);
    const [commitResult, appendResult] = await Promise.all([commit, append]);

    // Then
    expect(commitResult.ok).toBe(true);
    expect(appendResult.ok).toBe(true);
    const expected = Buffer.concat([
      expectedBytes(original, event),
      Buffer.from(`${JSON.stringify(messageEvent("assistant", "after checkpoint"))}\n`, "utf8")
    ]);
    const actual = await readFile(fixture.filePath, "utf8");
    expect(actual.split("\n").filter(Boolean).map(line => JSON.parse(line).type)).toEqual([
      "message",
      "compaction_checkpoint",
      "message"
    ]);
    expect(Buffer.byteLength(actual)).toBe(expected.length);
  });
});

describe("checkpoint target identity defenses", () => {
  it("rejects a symlink target without changing its external file", async () => {
    // Given
    const original = Buffer.from(`${JSON.stringify(ORIGINAL_EVENT)}\n`, "utf8");
    const fixture = await snapshotFor(original);
    const external = path.join(path.dirname(fixture.dataDir), "external.jsonl");
    await writeFile(external, "preserve", "utf8");
    let linkSupported = true;
    const store = new SessionStore(fixture.dataDir, {
      checkpointCommitFault: async stage => {
        if (stage !== "before_target_revalidation") return;
        await unlink(fixture.filePath);
        linkSupported = await createLink(external, fixture.filePath, "file");
      }
    });

    // When
    const result = await store.commitCompactionCheckpoint("checkpoint", fixture.snapshot.revision, checkpoint());

    // Then
    if (!linkSupported) return;
    expect(result.ok).toBe(false);
    expect(await readFile(external, "utf8")).toBe("preserve");
  });

  it("rejects a hard-linked target without changing its external file", async () => {
    // Given
    const original = Buffer.from(`${JSON.stringify(ORIGINAL_EVENT)}\n`, "utf8");
    const fixture = await snapshotFor(original);
    const external = path.join(path.dirname(fixture.dataDir), "external.jsonl");
    await writeFile(external, "preserve", "utf8");
    const store = new SessionStore(fixture.dataDir, {
      checkpointCommitFault: async stage => {
        if (stage !== "before_target_revalidation") return;
        await unlink(fixture.filePath);
        await link(external, fixture.filePath);
      }
    });

    // When
    const result = await store.commitCompactionCheckpoint("checkpoint", fixture.snapshot.revision, checkpoint());

    // Then
    expect(result.ok).toBe(false);
    expect(await readFile(external, "utf8")).toBe("preserve");
  });

  it("rejects a non-regular target", async () => {
    // Given
    const original = Buffer.from(`${JSON.stringify(ORIGINAL_EVENT)}\n`, "utf8");
    const fixture = await snapshotFor(original);
    const store = new SessionStore(fixture.dataDir, {
      checkpointCommitFault: async stage => {
        if (stage !== "before_target_revalidation") return;
        await unlink(fixture.filePath);
        await mkdir(fixture.filePath);
      }
    });

    // When
    const result = await store.commitCompactionCheckpoint("checkpoint", fixture.snapshot.revision, checkpoint());

    // Then
    expect(result.ok).toBe(false);
  });

  it("rejects target identity replacement even when exact bytes are restored", async () => {
    // Given
    const original = Buffer.from(`${JSON.stringify(ORIGINAL_EVENT)}\n`, "utf8");
    const fixture = await snapshotFor(original);
    const store = new SessionStore(fixture.dataDir, {
      checkpointCommitFault: async stage => {
        if (stage !== "before_target_revalidation") return;
        await unlink(fixture.filePath);
        await writeFile(fixture.filePath, original);
      }
    });

    // When
    const result = await store.commitCompactionCheckpoint("checkpoint", fixture.snapshot.revision, checkpoint());

    // Then
    expect(result.ok).toBe(false);
    expect(await readFile(fixture.filePath)).toEqual(original);
  });

  it("rejects session-directory identity replacement", async () => {
    // Given
    const original = Buffer.from(`${JSON.stringify(ORIGINAL_EVENT)}\n`, "utf8");
    const fixture = await snapshotFor(original);
    const sessionsDir = path.dirname(fixture.filePath);
    const movedDir = `${sessionsDir}-moved`;
    const store = new SessionStore(fixture.dataDir, {
      checkpointCommitFault: async stage => {
        if (stage !== "before_target_revalidation") return;
        await rename(sessionsDir, movedDir);
        await mkdir(sessionsDir);
      }
    });

    // When
    const result = await store.commitCompactionCheckpoint("checkpoint", fixture.snapshot.revision, checkpoint());

    // Then
    expect(result.ok).toBe(false);
    expect(await readFile(path.join(movedDir, "checkpoint.jsonl"))).toEqual(original);
    await rm(movedDir, { recursive: true, force: true });
  });

  it.runIf(process.platform === "win32")("replaces the target after all source and temp handles close", async () => {
    // Given
    const original = Buffer.from(`${JSON.stringify(ORIGINAL_EVENT)}\n`, "utf8");
    const fixture = await snapshotFor(original);
    const event = checkpoint();

    // When
    const result = await new SessionStore(fixture.dataDir).commitCompactionCheckpoint(
      "checkpoint",
      fixture.snapshot.revision,
      event
    );

    // Then
    expect(result.ok).toBe(true);
    expect(await readFile(fixture.filePath)).toEqual(expectedBytes(original, event));
  });
});
