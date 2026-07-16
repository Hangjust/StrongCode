import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  inspectPath,
  PathIdentityError,
  type PathReceipt,
  revalidatePath
} from "../core/path-identity";

export type SessionDirectoryReceipts = {
  readonly dataDir: PathReceipt;
  readonly sessionsDir: PathReceipt;
};

export function isMissingSessionPath(error: unknown): boolean {
  return error instanceof PathIdentityError && error.reason === "missing-component";
}

function receiptsMatch(expected: PathReceipt, current: PathReceipt): boolean {
  if (expected.components.length !== current.components.length) return false;
  return expected.components.every((component, index) => {
    const observed = current.components[index];
    return observed !== undefined
      && component.path === observed.path
      && component.kind === observed.kind
      && component.dev === observed.dev
      && component.ino === observed.ino;
  });
}

export function sessionDirectoryReceiptsMatch(
  expected: SessionDirectoryReceipts,
  current: SessionDirectoryReceipts
): boolean {
  return receiptsMatch(expected.dataDir, current.dataDir)
    && receiptsMatch(expected.sessionsDir, current.sessionsDir);
}

export class SessionPathSecurity {
  readonly dataDir: string;
  readonly sessionsDir: string;

  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir);
    this.sessionsDir = path.join(this.dataDir, "sessions");
  }

  async prepareStoreForWrite(): Promise<SessionDirectoryReceipts> {
    await this.createDirectory(this.dataDir);
    await this.createDirectory(this.sessionsDir);
    return await this.inspectStore();
  }

  async inspectStore(): Promise<SessionDirectoryReceipts> {
    const dataDir = await inspectPath(this.dataDir, { finalKind: "directory" });
    const sessionsDir = await inspectPath(this.sessionsDir, { finalKind: "directory" });
    return Object.freeze({ dataDir, sessionsDir });
  }

  async revalidate(receipts: SessionDirectoryReceipts): Promise<void> {
    await revalidatePath(receipts.dataDir);
    await revalidatePath(receipts.sessionsDir);
  }

  private async createDirectory(directory: string): Promise<void> {
    let receipt = await inspectPath(directory, { allowMissing: true, finalKind: "directory" });
    while (receipt.missingSuffix.length > 0) {
      const parentReceipt = await inspectPath(receipt.existingPrefix, { finalKind: "directory" });
      await revalidatePath(parentReceipt);
      const segment = receipt.missingSuffix[0];
      if (segment === undefined) break;
      const next = path.join(receipt.existingPrefix, segment);
      try {
        await mkdir(next, { mode: 0o700 });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
      await revalidatePath(parentReceipt);
      receipt = await inspectPath(directory, { allowMissing: true, finalKind: "directory" });
    }
    await revalidatePath(receipt);
  }
}
