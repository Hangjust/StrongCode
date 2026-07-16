import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  BlenderInstallError,
  canonicalTargetPath,
  isNodeError,
  pathState,
  statesEqual,
  syncDirectory,
  writeDurableJson
} from "./durable-fs";
import {
  blenderInstallJournalSchema,
  blenderInstallReceiptSchema,
  profileIdSchema,
  type BlenderInstallJournal,
  type BlenderInstallReceipt,
  type PathState
} from "./journal-schema";

const MAX_JOURNAL_BYTES = 1024 * 1024;

export type TransactionLayout = {
  readonly transactionDirectory: string;
  readonly journalPath: string;
  readonly receiptPath: string;
  readonly stageDirectory: string;
  readonly backupDirectory: string;
};

export type BlenderInstallJournalInspection = {
  readonly rootState: PathState;
  readonly journals: readonly {
    readonly path: string;
    readonly status: BlenderInstallJournal["status"];
  }[];
};

async function ensureDirectory(parentPath: string, name: string): Promise<string> {
  const directoryPath = await canonicalTargetPath(path.join(parentPath, name));
  const state = await pathState(directoryPath);
  if (state.kind === "absent") await mkdir(directoryPath, { mode: 0o700 });
  else if (state.kind !== "directory") throw new BlenderInstallError("unsafe-path", `Transaction path is not a directory: ${directoryPath}`);
  if (process.platform !== "win32") await chmod(directoryPath, 0o700);
  await syncDirectory(parentPath);
  return directoryPath;
}

export async function profileTransactionRoot(homePath: string, profileId: string, create: boolean): Promise<string | undefined> {
  const profile = profileIdSchema.parse(profileId);
  const home = path.resolve(homePath);
  const homeStats = await lstat(home);
  if (homeStats.isSymbolicLink() || !homeStats.isDirectory()) throw new BlenderInstallError("unsafe-path", `StrongCode home is unsafe: ${home}`);
  let current = home;
  for (const name of ["transactions", "blender", profile]) {
    const candidate = await canonicalTargetPath(path.join(current, name));
    const state = await pathState(candidate);
    if (state.kind === "absent") {
      if (!create) return undefined;
      current = await ensureDirectory(current, name);
      continue;
    }
    if (state.kind !== "directory") throw new BlenderInstallError("unsafe-path", `Transaction root is not a directory: ${candidate}`);
    current = candidate;
  }
  return current;
}

export async function createTransactionLayout(homePath: string, profileId: string, transactionId: string): Promise<TransactionLayout> {
  const profileRoot = await profileTransactionRoot(homePath, profileId, true);
  if (!profileRoot) throw new BlenderInstallError("unsafe-path", "Could not create transaction root");
  const transactionDirectory = await ensureDirectory(profileRoot, transactionId);
  const stageDirectory = await ensureDirectory(transactionDirectory, "stage");
  const backupDirectory = await ensureDirectory(transactionDirectory, "backups");
  return {
    transactionDirectory,
    journalPath: path.join(transactionDirectory, "journal.json"),
    receiptPath: path.join(transactionDirectory, "receipt.json"),
    stageDirectory,
    backupDirectory
  };
}

export function layoutFromJournalPath(journalPath: string): TransactionLayout {
  const resolved = path.resolve(journalPath);
  if (path.basename(resolved) !== "journal.json") throw new BlenderInstallError("unsafe-path", `Invalid journal filename: ${resolved}`);
  const transactionDirectory = path.dirname(resolved);
  return {
    transactionDirectory,
    journalPath: resolved,
    receiptPath: path.join(transactionDirectory, "receipt.json"),
    stageDirectory: path.join(transactionDirectory, "stage"),
    backupDirectory: path.join(transactionDirectory, "backups")
  };
}

export function homePathFromJournalPath(journalPath: string): string {
  return path.resolve(layoutFromJournalPath(journalPath).transactionDirectory, "..", "..", "..", "..");
}

export async function readBlenderInstallJournal(journalPath: string): Promise<BlenderInstallJournal> {
  const layout = layoutFromJournalPath(journalPath);
  const state = await pathState(layout.journalPath);
  if (state.kind !== "file") throw new BlenderInstallError("invalid-journal", `Journal is not a regular file: ${layout.journalPath}`);
  const stats = await lstat(layout.journalPath);
  if (stats.size > MAX_JOURNAL_BYTES) throw new BlenderInstallError("invalid-journal", `Journal exceeds ${MAX_JOURNAL_BYTES} bytes`);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(layout.journalPath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new BlenderInstallError("invalid-journal", `Invalid journal JSON: ${error.message}`);
    throw error;
  }
  const parsed = blenderInstallJournalSchema.safeParse(value);
  if (!parsed.success) throw new BlenderInstallError("invalid-journal", `Invalid Blender install journal: ${parsed.error.message}`);
  const profileDirectory = path.dirname(layout.transactionDirectory);
  if (path.basename(layout.transactionDirectory) !== parsed.data.transactionId
    || path.basename(profileDirectory) !== parsed.data.profileId
    || path.basename(path.dirname(profileDirectory)) !== "blender"
    || path.basename(path.dirname(path.dirname(profileDirectory))) !== "transactions") {
    throw new BlenderInstallError("invalid-journal", "Blender install journal does not match its transaction layout");
  }
  const targetPaths = new Set<string>();
  for (const target of parsed.data.targets) {
    const identity = process.platform === "win32" ? target.canonicalPath.toLowerCase() : target.canonicalPath;
    const expectedId = createHash("sha256").update(identity).digest("hex").slice(0, 16);
    if (target.targetId !== expectedId || targetPaths.has(identity)) {
      throw new BlenderInstallError("invalid-journal", "Blender install journal contains an invalid or duplicate target identity");
    }
    targetPaths.add(identity);
    if (target.backup) {
      const expectedBackup = path.join(layout.backupDirectory, `${target.targetId}.${target.backup.kind}`);
      if (target.backup.canonicalPath !== expectedBackup) {
        throw new BlenderInstallError("invalid-journal", "Blender install journal backup escapes its transaction layout");
      }
    }
  }
  return parsed.data;
}

export async function writeBlenderInstallJournal(journalPath: string, journal: BlenderInstallJournal): Promise<void> {
  const parsed = blenderInstallJournalSchema.safeParse(journal);
  if (!parsed.success) throw new BlenderInstallError("invalid-journal", `Invalid Blender install journal: ${parsed.error.message}`);
  await writeDurableJson(layoutFromJournalPath(journalPath).journalPath, parsed.data);
}

export async function writeBlenderInstallReceipt(journalPath: string, receipt: BlenderInstallReceipt): Promise<void> {
  const parsed = blenderInstallReceiptSchema.safeParse(receipt);
  if (!parsed.success) throw new BlenderInstallError("invalid-journal", `Invalid Blender install receipt: ${parsed.error.message}`);
  await writeDurableJson(layoutFromJournalPath(journalPath).receiptPath, parsed.data);
}

export async function transactionJournalPaths(homePath: string, profileId: string): Promise<readonly string[]> {
  const root = await profileTransactionRoot(homePath, profileId, false);
  if (!root) return [];
  const journals: string[] = [];
  for (const name of await readdir(root)) {
    const directory = path.join(root, name);
    try {
      const stats = await lstat(directory);
      if (!stats.isSymbolicLink() && stats.isDirectory()) {
        const journalPath = path.join(directory, "journal.json");
        if ((await pathState(journalPath)).kind === "file") journals.push(journalPath);
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }
  return journals;
}

export async function inspectBlenderInstallJournals(
  homePath: string,
  profileId: string
): Promise<BlenderInstallJournalInspection> {
  const root = await profileTransactionRoot(homePath, profileId, false);
  if (!root) return { rootState: { kind: "absent" }, journals: [] };
  const before = await pathState(root);
  const journals: Array<{ readonly path: string; readonly status: BlenderInstallJournal["status"] }> = [];
  for (const name of (await readdir(root)).sort()) {
    const transactionDirectory = path.join(root, name);
    if ((await pathState(transactionDirectory)).kind !== "directory") {
      throw new BlenderInstallError("invalid-journal", `Invalid Blender transaction entry: ${transactionDirectory}`);
    }
    const journalPath = path.join(transactionDirectory, "journal.json");
    const journal = await readBlenderInstallJournal(journalPath);
    journals.push({ path: journalPath, status: journal.status });
  }
  const after = await pathState(root);
  if (!statesEqual(before, after)) {
    throw new BlenderInstallError("conflict", `Blender transactions changed during inspection: ${root}`);
  }
  return { rootState: after, journals };
}

export async function pruneCommittedJournals(homePath: string, profileId: string): Promise<void> {
  const committed: { readonly journal: BlenderInstallJournal; readonly path: string; readonly modified: bigint }[] = [];
  for (const journalPath of await transactionJournalPaths(homePath, profileId)) {
    try {
      const journal = await readBlenderInstallJournal(journalPath);
      if (journal.status === "committed") {
        const stats = await lstat(journalPath, { bigint: true });
        committed.push({ journal, path: journalPath, modified: stats.mtimeNs });
      }
    } catch (error) {
      if (!(error instanceof BlenderInstallError) || error.reason !== "invalid-journal") throw error;
    }
  }
  committed.sort((left, right) => left.modified === right.modified
    ? right.journal.transactionId.localeCompare(left.journal.transactionId)
    : left.modified > right.modified ? -1 : 1);
  const expired = committed.slice(5);
  for (const transaction of expired) await rm(path.dirname(transaction.path), { recursive: true });
  if (expired.length > 0) {
    const root = await profileTransactionRoot(homePath, profileId, false);
    if (root) await syncDirectory(root);
  }
}
