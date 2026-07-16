import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionStore } from "../src/sessions/session-store";
import {
  conversationItemEvent,
  eventsToConversationItems,
  eventsToMessages,
  eventsToModelConversationItems,
  messageEvent
} from "../src/sessions/session";
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

  it("reads legacy message JSONL without treating it as agent provenance", async () => {
    // Given
    const workspace = await tempWorkspace();
    const dataDir = path.join(workspace.root, ".strongcode");
    const sessionsDir = path.join(dataDir, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(path.join(sessionsDir, "legacy.jsonl"), [
      JSON.stringify({
        type: "message",
        timestamp: "2026-07-14T00:00:00.000Z",
        role: "assistant",
        content: "Legacy plan text"
      }),
      JSON.stringify({
        type: "tool",
        timestamp: "2026-07-14T00:00:01.000Z",
        tool: "read_file",
        input: { path: "README.md" },
        output: "Legacy tool output"
      }),
      ""
    ].join("\n"), "utf8");

    // When
    const result = await new SessionStore(dataDir).read("legacy");

    // Then
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(eventsToMessages(result.value.events)).toEqual([
        { role: "assistant", content: "Legacy plan text" },
        { role: "tool", content: "Legacy tool output" }
      ]);
      expect(eventsToConversationItems(result.value.events)).toEqual([
        { type: "text", role: "assistant", content: "Legacy plan text" },
        { type: "text", role: "tool", content: "Legacy tool output" }
      ]);
      expect(eventsToModelConversationItems(result.value.events)).toEqual([
        { type: "text", role: "assistant", content: "Legacy plan text" }
      ]);
    }
  });

  it("preserves correlated items for provider replay and rejects dangling calls", () => {
    // Given
    const call = conversationItemEvent({
      type: "tool_call",
      role: "assistant",
      callId: "call-session-1",
      name: "read_file",
      input: { path: "README.md" }
    });
    const result = conversationItemEvent({
      type: "tool_result",
      role: "tool",
      callId: "call-session-1",
      content: "fixture",
      isError: false
    });

    // When / Then
    expect(eventsToModelConversationItems([call, result])).toEqual([call.item, result.item]);
    expect(() => eventsToModelConversationItems([call])).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  });

  it("rejects unsafe session ids", async () => {
    const workspace = await tempWorkspace();
    const store = new SessionStore(path.join(workspace.root, ".strongcode"));

    const result = await store.append("../outside", messageEvent("user", "bad"));

    expect(result.ok).toBe(false);
  });
});
