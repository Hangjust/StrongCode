import { chmod, link, lstat, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assertNoSymlinkPathComponents, atomicReplaceExpectedSource, sha256Source } from "../config/save";
import { StrongCodeError } from "../core/errors";
import { SETUP_SCHEMA_VERSION, type SetupState } from "./types";
import { acquireSetupStateLock } from "./state-lock";

const MAX_UPDATE_ATTEMPTS = 3;

const setupCoreStateSchema = z.object({
  completed: z.boolean(),
  completedAt: z.string().datetime().optional(),
  selectedProviders: z.array(z.string().min(1)).default([]),
  deepSeekConfigured: z.boolean().default(false),
  gemmaConfigured: z.boolean().default(false),
  mockOnlyConfirmed: z.boolean().default(false),
  voiceToText: z.enum(["yes", "no", "maybe"]).default("no")
});

const installedBlenderIntegrationSchema = z.object({
  profileId: z.string().min(1),
  version: z.string().min(1),
  executablePath: z.string().min(1).refine(value => path.isAbsolute(value), "Blender executable path must be absolute"),
  receiptPath: z.string().min(1).refine(value => path.isAbsolute(value), "Blender receipt path must be absolute"),
  installedAt: z.string().datetime()
}).strict().readonly();

const setupStateV1Schema = setupCoreStateSchema.extend({ schemaVersion: z.literal(1) });
const setupStateSchema = setupCoreStateSchema.extend({
  schemaVersion: z.literal(SETUP_SCHEMA_VERSION),
  blender: installedBlenderIntegrationSchema.optional(),
  blenderOfferVersion: z.number().int().nonnegative().default(0)
});

export type SetupStatePatch = Partial<Omit<SetupState, "schemaVersion">>;

export function emptySetupState(): SetupState {
  return {
    schemaVersion: SETUP_SCHEMA_VERSION,
    completed: false,
    selectedProviders: [],
    deepSeekConfigured: false,
    gemmaConfigured: false,
    mockOnlyConfirmed: false,
    voiceToText: "no",
    blenderOfferVersion: 0
  };
}

async function assertNotSymlink(filePath: string): Promise<void> {
  try {
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink()) throw new StrongCodeError("CONFIG_ERROR", `Refusing to use symlinked setup state: ${filePath}`);
  } catch (error) {
    if (error instanceof StrongCodeError) throw error;
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

export async function loadSetupState(homePath: string): Promise<SetupState> {
  const filePath = path.join(path.resolve(homePath), "setup.json");
  await assertNotSymlink(filePath);
  try {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) throw new StrongCodeError("CONFIG_ERROR", `Invalid setup.json: ${error.message}`);
      throw error;
    }
    return parseSetupState(value);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return emptySetupState();
    throw error;
  }
}

export async function updateSetupState(
  homePath: string,
  update: (latest: SetupState) => SetupStatePatch | Promise<SetupStatePatch>
): Promise<SetupState> {
  const filePath = path.join(path.resolve(homePath), "setup.json");
  for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt += 1) {
    await assertNoSymlinkPathComponents(filePath);
    await assertNotSymlink(filePath);
    const source = await readFile(filePath).catch(error => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    const latest = source ? parseSetupStateJson(source.toString("utf8")) : emptySetupState();
    const candidate = setupStateSchema.safeParse({
      ...latest,
      ...await update(latest),
      schemaVersion: SETUP_SCHEMA_VERSION
    });
    if (!candidate.success) {
      throw new StrongCodeError("CONFIG_ERROR", `Invalid setup state: ${candidate.error.issues.map(issue => issue.message).join("; ")}`);
    }
    const content = `${JSON.stringify(candidate.data, null, 2)}\n`;
    const lock = await acquireSetupStateLock(homePath);
    try {
      await assertNoSymlinkPathComponents(filePath);
      await assertNotSymlink(filePath);
      if (source) {
        await atomicReplaceExpectedSource({ filePath, expectedSourceHash: sha256Source(source), content });
      } else {
        await publishMissingSetupState(filePath, content);
      }
      return candidate.data;
    } catch (error) {
      if (!staleSetupStateError(error) || attempt === MAX_UPDATE_ATTEMPTS - 1) throw error;
    } finally {
      await lock.release();
    }
  }
  throw new StrongCodeError("CONFIG_ERROR", "Setup state changed repeatedly during update");
}

export async function saveSetupState(homePath: string, state: SetupState): Promise<void> {
  const parsed = setupStateSchema.safeParse(state);
  if (!parsed.success) throw new StrongCodeError("CONFIG_ERROR", `Invalid setup state: ${parsed.error.issues.map(issue => issue.message).join("; ")}`);
  await updateSetupState(homePath, () => parsed.data);
}

function parseSetupState(value: unknown): SetupState {
  const current = setupStateSchema.safeParse(value);
  if (current.success) return current.data;
  const legacy = setupStateV1Schema.safeParse(value);
  if (legacy.success) return { ...legacy.data, schemaVersion: SETUP_SCHEMA_VERSION, blenderOfferVersion: 0 };
  throw new StrongCodeError("CONFIG_ERROR", `Invalid setup.json: ${current.error.issues.map(issue => issue.message).join("; ")}`);
}

function parseSetupStateJson(source: string): SetupState {
  try {
    return parseSetupState(JSON.parse(source));
  } catch (error) {
    if (error instanceof SyntaxError) throw new StrongCodeError("CONFIG_ERROR", `Invalid setup.json: ${error.message}`);
    throw error;
  }
}

async function publishMissingSetupState(filePath: string, content: string): Promise<void> {
  const tempPath = path.join(path.dirname(filePath), `.setup.${process.pid}.${randomUUID()}.new.tmp`);
  try {
    await writeFile(tempPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(tempPath, 0o600).catch(() => undefined);
    await assertNoSymlinkPathComponents(filePath);
    await assertNotSymlink(filePath);
    await link(tempPath, filePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new StrongCodeError("CONFIG_ERROR", `Setup state changed after planning: ${filePath}`);
    }
    throw error;
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

function staleSetupStateError(error: unknown): boolean {
  return error instanceof StrongCodeError && (
    error.message.startsWith("Config changed after planning")
    || error.message.startsWith("Setup state changed after planning")
  );
}
