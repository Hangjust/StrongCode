import { readFile } from "node:fs/promises";
import path from "node:path";
import { messageEvent } from "../src/sessions/session";
import { SessionStore } from "../src/sessions/session-store";
import { tempWorkspace } from "./helpers";

describe("SessionStore guarded commit", () => {
  it("rejects a guarded append without changing existing JSONL bytes", async () => {
    // Given
    const workspace = await tempWorkspace();
    const store = new SessionStore(workspace.context.dataDir);
    const initial = await store.append("guarded", messageEvent("user", "initial"));
    if (!initial.ok) throw initial.error;
    const filePath = path.join(workspace.context.dataDir, "sessions", "guarded.jsonl");
    const before = await readFile(filePath);

    // When
    const result = await store.commitGuarded(
      "guarded",
      messageEvent("assistant", "must not persist"),
      () => false
    );

    // Then
    expect(result).toEqual({ ok: true, value: { kind: "rejected" } });
    expect(await readFile(filePath)).toEqual(before);
  });

  it("commits an allowed append through the ordinary secure write path", async () => {
    // Given
    const workspace = await tempWorkspace();
    const store = new SessionStore(workspace.context.dataDir);

    // When
    const result = await store.commitGuarded(
      "guarded-success",
      messageEvent("assistant", "persisted"),
      () => true
    );

    // Then
    expect(result).toEqual({ ok: true, value: { kind: "committed" } });
    const stored = await store.read("guarded-success");
    if (!stored.ok) throw stored.error;
    expect(stored.value.events).toContainEqual(expect.objectContaining({ content: "persisted" }));
  });

  it("runs a no-event guard inside the per-session queue without creating a record", async () => {
    // Given
    const workspace = await tempWorkspace();
    const store = new SessionStore(workspace.context.dataDir);

    // When
    const result = await store.commitGuarded("barrier", undefined, () => true);

    // Then
    expect(result).toEqual({ ok: true, value: { kind: "committed" } });
    expect((await store.read("barrier")).ok).toBe(false);
  });
});
