import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { StrongCodeError, toStrongCodeError } from "../core/errors";
import { err, ok, Result } from "../core/result";
import { Session, SessionEvent } from "./session";

export class SessionStore {
  private readonly sessionsDir: string;

  constructor(dataDir: string) {
    this.sessionsDir = path.join(dataDir, "sessions");
  }

  pathFor(sessionId: string): Result<string> {
    if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) {
      return err(new StrongCodeError("SESSION_ERROR", "Session id may only contain letters, numbers, dot, underscore, and dash"));
    }

    return ok(path.join(this.sessionsDir, `${sessionId}.jsonl`));
  }

  async append(sessionId: string, event: SessionEvent): Promise<Result<void>> {
    const filePath = this.pathFor(sessionId);
    if (!filePath.ok) {
      return filePath;
    }

    try {
      await mkdir(this.sessionsDir, { recursive: true });
      await writeFile(filePath.value, `${JSON.stringify(event)}\n`, { flag: "a" });
      return ok(undefined);
    } catch (error) {
      return err(toStrongCodeError(error, "SESSION_ERROR"));
    }
  }

  async read(sessionId: string): Promise<Result<Session>> {
    const filePath = this.pathFor(sessionId);
    if (!filePath.ok) {
      return filePath;
    }

    try {
      const source = await readFile(filePath.value, "utf8");
      const events = source
        .split("\n")
        .filter(line => line.trim().length > 0)
        .map(line => JSON.parse(line) as SessionEvent);
      return ok({ id: sessionId, events });
    } catch (error) {
      return err(toStrongCodeError(error, "SESSION_ERROR"));
    }
  }

  async readOrEmpty(sessionId: string): Promise<Result<Session>> {
    const existing = await this.read(sessionId);
    if (existing.ok) {
      return existing;
    }

    return ok({ id: sessionId, events: [] });
  }

  async list(): Promise<Result<string[]>> {
    try {
      await mkdir(this.sessionsDir, { recursive: true });
      const entries = await readdir(this.sessionsDir);
      const sessions: string[] = [];

      for (const entry of entries) {
        if (!entry.endsWith(".jsonl")) {
          continue;
        }

        const fullPath = path.join(this.sessionsDir, entry);
        const stats = await stat(fullPath);
        if (stats.isFile()) {
          sessions.push(entry.slice(0, -".jsonl".length));
        }
      }

      return ok(sessions.sort((left, right) => left.localeCompare(right)));
    } catch (error) {
      return err(toStrongCodeError(error, "SESSION_ERROR"));
    }
  }
}
