import { link, lstat, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionStore } from "../src/sessions/session-store";
import { messageEvent } from "../src/sessions/session";
import { tempWorkspace } from "./helpers";

const LEGACY_EVENT = {
  type: "message",
  timestamp: "2026-07-14T00:00:00.000Z",
  role: "assistant",
  content: "legacy"
} as const;

async function createLink(target: string, linkPath: string, type: "dir" | "file"): Promise<boolean> {
  try {
    await symlink(target, linkPath, process.platform === "win32" && type === "dir" ? "junction" : type);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "ENOTSUP")) return false;
    throw error;
  }
}

describe("session store filesystem hardening", () => {
  it("rejects a linked data directory without changing its external target", async () => {
    // Given
    const workspace = await tempWorkspace();
    const dataDir = path.join(workspace.root, ".strongcode");
    const externalDir = path.join(workspace.root, "external-data");
    await mkdir(externalDir);
    const sentinel = path.join(externalDir, "sentinel.txt");
    await writeFile(sentinel, "preserve", "utf8");
    if (!await createLink(externalDir, dataDir, "dir")) return;

    // When
    const result = await new SessionStore(dataDir).append("escaped", messageEvent("user", "blocked"));

    // Then
    expect(result.ok).toBe(false);
    expect(await readFile(sentinel, "utf8")).toBe("preserve");
    await expect(readFile(path.join(externalDir, "sessions", "escaped.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a linked sessions directory without changing its external target", async () => {
    // Given
    const workspace = await tempWorkspace();
    const dataDir = path.join(workspace.root, ".strongcode");
    const sessionsDir = path.join(dataDir, "sessions");
    const externalDir = path.join(workspace.root, "external-sessions");
    await mkdir(dataDir);
    await mkdir(externalDir);
    const sentinel = path.join(externalDir, "sentinel.txt");
    await writeFile(sentinel, "preserve", "utf8");
    if (!await createLink(externalDir, sessionsDir, "dir")) return;

    // When
    const result = await new SessionStore(dataDir).append("escaped", messageEvent("user", "blocked"));

    // Then
    expect(result.ok).toBe(false);
    expect(await readFile(sentinel, "utf8")).toBe("preserve");
    await expect(readFile(path.join(externalDir, "escaped.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a hard-linked final session file before append", async () => {
    // Given
    const workspace = await tempWorkspace();
    const dataDir = path.join(workspace.root, ".strongcode");
    const sessionsDir = path.join(dataDir, "sessions");
    const externalFile = path.join(workspace.root, "external.jsonl");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(externalFile, `${JSON.stringify(LEGACY_EVENT)}\n`, "utf8");
    await link(externalFile, path.join(sessionsDir, "linked.jsonl"));

    // When
    const result = await new SessionStore(dataDir).append("linked", messageEvent("user", "blocked"));

    // Then
    expect(result.ok).toBe(false);
    expect(await readFile(externalFile, "utf8")).toBe(`${JSON.stringify(LEGACY_EVENT)}\n`);
  });

  it("does not treat a linked final session file as an empty missing session", async () => {
    // Given
    const workspace = await tempWorkspace();
    const dataDir = path.join(workspace.root, ".strongcode");
    const sessionsDir = path.join(dataDir, "sessions");
    const externalFile = path.join(workspace.root, "external.jsonl");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(externalFile, `${JSON.stringify(LEGACY_EVENT)}\n`, "utf8");
    if (!await createLink(externalFile, path.join(sessionsDir, "linked.jsonl"), "file")) return;

    // When
    const result = await new SessionStore(dataDir).readOrEmpty("linked");

    // Then
    expect(result.ok).toBe(false);
  });

  it("rejects linked JSONL entries while listing", async () => {
    // Given
    const workspace = await tempWorkspace();
    const dataDir = path.join(workspace.root, ".strongcode");
    const sessionsDir = path.join(dataDir, "sessions");
    const externalFile = path.join(workspace.root, "external.jsonl");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(externalFile, `${JSON.stringify(LEGACY_EVENT)}\n`, "utf8");
    if (!await createLink(externalFile, path.join(sessionsDir, "linked.jsonl"), "file")) return;

    // When
    const result = await new SessionStore(dataDir).list();

    // Then
    expect(result.ok).toBe(false);
  });

  it("rejects non-regular JSONL entries while listing", async () => {
    // Given
    const workspace = await tempWorkspace();
    const dataDir = path.join(workspace.root, ".strongcode");
    await mkdir(path.join(dataDir, "sessions", "directory.jsonl"), { recursive: true });

    // When
    const result = await new SessionStore(dataDir).list();

    // Then
    expect(result.ok).toBe(false);
  });

  it("rejects session filenames that cannot be safely addressed", async () => {
    // Given
    const workspace = await tempWorkspace();
    const dataDir = path.join(workspace.root, ".strongcode");
    const sessionsDir = path.join(dataDir, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(path.join(sessionsDir, "unsafe name.jsonl"), `${JSON.stringify(LEGACY_EVENT)}\n`, "utf8");

    // When
    const result = await new SessionStore(dataDir).list();

    // Then
    expect(result.ok).toBe(false);
  });

  it("serializes large concurrent appends from separate store instances into complete lines", async () => {
    // Given
    const workspace = await tempWorkspace();
    const dataDir = path.join(workspace.root, ".strongcode");
    const stores = [new SessionStore(dataDir), new SessionStore(dataDir)];
    const contents = Array.from({ length: 8 }, (_, index) => `${index}:${"x".repeat(700_000)}`);

    // When
    const results = await Promise.all(contents.map((content, index) => stores[index % stores.length].append("concurrent", messageEvent("assistant", content))));

    // Then
    expect(results.every(result => result.ok)).toBe(true);
    const source = await readFile(path.join(dataDir, "sessions", "concurrent.jsonl"), "utf8");
    const lines = source.trimEnd().split("\n");
    expect(lines).toHaveLength(contents.length);
    expect(lines.map(line => JSON.parse(line).content).sort()).toEqual([...contents].sort());
  });

  it("keeps reads valid when another store starts a large append", async () => {
    // Given
    const workspace = await tempWorkspace();
    const dataDir = path.join(workspace.root, ".strongcode");
    const reader = new SessionStore(dataDir);
    const writer = new SessionStore(dataDir);
    await writer.append("read-race", messageEvent("user", "initial"));

    // When
    const reads = Array.from({ length: 8 }, () => reader.read("read-race"));
    const writes = Array.from({ length: 8 }, (_, index) => writer.append("read-race", messageEvent("assistant", `${index}:${"x".repeat(700_000)}`)));
    const [readResults, writeResults] = await Promise.all([Promise.all(reads), Promise.all(writes)]);

    // Then
    expect(writeResults.every(result => result.ok)).toBe(true);
    expect(readResults.every(result => result.ok)).toBe(true);
  });

  it("separates a legacy final line before appending a new event", async () => {
    // Given
    const workspace = await tempWorkspace();
    const dataDir = path.join(workspace.root, ".strongcode");
    const sessionsDir = path.join(dataDir, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(path.join(sessionsDir, "legacy.jsonl"), JSON.stringify(LEGACY_EVENT), "utf8");
    const store = new SessionStore(dataDir);

    // When
    const appended = await store.append("legacy", messageEvent("user", "new"));

    // Then
    expect(appended.ok).toBe(true);
    const read = await store.read("legacy");
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.events.map(event => event.type === "message" ? event.content : event.type)).toEqual(["legacy", "new"]);
      expect("agentId" in read.value.events[0]).toBe(false);
    }
  });

  it.skipIf(process.platform === "win32")("creates private session directories and files", async () => {
    // Given
    const workspace = await tempWorkspace();
    const dataDir = path.join(workspace.root, ".strongcode");
    const store = new SessionStore(dataDir);

    // When
    const result = await store.append("private", messageEvent("user", "secret"));

    // Then
    expect(result.ok).toBe(true);
    expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(dataDir, "sessions"))).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(dataDir, "sessions", "private.jsonl"))).mode & 0o777).toBe(0o600);
  });

  it("returns SESSION_ERROR for malformed persisted JSONL", async () => {
    // Given
    const workspace = await tempWorkspace();
    const dataDir = path.join(workspace.root, ".strongcode");
    const sessionsDir = path.join(dataDir, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(path.join(sessionsDir, "malformed.jsonl"), "{bad-json}\n", "utf8");

    // When
    const result = await new SessionStore(dataDir).read("malformed");

    // Then
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SESSION_ERROR");
  });

  it("lists no sessions without creating a missing store", async () => {
    // Given
    const workspace = await tempWorkspace();
    const dataDir = path.join(workspace.root, ".strongcode");

    // When
    const result = await new SessionStore(dataDir).list();

    // Then
    expect(result).toEqual({ ok: true, value: [] });
    await expect(lstat(dataDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
