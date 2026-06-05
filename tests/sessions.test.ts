import { readFile } from "node:fs/promises";
import path from "node:path";
import { SessionStore } from "../src/sessions/session-store";
import { messageEvent } from "../src/sessions/session";
import { tempWorkspace } from "./helpers";

describe("sessions", () => {
  it("persists events as JSONL under dataDir/sessions", async () => {
    const workspace = await tempWorkspace();
    const store = new SessionStore(path.join(workspace.root, ".strongcode"));

    const appended = await store.append("demo", messageEvent("user", "hello"));
    const session = await store.read("demo");
    const file = await readFile(path.join(workspace.root, ".strongcode", "sessions", "demo.jsonl"), "utf8");

    expect(appended.ok).toBe(true);
    expect(session.ok).toBe(true);
    expect(file.trim()).toContain("hello");
    if (session.ok) {
      expect(session.value.events).toHaveLength(1);
    }
  });

  it("rejects unsafe session ids", async () => {
    const workspace = await tempWorkspace();
    const store = new SessionStore(path.join(workspace.root, ".strongcode"));

    const result = await store.append("../outside", messageEvent("user", "bad"));

    expect(result.ok).toBe(false);
  });
});
