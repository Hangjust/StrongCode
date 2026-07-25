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

const INTERRUPTED_TOOL_RESULT_CONTENT = "Tool execution was interrupted before a result was recorded; its outcome is unknown and StrongCode will not retry it automatically.";

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

  it("preserves complete items and recovers dangling calls for provider replay", () => {
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
    const danglingCall = conversationItemEvent({
      type: "tool_call",
      role: "assistant",
      callId: "call-session-2",
      name: "mcp_call",
      input: { serverId: "open_computer_use", toolName: "screenshot", arguments: {} }
    });

    // When
    const completeProjection = eventsToModelConversationItems([call, result]);
    const recoveredProjection = eventsToModelConversationItems([call, result, danglingCall]);

    // Then
    expect(completeProjection).toEqual([call.item, result.item]);
    expect(recoveredProjection).toEqual([
      call.item,
      result.item,
      danglingCall.item,
      {
        type: "tool_result",
        role: "tool",
        callId: "call-session-2",
        content: INTERRUPTED_TOOL_RESULT_CONTENT,
        isError: true
      }
    ]);
  });

  it("does not append events or alter raw JSONL when recovering provider replay", async () => {
    // Given
    const workspace = await tempWorkspace();
    const dataDir = path.join(workspace.root, ".strongcode");
    const sessionPath = path.join(dataDir, "sessions", "incident.jsonl");
    const store = new SessionStore(dataDir);
    const events = [
      messageEvent("user", "Inspect the workspace"),
      conversationItemEvent({
        type: "tool_call",
        role: "assistant",
        callId: "call-complete",
        name: "list_files",
        input: { path: "." }
      }),
      conversationItemEvent({
        type: "tool_result",
        role: "tool",
        callId: "call-complete",
        content: "README.md",
        isError: false
      }),
      conversationItemEvent({
        type: "tool_call",
        role: "assistant",
        callId: "call-interrupted",
        name: "mcp_call",
        input: { serverId: "open_computer_use", toolName: "screenshot", arguments: {} }
      })
    ];
    for (const event of events) {
      const appended = await store.append("incident", event);
      expect(appended.ok).toBe(true);
    }
    const before = await store.read("incident");
    expect(before.ok).toBe(true);
    if (!before.ok) throw before.error;
    const eventsBefore = structuredClone(before.value.events);
    const jsonlBefore = await readFile(sessionPath);

    // When
    const projection = eventsToModelConversationItems(before.value.events);

    // Then
    const after = await store.read("incident");
    expect(after.ok).toBe(true);
    if (!after.ok) throw after.error;
    expect(projection.at(-1)).toEqual({
      type: "tool_result",
      role: "tool",
      callId: "call-interrupted",
      content: INTERRUPTED_TOOL_RESULT_CONTENT,
      isError: true
    });
    expect(after.value.events).toEqual(eventsBefore);
    expect(after.value.events).toHaveLength(events.length);
    expect(await readFile(sessionPath)).toEqual(jsonlBefore);
  });

  it("rejects unsafe session ids", async () => {
    const workspace = await tempWorkspace();
    const store = new SessionStore(path.join(workspace.root, ".strongcode"));

    const result = await store.append("../outside", messageEvent("user", "bad"));

    expect(result.ok).toBe(false);
  });
});
