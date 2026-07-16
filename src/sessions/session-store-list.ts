import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import type { SessionFileSecurity } from "./session-file-security";
import { sessionError } from "./session-file-security";

export const SESSION_FILE_SUFFIX = ".jsonl";
export const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export async function listSessionIds(
  security: SessionFileSecurity,
  sessionsDir: string
): Promise<string[]> {
  const directoryStats = await security.storeDirectoryStatsForRead();
  if (directoryStats === undefined) return [];
  const entries = await readdir(sessionsDir, { withFileTypes: true });
  const sessions: string[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(SESSION_FILE_SUFFIX)) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw sessionError(`Refusing to list non-file session record: ${entry.name}`);
    }
    const sessionId = entry.name.slice(0, -SESSION_FILE_SUFFIX.length);
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw sessionError(`Invalid session record filename: ${entry.name}`);
    }
    const stats = await lstat(path.join(sessionsDir, entry.name));
    security.assertRegularFile(stats, entry.name);
    sessions.push(sessionId);
  }
  security.assertDirectoryIdentities(directoryStats, await security.assertStoreDirectories());
  return sessions.sort((left, right) => left.localeCompare(right));
}
