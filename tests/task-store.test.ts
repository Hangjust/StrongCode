import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { StrongCodeError } from "../src/core/errors";
import { TaskStore } from "../src/tasks/task-store";
import type { TaskRecord } from "../src/tasks/types";
import { tempWorkspace } from "./helpers";

const TASK_ID = "task-123e4567-e89b-42d3-a456-426614174000";
const CREATED_AT = "2026-07-14T12:00:00.000Z";

function taskRecord(status: TaskRecord["status"] = "running", id = TASK_ID): TaskRecord {
  return {
    id,
    childSessionId: "child-session",
    parentSessionId: "parent-session",
    rootSessionId: "root-session",
    target: { class: "helper", id: "explore" },
    attempt: 1,
    depth: 1,
    mode: "background",
    model: "mock",
    effectivePolicyHash: "a".repeat(64),
    skillReceipts: [{ id: "repository-map", path: "skills/repository-map/SKILL.md", hash: "b".repeat(64) }],
    ownedPaths: ["src/tasks"],
    timestamps: {
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      startedAt: CREATED_AT,
      ...(status === "succeeded" ? { completedAt: "2026-07-14T12:01:00.000Z" } : {})
    },
    status,
    ...(status === "succeeded" ? {
      resultMetadata: { summary: "Task completed", outputChars: 14, truncated: false },
      artifactPointer: "artifacts/task-result.txt"
    } : {})
  };
}

describe("task store", () => {
  it("round-trips a validated task record and lists it", async () => {
    // Given
    const workspace = await tempWorkspace();
    const store = new TaskStore(path.join(workspace.root, ".strongcode"));
    const record = taskRecord("succeeded");

    // When
    const written = await store.write(record);
    const read = await store.read(TASK_ID);
    const listed = await store.list();

    // Then
    expect(written.ok).toBe(true);
    expect(read).toEqual({ ok: true, value: record });
    expect(listed).toEqual({ ok: true, value: [record] });
  });

  it("rejects unsafe task IDs before constructing a path", async () => {
    // Given
    const workspace = await tempWorkspace();
    const store = new TaskStore(path.join(workspace.root, ".strongcode"));

    // When
    const result = await store.read("task-../../outside");

    // Then
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TASK_ERROR");
  });

  it("returns TASK_ERROR for corrupt persisted JSON", async () => {
    // Given
    const workspace = await tempWorkspace();
    const tasksDir = path.join(workspace.root, ".strongcode", "tasks");
    await mkdir(tasksDir, { recursive: true });
    await writeFile(path.join(tasksDir, `${TASK_ID}.json`), "{not-json", "utf8");

    // When
    const result = await new TaskStore(path.join(workspace.root, ".strongcode")).read(TASK_ID);

    // Then
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(StrongCodeError);
      expect(result.error.code).toBe("TASK_ERROR");
    }
  });

  it("rejects a symlinked tasks directory without writing outside dataDir", async () => {
    // Given
    const workspace = await tempWorkspace();
    const dataDir = path.join(workspace.root, ".strongcode");
    const externalDir = path.join(workspace.root, "external");
    const tasksDir = path.join(dataDir, "tasks");
    await mkdir(dataDir, { recursive: true });
    await mkdir(externalDir);
    await writeFile(path.join(externalDir, "sentinel.txt"), "preserve", "utf8");
    try {
      await symlink(externalDir, tasksDir, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error.code === "EPERM" || error.code === "ENOTSUP")) return;
      throw error;
    }

    // When
    const result = await new TaskStore(dataDir).write(taskRecord("succeeded"));

    // Then
    expect(result.ok).toBe(false);
    expect(await readFile(path.join(externalDir, "sentinel.txt"), "utf8")).toBe("preserve");
    await expect(readFile(path.join(externalDir, `${TASK_ID}.json`), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("atomically replaces an existing task record without leaving temp files", async () => {
    // Given
    const workspace = await tempWorkspace();
    const dataDir = path.join(workspace.root, ".strongcode");
    const store = new TaskStore(dataDir);
    await store.write(taskRecord("running"));

    // When
    const result = await store.write(taskRecord("succeeded"));

    // Then
    expect(result.ok).toBe(true);
    const persisted = JSON.parse(await readFile(path.join(dataDir, "tasks", `${TASK_ID}.json`), "utf8"));
    expect(persisted.status).toBe("succeeded");
    expect(await readdir(path.join(dataDir, "tasks"))).toEqual([`${TASK_ID}.json`]);
  });

  it("rejects a schema-valid oversized record before replacing the prior record", async () => {
    // Given
    const workspace = await tempWorkspace();
    const dataDir = path.join(workspace.root, ".strongcode");
    const tasksDir = path.join(dataDir, "tasks");
    const filePath = path.join(tasksDir, `${TASK_ID}.json`);
    const store = new TaskStore(dataDir);
    const previous = taskRecord("succeeded");
    await store.write(previous);
    const previousBytes = await readFile(filePath);
    const oversized = {
      ...taskRecord("running"),
      childSessionId: "a",
      parentSessionId: "a",
      rootSessionId: "a",
      target: { class: "helper", id: "a" },
      model: "m",
      skillReceipts: [{ id: "r", path: "xxxx/SKILL.md", hash: "b".repeat(64) }],
      ownedPaths: Array.from({ length: 256 }, () => "x".repeat(4_096))
    } satisfies TaskRecord;
    expect(Buffer.byteLength(`${JSON.stringify(oversized, null, 2)}\n`, "utf8")).toBe(1_051_343);

    // When
    const result = await store.write(oversized);

    // Then
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TASK_ERROR");
    expect(await readFile(filePath)).toEqual(previousBytes);
    expect(await store.read(TASK_ID)).toEqual({ ok: true, value: previous });
    expect(await readdir(tasksDir)).toEqual([`${TASK_ID}.json`]);
  });

  it("reconciles every nonterminal task to interrupted without model execution", async () => {
    // Given
    const workspace = await tempWorkspace();
    const dataDir = path.join(workspace.root, ".strongcode");
    const initialStore = new TaskStore(dataDir);
    await Promise.all([
      initialStore.write(taskRecord("queued", "task-123e4567-e89b-42d3-a456-426614174001")),
      initialStore.write(taskRecord("running")),
      initialStore.write(taskRecord("blocked", "task-123e4567-e89b-42d3-a456-426614174002"))
    ]);
    let modelCalls = 0;
    const restartedStore = new TaskStore(dataDir);

    // When
    const reconciled = await restartedStore.reconcileInterrupted("2026-07-14T13:00:00.000Z");
    const persisted = await restartedStore.read(TASK_ID);

    // Then
    expect(reconciled.ok).toBe(true);
    if (reconciled.ok) expect(reconciled.value.map(record => record.status)).toEqual(["interrupted", "interrupted", "interrupted"]);
    expect(modelCalls).toBe(0);
    expect(persisted.ok).toBe(true);
    if (persisted.ok) {
      expect(persisted.value.status).toBe("interrupted");
      expect(persisted.value.parentSessionId).toBe("parent-session");
      expect(persisted.value.rootSessionId).toBe("root-session");
      expect(persisted.value.childSessionId).toBe("child-session");
      expect(persisted.value.error?.code).toBe("TASK_INTERRUPTED");
    }
  });

  it("does not rewrite an already interrupted task during repeated reconciliation", async () => {
    // Given
    const workspace = await tempWorkspace();
    const store = new TaskStore(path.join(workspace.root, ".strongcode"));
    await store.write(taskRecord("running"));
    await store.reconcileInterrupted("2026-07-14T13:00:00.000Z");

    // When
    const repeated = await store.reconcileInterrupted("2026-07-14T14:00:00.000Z");
    const persisted = await store.read(TASK_ID);

    // Then
    expect(repeated).toEqual({ ok: true, value: [] });
    if (persisted.ok) expect(persisted.value.timestamps.updatedAt).toBe("2026-07-14T13:00:00.000Z");
  });
});
