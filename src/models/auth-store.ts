import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { StrongCodeError, toStrongCodeError } from "../core/errors";

export interface ApiProviderAuth {
  type: "api";
  key: string;
  metadata?: Record<string, string>;
}

export interface OAuthProviderAuth {
  type: "oauth";
  access: string;
  refresh?: string;
  expires?: number;
  accountId?: string;
  metadata?: Record<string, string>;
}

export interface UnsupportedProviderAuth {
  type: "unsupported";
  reason: string;
}

export type ProviderAuth = ApiProviderAuth | OAuthProviderAuth | UnsupportedProviderAuth;

export interface ProviderAuthReader {
  get(providerId: string): Promise<ProviderAuth | undefined>;
  all(): Promise<Record<string, ProviderAuth>>;
}

function assertProviderId(providerId: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(providerId)) {
    throw new StrongCodeError("CONFIG_ERROR", "Provider id may only contain letters, numbers, dot, underscore, and dash");
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(item => typeof item === "string");
}

function parseProviderAuth(value: unknown): ProviderAuth | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const metadata = record.metadata === undefined ? undefined : isStringRecord(record.metadata) ? record.metadata : undefined;

  if (record.type === "api" && typeof record.key === "string" && record.key.length > 0) {
    return { type: "api", key: record.key, metadata };
  }
  if (record.type === "oauth" && typeof record.access === "string" && record.access.length > 0) {
    return {
      type: "oauth",
      access: record.access,
      refresh: typeof record.refresh === "string" ? record.refresh : undefined,
      expires: typeof record.expires === "number" ? record.expires : undefined,
      accountId: typeof record.accountId === "string" && record.accountId.length > 0 ? record.accountId : undefined,
      metadata
    };
  }
  if (record.type === "unsupported" && typeof record.reason === "string" && record.reason.length > 0) {
    return { type: "unsupported", reason: record.reason };
  }

  return undefined;
}

function parseAuthFile(value: unknown): Record<string, ProviderAuth> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const parsed: Record<string, ProviderAuth> = {};
  for (const [providerId, auth] of Object.entries(value)) {
    if (!/^[A-Za-z0-9._-]+$/.test(providerId)) continue;
    const parsedAuth = parseProviderAuth(auth);
    if (parsedAuth) parsed[providerId] = parsedAuth;
  }
  return parsed;
}

export class ProviderAuthStore implements ProviderAuthReader {
  private readonly dataDir: string;
  readonly filePath: string;

  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir);
    this.filePath = path.join(this.dataDir, "auth.json");
  }

  async all(): Promise<Record<string, ProviderAuth>> {
    if (process.env.STRONGCODE_AUTH_CONTENT) {
      try {
        return parseAuthFile(JSON.parse(process.env.STRONGCODE_AUTH_CONTENT));
      } catch (error) {
        throw new StrongCodeError("CONFIG_ERROR", `Invalid STRONGCODE_AUTH_CONTENT: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    try {
      await this.assertNotSymlink(this.filePath);
      return parseAuthFile(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
      throw toStrongCodeError(error, "CONFIG_ERROR");
    }
  }

  async get(providerId: string): Promise<ProviderAuth | undefined> {
    assertProviderId(providerId);
    return (await this.all())[providerId];
  }

  async set(providerId: string, auth: ProviderAuth): Promise<void> {
    assertProviderId(providerId);
    const parsedAuth = parseProviderAuth(auth);
    if (!parsedAuth) throw new StrongCodeError("CONFIG_ERROR", "Invalid provider auth payload");
    const next = { ...await this.all(), [providerId]: parsedAuth };
    await this.writeAll(next);
  }

  async remove(providerId: string): Promise<void> {
    assertProviderId(providerId);
    const next = { ...await this.all() };
    delete next[providerId];
    await this.writeAll(next);
  }

  private async writeAll(auth: Record<string, ProviderAuth>): Promise<void> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await chmod(this.dataDir, 0o700).catch(() => undefined);
    await this.assertNotSymlink(this.filePath);
    if (Object.keys(auth).length === 0) {
      await rm(this.filePath, { force: true });
      return;
    }
    const tempPath = path.join(this.dataDir, `.auth.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(tempPath, `${JSON.stringify(auth, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(tempPath, 0o600).catch(() => undefined);
    await rename(tempPath, this.filePath);
    await chmod(this.filePath, 0o600).catch(() => undefined);
  }

  private async assertNotSymlink(filePath: string): Promise<void> {
    try {
      const stats = await lstat(filePath);
      if (stats.isSymbolicLink()) {
        throw new StrongCodeError("CONFIG_ERROR", `Refusing to use symlinked auth file: ${filePath}`);
      }
    } catch (error) {
      if (error instanceof StrongCodeError) throw error;
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw toStrongCodeError(error, "CONFIG_ERROR");
    }
  }
}
