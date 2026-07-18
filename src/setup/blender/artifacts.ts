import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ArtifactProvenance, WheelLock } from "./artifact-manifest";
import { nodeArtifactFileSystem, nodeArtifactHttpClient } from "./artifact-io";
import type { OfficialArtifactCatalog, OfficialWheelLock } from "./official-artifact-manifest";

export { nodeArtifactFileSystem, nodeArtifactHttpClient } from "./artifact-io";

const ALLOWED_HOSTS = new Set(["files.pythonhosted.org", "projects.blender.org", "raw.githubusercontent.com"]);
const DEFAULT_LIMITS = { overallMs: 60_000, idleMs: 10_000, maxArtifactBytes: 32 * 1024 * 1024 } as const;

export type ArtifactDownloadLimits = {
  readonly overallMs: number;
  readonly idleMs: number;
  readonly maxArtifactBytes: number;
};

export type LockedArtifact = {
  readonly filename: string;
  readonly url: string;
  readonly size: number;
  readonly sha256: string;
};

export type ArtifactHttpResponse = {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body: AsyncIterable<Uint8Array>;
  readonly cancel: () => void;
};

export interface ArtifactHttpClient {
  open(url: string, signal: AbortSignal): Promise<ArtifactHttpResponse>;
}

export interface ArtifactFile {
  write(chunk: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface ArtifactFileSystem {
  mkdir(directory: string): Promise<void>;
  openExclusive(filePath: string): Promise<ArtifactFile>;
  publishExclusive(temporaryPath: string, destinationPath: string): Promise<void>;
  remove(filePath: string): Promise<void>;
}

export type VerifiedArtifactDownloader = {
  readonly download: (artifacts: readonly LockedArtifact[], destination: string) => Promise<void>;
};

export class ArtifactVerificationError extends Error {
  readonly name = "ArtifactVerificationError";
}

export function lockedArtifactClosure(lock: WheelLock, provenance: ArtifactProvenance): readonly LockedArtifact[] {
  const provenanceWheel = provenance.artifacts[0];
  const lockedWheel = lock.wheels.find(wheel => wheel.name === provenanceWheel.name);
  if (!lockedWheel
    || lockedWheel.version !== provenanceWheel.version
    || lockedWheel.filename !== provenanceWheel.filename
    || lockedWheel.url !== provenanceWheel.url
    || lockedWheel.size !== provenanceWheel.size
    || lockedWheel.sha256 !== provenanceWheel.sha256) {
    throw new ArtifactVerificationError("Upstream wheel provenance does not match the locked closure");
  }
  return [...lock.wheels, provenance.artifacts[1]].map(item => ({
    filename: item.filename,
    url: item.url,
    size: item.size,
    sha256: item.sha256
  }));
}

export function officialArtifactClosure(
  catalog: OfficialArtifactCatalog,
  lock: OfficialWheelLock
): readonly LockedArtifact[] {
  return [...catalog.release.assets, ...lock.dependencies];
}

export async function downloadVerifiedArtifacts(options: {
  readonly artifacts: readonly LockedArtifact[];
  readonly destination: string;
  readonly http?: ArtifactHttpClient;
  readonly files?: ArtifactFileSystem;
  readonly limits?: Partial<ArtifactDownloadLimits>;
}): Promise<void> {
  const http = options.http ?? nodeArtifactHttpClient;
  const files = options.files ?? nodeArtifactFileSystem;
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new ArtifactVerificationError(`Invalid artifact ${name} limit`);
  }
  if (limits.maxArtifactBytes > DEFAULT_LIMITS.maxArtifactBytes) {
    throw new ArtifactVerificationError("Artifact byte cap cannot exceed the application maximum");
  }
  const controller = new AbortController();
  const overallTimer = setTimeout(
    () => controller.abort(new ArtifactVerificationError(`Artifact download exceeded ${limits.overallMs}ms`)),
    limits.overallMs
  );
  overallTimer.unref();
  await files.mkdir(options.destination);
  let nextIndex = 0;
  try {
    const workers = Array.from({ length: Math.min(2, options.artifacts.length) }, async () => {
      while (nextIndex < options.artifacts.length) {
        const artifact = options.artifacts[nextIndex];
        nextIndex += 1;
        if (!artifact) return;
        await downloadOne({ artifact, destination: options.destination, http, files, limits, controller });
      }
    });
    const results = await Promise.allSettled(workers);
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  } finally {
    clearTimeout(overallTimer);
    controller.abort();
  }
}

export async function verifyLocalArtifacts(
  artifacts: readonly LockedArtifact[],
  directory: string,
  reader: (filePath: string) => Promise<Uint8Array> = readFile
): Promise<void> {
  for (const artifact of artifacts) {
    const content = await reader(path.join(directory, artifact.filename));
    if (content.byteLength !== artifact.size) {
      throw new ArtifactVerificationError(`${artifact.filename} has size ${content.byteLength}, expected ${artifact.size}`);
    }
    const digest = createHash("sha256").update(content).digest("hex");
    if (digest !== artifact.sha256) throw new ArtifactVerificationError(`${artifact.filename} SHA-256 digest mismatch`);
  }
}

async function downloadOne(options: {
  readonly artifact: LockedArtifact;
  readonly destination: string;
  readonly http: ArtifactHttpClient;
  readonly files: ArtifactFileSystem;
  readonly limits: ArtifactDownloadLimits;
  readonly controller: AbortController;
}): Promise<void> {
  const url = requireAllowedUrl(options.artifact);
  if (options.artifact.size > options.limits.maxArtifactBytes) {
    throw new ArtifactVerificationError(`${options.artifact.filename} exceeds the artifact byte cap`);
  }
  const temporaryPath = path.join(options.destination, `.${options.artifact.filename}.${randomUUID()}.part`);
  const destinationPath = path.join(options.destination, options.artifact.filename);
  const file = await options.files.openExclusive(temporaryPath);
  let closed = false;
  let published = false;
  let response: ArtifactHttpResponse | undefined;
  try {
    response = await abortable(options.http.open(url.href, options.controller.signal), options.controller.signal);
    if (response.statusCode >= 300 && response.statusCode < 400) throw new ArtifactVerificationError(`Redirect rejected for ${url.href}`);
    if (response.statusCode !== 200) throw new ArtifactVerificationError(`HTTP ${response.statusCode} for ${url.href}`);
    const contentLength = singleHeader(response.headers["content-length"]);
    if (contentLength !== undefined && Number(contentLength) !== options.artifact.size) {
      throw new ArtifactVerificationError(`${options.artifact.filename} Content-Length does not match its lock`);
    }
    const digest = createHash("sha256");
    let received = 0;
    const iterator = response.body[Symbol.asyncIterator]();
    while (true) {
      const item = await nextChunk(iterator, options.limits.idleMs, options.controller);
      if (item.done) break;
      received += item.value.byteLength;
      if (received > options.artifact.size) throw new ArtifactVerificationError(`${options.artifact.filename} exceeded its locked size`);
      digest.update(item.value);
      await file.write(item.value);
    }
    if (received !== options.artifact.size) throw new ArtifactVerificationError(`${options.artifact.filename} size mismatch`);
    if (digest.digest("hex") !== options.artifact.sha256) throw new ArtifactVerificationError(`${options.artifact.filename} SHA-256 digest mismatch`);
    await file.sync();
    await file.close();
    closed = true;
    await options.files.publishExclusive(temporaryPath, destinationPath);
    published = true;
  } finally {
    response?.cancel();
    if (!closed) await file.close();
    if (!published) await options.files.remove(temporaryPath);
  }
}

function requireAllowedUrl(artifact: LockedArtifact): URL {
  if (path.basename(artifact.filename) !== artifact.filename || artifact.filename.length === 0) {
    throw new ArtifactVerificationError("Artifact filename must be a single path component");
  }
  if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0 || !/^[a-f0-9]{64}$/u.test(artifact.sha256)) {
    throw new ArtifactVerificationError(`Artifact lock values are invalid for ${artifact.filename}`);
  }
  let url: URL;
  try {
    url = new URL(artifact.url);
  } catch (error) {
    if (error instanceof TypeError) throw new ArtifactVerificationError(`Artifact URL is invalid: ${artifact.url}`);
    throw error;
  }
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname) || url.port || url.username || url.password) {
    throw new ArtifactVerificationError(`Artifact URL is not allowlisted: ${artifact.url}`);
  }
  if (!url.pathname.endsWith(`/${artifact.filename}`)) throw new ArtifactVerificationError("Artifact URL filename does not match its lock");
  return url;
}

function singleHeader(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === "string" || value === undefined) return value;
  throw new ArtifactVerificationError("Duplicate Content-Length headers are not allowed");
}

function nextChunk(
  iterator: AsyncIterator<Uint8Array>,
  idleMs: number,
  controller: AbortController
): Promise<IteratorResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(controller.signal.reason);
    const timer = setTimeout(() => {
      const error = new ArtifactVerificationError(`Artifact stream was idle for ${idleMs}ms`);
      controller.abort(error);
      reject(error);
    }, idleMs);
    timer.unref();
    controller.signal.addEventListener("abort", onAbort, { once: true });
    iterator.next().then(
      value => { clearTimeout(timer); controller.signal.removeEventListener("abort", onAbort); resolve(value); },
      error => { clearTimeout(timer); controller.signal.removeEventListener("abort", onAbort); reject(error); }
    );
  });
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      value => { signal.removeEventListener("abort", onAbort); resolve(value); },
      error => { signal.removeEventListener("abort", onAbort); reject(error); }
    );
  });
}
