import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { StrongCodeError } from "../src/core/errors";
import type { Result } from "../src/core/result";
import type { ConversationItem } from "../src/core/types";
import { buildCompactionReplacement, COMPACTION_SUMMARY_PREFIX } from "../src/sessions/compaction";
import { SessionStore } from "../src/sessions/session-store";
import {
  compactionCheckpointEvent,
  conversationItemEvent,
  eventsToConversationItems,
  eventsToMessages,
  messageEvent,
  parseSessionEvent,
  type ConversationSessionEvent,
  type SessionEvent
} from "../src/sessions/session";
import { tempWorkspace } from "./helpers";

function valueOf<T>(result: Result<T>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

function validationError(action: () => unknown): StrongCodeError {
  try {
    action();
  } catch (error) {
    if (error instanceof StrongCodeError) return error;
    throw error;
  }
  throw new StrongCodeError("VALIDATION_ERROR", "Expected validation to fail");
}

function summary(body: string): string {
  return `${COMPACTION_SUMMARY_PREFIX}\n${body}`;
}

function checkpointWith(items: readonly ConversationItem[]): readonly ConversationSessionEvent[] {
  const checkpointSummary = summary("Continue safely.");
  return [
    compactionCheckpointEvent("newton", checkpointSummary, [
      { type: "text", role: "user", content: checkpointSummary }
    ]),
    ...items.map(item => conversationItemEvent(item, "newton"))
  ];
}

async function roundTrip(events: readonly ConversationSessionEvent[]): Promise<readonly SessionEvent[]> {
  const workspace = await tempWorkspace();
  const store = new SessionStore(path.join(workspace.root, ".strongcode"));
  for (const event of events) valueOf(await store.append("compacted", event));
  return valueOf(await store.read("compacted")).events;
}

describe("durable session compaction checkpoints", () => {
  it("round-trips append-only raw events while projecting replacement and later history", async () => {
    // Given
    const workspace = await tempWorkspace();
    const store = new SessionStore(path.join(workspace.root, ".strongcode"));
    const replacement = buildCompactionReplacement([
      { type: "text", role: "user", content: "retained request" }
    ], "Completed the old work.");
    const sourceHistory = Object.freeze(replacement.replacementHistory.map(item => Object.freeze({ ...item })));
    const checkpoint = compactionCheckpointEvent("newton", replacement.summary, sourceHistory);
    const events = [
      messageEvent("user", "obsolete request", "tesla"),
      checkpoint,
      messageEvent("assistant", "new response", "newton")
    ];

    // When
    for (const event of events) valueOf(await store.append("compacted", event));
    const session = valueOf(await store.read("compacted"));

    // Then
    expect(session.events).toHaveLength(3);
    expect(session.events.map(event => event.type)).toEqual([
      "message",
      "compaction_checkpoint",
      "message"
    ]);
    expect(eventsToConversationItems(session.events)).toEqual([
      ...sourceHistory,
      { type: "text", role: "assistant", content: "new response" }
    ]);
    expect(eventsToMessages(session.events)).toEqual([
      ...sourceHistory.map(item => ({ role: item.role, content: item.content })),
      { role: "assistant", content: "new response" }
    ]);
    expect(sourceHistory).toEqual(replacement.replacementHistory);
    expect(checkpoint.replacementHistory[0]).not.toBe(sourceHistory[0]);
    expect(session.events[1]).not.toBe(events[1]);
  });

  it("uses the latest checkpoint when several checkpoints are persisted", async () => {
    // Given
    const firstSummary = summary("First state.");
    const secondSummary = summary("Latest state.");
    const events = [
      messageEvent("user", "discarded"),
      compactionCheckpointEvent("tesla", firstSummary, [
        { type: "text", role: "user", content: firstSummary }
      ]),
      messageEvent("assistant", "also discarded"),
      compactionCheckpointEvent("newton", secondSummary, [
        { type: "text", role: "user", content: secondSummary }
      ]),
      messageEvent("user", "after latest")
    ];

    // When
    const projected = eventsToConversationItems(await roundTrip(events));

    // Then
    expect(projected).toEqual([
      { type: "text", role: "user", content: secondSummary },
      { type: "text", role: "user", content: "after latest" }
    ]);
  });

  it("preserves one complete post-checkpoint tool pair", async () => {
    // Given
    const events = checkpointWith([
      { type: "tool_call", role: "assistant", callId: "call-1", name: "read_file", input: { path: "README.md" } },
      { type: "tool_result", role: "tool", callId: "call-1", content: "StrongCode", isError: false }
    ]);

    // When
    const projected = eventsToConversationItems(await roundTrip(events));

    // Then
    expect(projected.slice(-2)).toEqual([
      { type: "tool_call", role: "assistant", callId: "call-1", name: "read_file", input: { path: "README.md" } },
      { type: "tool_result", role: "tool", callId: "call-1", content: "StrongCode", isError: false }
    ]);
  });

  it.each([
    {
      label: "orphan result",
      items: [{ type: "tool_result", role: "tool", callId: "orphan", content: "bad", isError: false }]
    },
    {
      label: "duplicate call ID",
      items: [
        { type: "tool_call", role: "assistant", callId: "duplicate", name: "read_file", input: {} },
        { type: "tool_call", role: "assistant", callId: "duplicate", name: "read_file", input: {} },
        { type: "tool_result", role: "tool", callId: "duplicate", content: "bad", isError: false }
      ]
    },
    {
      label: "duplicate result ID",
      items: [
        { type: "tool_call", role: "assistant", callId: "duplicate", name: "read_file", input: {} },
        { type: "tool_result", role: "tool", callId: "duplicate", content: "first", isError: false },
        { type: "tool_result", role: "tool", callId: "duplicate", content: "second", isError: false }
      ]
    },
    {
      label: "dangling call",
      items: [{ type: "tool_call", role: "assistant", callId: "dangling", name: "read_file", input: {} }]
    }
  ] satisfies readonly { readonly label: string; readonly items: readonly ConversationItem[] }[])(
    "rejects a $label after a checkpoint",
    ({ items }) => {
      // Given
      const events = checkpointWith(items);

      // When
      const error = validationError(() => eventsToConversationItems(events));

      // Then
      expect(error.code).toBe("VALIDATION_ERROR");
    }
  );

  it("keeps legacy in-progress projections unchanged without a checkpoint", () => {
    // Given
    const danglingCall = conversationItemEvent({
      type: "tool_call",
      role: "assistant",
      callId: "still-running",
      name: "read_file",
      input: {}
    });

    // When
    const projected = eventsToConversationItems([messageEvent("user", "legacy"), danglingCall]);

    // Then
    expect(projected).toEqual([
      { type: "text", role: "user", content: "legacy" },
      danglingCall.item
    ]);
  });

  it.each([
    { agentId: "", checkpointSummary: summary("State."), history: [{ type: "text", role: "user", content: summary("State.") }] },
    { agentId: "newton", checkpointSummary: "unprefixed", history: [{ type: "text", role: "user", content: "unprefixed" }] },
    { agentId: "newton", checkpointSummary: summary("State."), history: [] },
    { agentId: "newton", checkpointSummary: summary("State."), history: [{ type: "text", role: "assistant", content: summary("State.") }] },
    { agentId: "newton", checkpointSummary: summary("State."), history: [{ type: "text", role: "user", content: "wrong final item" }] },
    {
      agentId: "newton",
      checkpointSummary: summary("State."),
      history: [
        { type: "text", role: "user", content: summary("Prior.") },
        { type: "text", role: "user", content: summary("State.") }
      ]
    }
  ] satisfies readonly {
    readonly agentId: string;
    readonly checkpointSummary: string;
    readonly history: readonly ConversationItem[];
  }[])("rejects malformed checkpoint factory input %#", ({ agentId, checkpointSummary, history }) => {
    // Given / When
    const error = validationError(() => compactionCheckpointEvent(agentId, checkpointSummary, history));

    // Then
    expect(error.code).toBe("VALIDATION_ERROR");
  });

  it.each([
    { label: "empty", body: "" },
    { label: "spaces", body: "   " },
    { label: "tabs", body: "\t\t" },
    { label: "newlines", body: "\n\n" }
  ])("rejects a $label checkpoint summary body through the factory", ({ body }) => {
    // Given
    const checkpointSummary = `${COMPACTION_SUMMARY_PREFIX}\n${body}`;

    // When
    const error = validationError(() => compactionCheckpointEvent("newton", checkpointSummary, [
      { type: "text", role: "user", content: checkpointSummary }
    ]));

    // Then
    expect(error.code).toBe("VALIDATION_ERROR");
  });

  it.each([
    { label: "empty", body: "", sessionId: "empty-summary" },
    { label: "spaces", body: "   ", sessionId: "space-summary" },
    { label: "tabs", body: "\t\t", sessionId: "tab-summary" },
    { label: "newlines", body: "\n\n", sessionId: "newline-summary" }
  ])("rejects a persisted $label checkpoint summary body", async ({ body, sessionId }) => {
    // Given
    const workspace = await tempWorkspace();
    const dataDir = path.join(workspace.root, ".strongcode");
    const sessionsDir = path.join(dataDir, "sessions");
    const checkpointSummary = `${COMPACTION_SUMMARY_PREFIX}\n${body}`;
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(path.join(sessionsDir, `${sessionId}.jsonl`), `${JSON.stringify({
      type: "compaction_checkpoint",
      timestamp: "2026-07-14T00:00:00.000Z",
      agentId: "newton",
      summary: checkpointSummary,
      replacementHistory: [{ type: "text", role: "user", content: checkpointSummary }]
    })}\n`, "utf8");

    // When
    const result = await new SessionStore(dataDir).read(sessionId);

    // Then
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SESSION_ERROR");
  });

  it("rejects a malformed persisted checkpoint through the real store", async () => {
    // Given
    const workspace = await tempWorkspace();
    const dataDir = path.join(workspace.root, ".strongcode");
    const sessionsDir = path.join(dataDir, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(path.join(sessionsDir, "malformed.jsonl"), `${JSON.stringify({
      type: "compaction_checkpoint",
      timestamp: "2026-07-14T00:00:00.000Z",
      agentId: "newton",
      summary: summary("State."),
      replacementHistory: [{ type: "text", role: "system", content: summary("State.") }]
    })}\n`, "utf8");

    // When
    const result = await new SessionStore(dataDir).read("malformed");

    // Then
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SESSION_ERROR");
  });

  it("parses persisted checkpoints into cloned validated history", () => {
    // Given
    const checkpointSummary = summary("Resume here.");
    const source = JSON.stringify({
      type: "compaction_checkpoint",
      timestamp: "2026-07-14T00:00:00.000Z",
      agentId: "newton",
      summary: checkpointSummary,
      replacementHistory: [{ type: "text", role: "user", content: checkpointSummary }]
    });

    // When
    const event = parseSessionEvent(source);

    // Then
    expect(event).toMatchObject({ type: "compaction_checkpoint", agentId: "newton", summary: checkpointSummary });
  });
});
