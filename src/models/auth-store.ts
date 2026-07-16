import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { StrongCodeError, toStrongCodeError } from "../core/errors";
import { resolveStrongCodeHome } from "../config/paths";

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

export interface DelegatedProviderAuth {
  type: "delegated";
  provider: "codex" | "gcloud";
  metadata?: Record<string, string>;
}

export type ProviderAuth = ApiProviderAuth | OAuthProviderAuth | DelegatedProviderAuth | UnsupportedProviderAuth;

export interface ProviderAuthReader {
  get(providerId: string): Promise<ProviderAuth | undefined>;
  all(): Promise<Record<string, ProviderAuth>>;
}

export interface ProviderAuthStoreOptions {
  /** Permit the process-wide STRONGCODE_AUTH_CONTENT override for this store. */
  allowEnvironmentContent?: boolean;
}

export interface RuntimeAuthReaderOptions {
  /** Explicit compatibility escape hatch; repository runtimes never enable this implicitly. */
  allowGlobalFallback?: boolean;
  /** Permit process-injected auth content only for a trusted runtime. */
  allowEnvironmentContent?: boolean;
}

export class LayeredProviderAuthReader implements ProviderAuthReader {
  constructor(private readonly primary: ProviderAuthReader, private readonly fallback: ProviderAuthReader) {}

  async all(): Promise<Record<string, ProviderAuth>> {
    return { ...await this.fallback.all(), ...await this.primary.all() };
  }

  async get(providerId: string): Promise<ProviderAuth | undefined> {
    return await this.primary.get(providerId) ?? await this.fallback.get(providerId);
  }
}

function samePath(left: string, right: string): boolean {
  const leftPath = path.resolve(left);
  const rightPath = path.resolve(right);
  return process.platform === "win32" ? leftPath.toLowerCase() === rightPath.toLowerCase() : leftPath === rightPath;
}

/**
 * Keep repository-scoped credentials outside the repository so a tracked file
 * can never be overwritten with a real key. Each config path gets an isolated
 * vault; the canonical home config continues to use its normal data directory.
 */
export function resolveRuntimeAuthDataDir(
  configPath: string,
  runtimeDataDir: string,
  homePath = resolveStrongCodeHome()
): string {
  const resolvedHome = path.resolve(homePath);
  const homeConfigPath = path.join(resolvedHome, "strongcode.config.yaml");
  if (samePath(configPath, homeConfigPath)) return path.resolve(runtimeDataDir);
  const resolvedConfigPath = path.resolve(configPath);
  const identitySource = process.platform === "win32" ? resolvedConfigPath.toLowerCase() : resolvedConfigPath;
  const identity = createHash("sha256").update(identitySource).digest("hex").slice(0, 24);
  return path.join(resolvedHome, "project-auth", identity);
}

/** Build a runtime credential reader without implicitly crossing the project/home trust boundary. */
export function createRuntimeAuthReader(dataDir: string, homePath = resolveStrongCodeHome(), options: RuntimeAuthReaderOptions = {}): ProviderAuthReader {
  const storeOptions = { allowEnvironmentContent: options.allowEnvironmentContent === true };
  const primary = new ProviderAuthStore(dataDir, storeOptions);
  return samePath(dataDir, homePath) || options.allowGlobalFallback !== true
    ? primary
    : new LayeredProviderAuthReader(primary, new ProviderAuthStore(homePath, storeOptions));
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
  if (record.type === "delegated" && (record.provider === "codex" || record.provider === "gcloud")) {
    return { type: "delegated", provider: record.provider, metadata };
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
  private static readonly writeQueues = new Map<string, Promise<void>>();
  private readonly dataDir: string;
  private readonly allowEnvironmentContent: boolean;
  readonly filePath: string;

  constructor(dataDir: string, options: ProviderAuthStoreOptions = {}) {
    this.dataDir = path.resolve(dataDir);
    this.allowEnvironmentContent = options.allowEnvironmentContent !== false;
    this.filePath = path.join(this.dataDir, "auth.json");
  }

  async all(): Promise<Record<string, ProviderAuth>> {
    if (this.allowEnvironmentContent && process.env.STRONGCODE_AUTH_CONTENT) {
      try {
        return parseAuthFile(JSON.parse(process.env.STRONGCODE_AUTH_CONTENT));
      } catch (error) {
        throw new StrongCodeError("CONFIG_ERROR", `Invalid STRONGCODE_AUTH_CONTENT: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    try {
      if (!await this.assertCredentialDirectoryForRead()) return {};
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
    await this.enqueueWrite(async () => {
      const next = { ...await this.all(), [providerId]: parsedAuth };
      await this.writeAll(next);
    });
  }

  async remove(providerId: string): Promise<void> {
    assertProviderId(providerId);
    await this.enqueueWrite(async () => {
      const next = { ...await this.all() };
      delete next[providerId];
      await this.writeAll(next);
    });
  }

  private async enqueueWrite(operation: () => Promise<void>): Promise<void> {
    if (this.allowEnvironmentContent && process.env.STRONGCODE_AUTH_CONTENT) {
      throw new StrongCodeError("CONFIG_ERROR", "Credential writes are disabled while STRONGCODE_AUTH_CONTENT overrides the auth store");
    }
    const previous = ProviderAuthStore.writeQueues.get(this.filePath) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    ProviderAuthStore.writeQueues.set(this.filePath, current);
    try {
      await current;
    } finally {
      if (ProviderAuthStore.writeQueues.get(this.filePath) === current) ProviderAuthStore.writeQueues.delete(this.filePath);
    }
  }

  private async writeAll(auth: Record<string, ProviderAuth>): Promise<void> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const directoryStats = await lstat(this.dataDir);
    if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
      throw new StrongCodeError("CONFIG_ERROR", `Refusing to use non-directory credential store: ${this.dataDir}`);
    }
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

  private async assertCredentialDirectoryForRead(): Promise<boolean> {
    try {
      const stats = await lstat(this.dataDir);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new StrongCodeError("CONFIG_ERROR", `Refusing to use non-directory credential store: ${this.dataDir}`);
      }
      return true;
    } catch (error) {
      if (error instanceof StrongCodeError) throw error;
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
      throw toStrongCodeError(error, "CONFIG_ERROR");
    }
  }
}
