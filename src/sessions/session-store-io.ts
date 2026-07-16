import { open } from "node:fs/promises";
import type { SessionFileSecurity } from "./session-file-security";
import { sessionError } from "./session-file-security";

export type SessionWriteGuard = () => boolean | Promise<boolean>;
export type SessionWriteOutcome =
  | { readonly kind: "committed" }
  | { readonly kind: "rejected" };

export class SessionStoreIo {
  constructor(private readonly security: SessionFileSecurity) {}

  async append(
    filePath: string,
    payload: string,
    guard?: SessionWriteGuard
  ): Promise<SessionWriteOutcome> {
    const directoryStats = await this.security.prepareStoreForWrite();
    await this.security.sessionFileStats(filePath);
    const handle = await open(filePath, "a+", 0o600);
    try {
      const stats = await this.security.assertHandleIdentity(handle, filePath, directoryStats);
      if (process.platform !== "win32") await handle.chmod(0o600);
      let separator = "";
      if (stats.size > 0) {
        const finalByte = Buffer.alloc(1);
        const read = await handle.read(finalByte, 0, 1, stats.size - 1);
        if (read.bytesRead !== 1) throw sessionError(`Could not inspect session record: ${filePath}`);
        if (finalByte[0] !== 0x0a) separator = "\n";
      }
      await this.security.assertHandleIdentity(handle, filePath, directoryStats);
      const finalDecision = guard?.() ?? true;
      const finalAllowed = typeof finalDecision === "boolean" ? finalDecision : await finalDecision;
      if (!finalAllowed) return { kind: "rejected" };
      await handle.writeFile(`${separator}${payload}`, "utf8");
      await handle.sync();
      return { kind: "committed" };
    } finally {
      await handle.close();
    }
  }

  async read(filePath: string): Promise<string | undefined> {
    const directoryStats = await this.security.storeDirectoryStatsForRead();
    if (directoryStats === undefined) return undefined;
    const secured = await this.security.readSecuredFile(filePath, directoryStats);
    return secured?.bytes.toString("utf8");
  }
}
