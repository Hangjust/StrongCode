import { chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { StrongCodeError, toStrongCodeError } from "../core/errors";
import { err, ok, type Result } from "../core/result";
import {
  NONTERMINAL_TASK_STATUSES,
  parseTaskRecord,
  taskIdSchema,
  taskTimestampsSchema,
  type TaskRecord,
  type TaskStatus
} from "./types";
import { boundTaskText, TASK_ERROR_MESSAGE_MAX_UNITS } from "./text-bounds";

const MAX_TASK_FILE_BYTES = 1_048_576;
const nonterminalStatuses = new Set<TaskStatus>(NONTERMINAL_TASK_STATUSES);

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function taskError(message: string): StrongCodeError {
  return new StrongCodeError("TASK_ERROR", message);
}

export class TaskStore {
  private static readonly operationQueues = new Map<string, Promise<void>>();
  private readonly dataDir: string;
  readonly tasksDir: string;

  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir);
    this.tasksDir = path.join(this.dataDir, "tasks");
  }

  pathFor(taskId: string): Result<string> {
    const parsed = taskIdSchema.safeParse(taskId);
    if (!parsed.success) return err(taskError("Task id must use the canonical task-<uuid> form"));
    return ok(path.join(this.tasksDir, `${parsed.data}.json`));
  }

  async write(record: unknown): Promise<Result<void>> {
    try {
      const parsed = parseTaskRecord(record);
      const filePath = this.pathFor(parsed.id);
      if (!filePath.ok) return filePath;
      const payload = `${JSON.stringify(parsed, null, 2)}\n`;
      if (Buffer.byteLength(payload, "utf8") > MAX_TASK_FILE_BYTES) {
        return err(taskError(`Task record exceeds ${MAX_TASK_FILE_BYTES} bytes: ${parsed.id}`));
      }
      await this.enqueueOperation(filePath.value, () => this.writeRecord(filePath.value, parsed.id, payload));
      return ok(undefined);
    } catch (error) {
      if (error instanceof StrongCodeError) return err(error);
      return err(toStrongCodeError(error, "TASK_ERROR"));
    }
  }

  async read(taskId: string): Promise<Result<TaskRecord>> {
    const filePath = this.pathFor(taskId);
    if (!filePath.ok) return filePath;
    try {
      const available = await this.assertStoreDirectoryForRead();
      if (!available) return err(taskError(`Task record not found: ${taskId}`));
      return ok(await this.enqueueOperation(filePath.value, () => this.readRecord(filePath.value, taskId)));
    } catch (error) {
      if (error instanceof StrongCodeError) return err(error);
      return err(toStrongCodeError(error, "TASK_ERROR"));
    }
  }

  async list(): Promise<Result<TaskRecord[]>> {
    try {
      if (!await this.assertStoreDirectoryForRead()) return ok([]);
      const entries = await readdir(this.tasksDir, { withFileTypes: true });
      const records: TaskRecord[] = [];
      for (const entry of entries) {
        if (!entry.name.endsWith(".json")) continue;
        if (!entry.isFile() || entry.isSymbolicLink()) {
          throw taskError(`Refusing to read non-file task record: ${entry.name}`);
        }
        const taskId = entry.name.slice(0, -".json".length);
        if (!taskIdSchema.safeParse(taskId).success) {
          throw taskError(`Invalid task record filename: ${entry.name}`);
        }
        const filePath = path.join(this.tasksDir, entry.name);
        records.push(await this.enqueueOperation(filePath, () => this.readRecord(filePath, taskId)));
      }
      records.sort((left, right) => left.id.localeCompare(right.id));
      return ok(records);
    } catch (error) {
      if (error instanceof StrongCodeError) return err(error);
      return err(toStrongCodeError(error, "TASK_ERROR"));
    }
  }

  async reconcileInterrupted(timestamp = new Date().toISOString()): Promise<Result<TaskRecord[]>> {
    const parsedTimestamp = taskTimestampsSchema.shape.updatedAt.safeParse(timestamp);
    if (!parsedTimestamp.success) return err(taskError("Reconciliation timestamp must be an ISO 8601 timestamp"));
    const listed = await this.list();
    if (!listed.ok) return listed;
    const reconciled: TaskRecord[] = [];
    for (const record of listed.value) {
      if (!nonterminalStatuses.has(record.status)) continue;
      const interrupted: TaskRecord = {
        ...record,
        status: "interrupted",
        timestamps: {
          ...record.timestamps,
          updatedAt: parsedTimestamp.data,
          completedAt: parsedTimestamp.data
        },
        error: {
          code: "TASK_INTERRUPTED",
          message: boundTaskText("Task was interrupted by process restart", TASK_ERROR_MESSAGE_MAX_UNITS)
        }
      };
      const written = await this.write(interrupted);
      if (!written.ok) return written;
      reconciled.push(interrupted);
    }
    return ok(reconciled);
  }

  private async enqueueOperation<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    const previous = TaskStore.operationQueues.get(filePath) ?? Promise.resolve();
    const current = previous.then(operation);
    const settled = current.then(() => undefined, () => undefined);
    TaskStore.operationQueues.set(filePath, settled);
    try {
      return await current;
    } finally {
      if (TaskStore.operationQueues.get(filePath) === settled) TaskStore.operationQueues.delete(filePath);
    }
  }

  private async writeRecord(filePath: string, taskId: string, payload: string): Promise<void> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await this.assertDirectory(this.dataDir, "task data directory");
    await mkdir(this.tasksDir, { recursive: true, mode: 0o700 });
    await this.assertDirectory(this.tasksDir, "task store");
    await this.assertRealContainment();
    await chmod(this.tasksDir, 0o700);
    await this.taskFileStats(filePath);

    const tempPath = path.join(this.tasksDir, `.${taskId}.${process.pid}.${randomUUID()}.tmp`);
    let tempExists = false;
    let tempHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      tempHandle = await open(tempPath, "wx", 0o600);
      tempExists = true;
      await tempHandle.writeFile(payload, "utf8");
      await tempHandle.sync();
      await tempHandle.close();
      tempHandle = undefined;
      await this.taskFileStats(filePath);
      await rename(tempPath, filePath);
      tempExists = false;
    } finally {
      if (tempHandle) await tempHandle.close();
      if (tempExists) await rm(tempPath, { force: true });
    }
  }

  private async readRecord(filePath: string, expectedTaskId: string): Promise<TaskRecord> {
    const stats = await this.taskFileStats(filePath);
    if (!stats) throw taskError(`Task record not found: ${expectedTaskId}`);
    if (stats.size > MAX_TASK_FILE_BYTES) throw taskError(`Task record exceeds ${MAX_TASK_FILE_BYTES} bytes: ${expectedTaskId}`);
    let source: unknown;
    try {
      source = JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      throw new StrongCodeError("TASK_ERROR", `Invalid task JSON for ${expectedTaskId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const record = parseTaskRecord(source);
    if (record.id !== expectedTaskId) throw taskError(`Task record id does not match filename: ${expectedTaskId}`);
    return record;
  }

  private async taskFileStats(filePath: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
    try {
      const stats = await lstat(filePath);
      if (stats.isSymbolicLink() || !stats.isFile()) throw taskError(`Refusing to use non-file task record: ${filePath}`);
      return stats;
    } catch (error) {
      if (isMissing(error)) return undefined;
      if (error instanceof StrongCodeError) throw error;
      throw toStrongCodeError(error, "TASK_ERROR");
    }
  }

  private async assertStoreDirectoryForRead(): Promise<boolean> {
    try {
      await this.assertDirectory(this.dataDir, "task data directory");
      await this.assertDirectory(this.tasksDir, "task store");
      await this.assertRealContainment();
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  private async assertDirectory(directory: string, label: string): Promise<void> {
    const stats = await lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw taskError(`Refusing to use non-directory ${label}: ${directory}`);
  }

  private async assertRealContainment(): Promise<void> {
    const realDataDir = await realpath(this.dataDir);
    const realTasksDir = await realpath(this.tasksDir);
    if (path.relative(realDataDir, realTasksDir) !== "tasks") {
      throw taskError(`Task store resolves outside data directory: ${this.tasksDir}`);
    }
  }
}
