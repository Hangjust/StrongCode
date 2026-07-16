import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionFileSecurity } from "../src/sessions/session-file-security";
import { SessionStore } from "../src/sessions/session-store";
import { messageEvent } from "../src/sessions/session";
import { tempWorkspace } from "./helpers";

type AncestorFixture = {
  readonly dataDir: string;
  readonly externalDir: string;
  readonly sentinelPath: string;
};

async function ancestorFixture(withSession: boolean): Promise<AncestorFixture> {
  const workspace = await tempWorkspace();
  const externalDir = path.join(workspace.root, "external");
  const linkedAncestor = path.join(workspace.root, "linked-ancestor");
  const dataDir = path.join(linkedAncestor, "nested-data");
  const sentinelPath = path.join(externalDir, "sentinel.bin");
  await mkdir(externalDir);
  await writeFile(sentinelPath, Buffer.from([0, 1, 2, 255]));
  if (withSession) {
    const sessionsDir = path.join(externalDir, "nested-data", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      path.join(sessionsDir, "visible.jsonl"),
      `${JSON.stringify(messageEvent("assistant", "external"))}\n`,
      "utf8"
    );
  }
  await symlink(externalDir, linkedAncestor, process.platform === "win32" ? "junction" : "dir");
  return { dataDir, externalDir, sentinelPath };
}

async function externalState(fixture: AncestorFixture): Promise<{
  readonly hash: string;
  readonly listing: readonly string[];
}> {
  const bytes = await readFile(fixture.sentinelPath);
  const listing = await readdir(fixture.externalDir, { recursive: true });
  return {
    hash: createHash("sha256").update(bytes).digest("hex"),
    listing: listing.sort((left, right) => left.localeCompare(right))
  };
}

describe("session store ancestor security", () => {
  it("rejects append below a junction or symlink ancestor before external creation", async () => {
    // Given
    const fixture = await ancestorFixture(false);
    const before = await externalState(fixture);

    // When
    const result = await new SessionStore(fixture.dataDir)
      .append("escaped", messageEvent("user", "blocked"));

    // Then
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SESSION_ERROR");
    expect(await externalState(fixture)).toEqual(before);
  });

  it.each([
    ["read", (store: SessionStore) => store.read("visible")],
    ["readOrEmpty", (store: SessionStore) => store.readOrEmpty("visible")],
    ["list", (store: SessionStore) => store.list()]
  ] as const)("rejects %s below a junction or symlink ancestor without external reads", async (_name, operation) => {
    // Given
    const fixture = await ancestorFixture(true);
    const before = await externalState(fixture);

    // When
    const result = await operation(new SessionStore(fixture.dataDir));

    // Then
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SESSION_ERROR");
    expect(await externalState(fixture)).toEqual(before);
  });

  it("rejects payload writing after a captured directory identity is replaced", async () => {
    // Given
    const workspace = await tempWorkspace();
    const trustedParent = path.join(workspace.root, "trusted-parent");
    const dataDir = path.join(trustedParent, "data");
    const security = new SessionFileSecurity(dataDir);
    const directories = await security.prepareStoreForWrite();
    await rename(trustedParent, path.join(workspace.root, "displaced-parent"));
    await mkdir(path.join(dataDir, "sessions"), { recursive: true });
    const filePath = path.join(dataDir, "sessions", "replaced.jsonl");
    await writeFile(filePath, "original", "utf8");
    await expect(security.readSecuredFile(filePath, directories))
      .rejects.toMatchObject({ code: "SESSION_ERROR" });
    const handle = await open(filePath, "a+");

    // When
    try {
      const write = async (): Promise<void> => {
        await security.assertHandleIdentity(handle, filePath, directories);
        await handle.writeFile("payload", "utf8");
      };

      // Then
      await expect(write()).rejects.toMatchObject({ code: "SESSION_ERROR" });
    } finally {
      await handle.close();
    }
    expect(await readFile(filePath, "utf8")).toBe("original");
  });

  it("preserves concurrent first appends to different session files", async () => {
    // Given
    const workspace = await tempWorkspace();
    const stores = Array.from({ length: 8 }, () => new SessionStore(path.join(workspace.root, "data")));

    // When
    const results = await Promise.all(stores.map((store, index) => (
      store.append(`session-${index}`, messageEvent("user", `${index}`))
    )));

    // Then
    expect(results.every(result => result.ok)).toBe(true);
  });
});
