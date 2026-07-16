import { link, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionStore } from "../src/sessions/session-store";
import { creation, ledgerEvent, lifecycle, reservation, succeeded, usage } from "./session-ledger-fixtures";
import { tempWorkspace } from "./helpers";

describe("SessionStore ledger CAS", () => {
  it("selects one durable owner across concurrent distinct stores", async () => {
    // Given
    const workspace = await tempWorkspace();
    const stores = [new SessionStore(workspace.context.dataDir), new SessionStore(workspace.context.dataDir)];

    // When
    const results = await Promise.all([
      stores[0]?.reserveFirstSummary("session", { sourceMessageId: "source-a", originalPrompt: "alpha" }),
      stores[1]?.reserveFirstSummary("session", { sourceMessageId: "source-b", originalPrompt: "beta" })
    ]);

    // Then
    expect(results.filter(result => result?.ok && result.value.kind === "reserved")).toHaveLength(1);
    expect(results.filter(result => result?.ok && result.value.kind === "rejected")).toHaveLength(1);
    const session = await stores[0]?.read("session");
    expect(session?.ok && session.value.events.filter(event => event.type === "summary_reserved")).toHaveLength(1);
  });

  it("returns one reservation and one existing outcome for the same exact source bytes", async () => {
    const workspace = await tempWorkspace();
    const input = { sourceMessageId: "source", originalPrompt: "  exact bytes  " };
    const [first, second] = await Promise.all([
      new SessionStore(workspace.context.dataDir).reserveFirstSummary("same", input),
      new SessionStore(workspace.context.dataDir).reserveFirstSummary("same", input)
    ]);
    expect([first, second].map(result => result.ok ? result.value.kind : "error").sort()).toEqual(["existing", "reserved"]);
    if (!first.ok || !second.ok || first.value.kind === "ignored-empty" || first.value.kind === "rejected"
      || second.value.kind === "ignored-empty" || second.value.kind === "rejected") throw new Error("reservation failed");
    expect(first.value.reservationId).toBe(second.value.reservationId);
    const source = await readFile(path.join(workspace.context.dataDir, "sessions", "same.jsonl"), "utf8");
    expect(source).toContain('"originalPrompt":"  exact bytes  "');
  });

  it("ignores whitespace and rejects changed bytes or prior meaningful user history", async () => {
    const workspace = await tempWorkspace();
    const store = new SessionStore(workspace.context.dataDir);
    expect(await store.reserveFirstSummary("empty", { sourceMessageId: "empty", originalPrompt: " \t\n" }))
      .toEqual({ ok: true, value: { kind: "ignored-empty" } });
    expect((await store.read("empty")).ok).toBe(false);
    await store.reserveFirstSummary("owned", { sourceMessageId: "source", originalPrompt: "first" });
    expect(await store.reserveFirstSummary("owned", { sourceMessageId: "source", originalPrompt: "changed" }))
      .toMatchObject({ ok: true, value: { kind: "rejected", reason: "owned-by-another-source" } });
    await store.append("history", {
      type: "message", timestamp: "2026-07-15T00:00:00.000Z", role: "user", content: "prior"
    });
    expect(await store.reserveFirstSummary("history", { sourceMessageId: "source", originalPrompt: "new" }))
      .toMatchObject({ ok: true, value: { kind: "rejected", reason: "history-already-started" } });
    await store.append("item-history", {
      type: "conversation_item",
      timestamp: "2026-07-15T00:00:00.000Z",
      item: { type: "text", role: "user", content: "prior item" }
    });
    expect(await store.reserveFirstSummary("item-history", { sourceMessageId: "source", originalPrompt: "new" }))
      .toMatchObject({ ok: true, value: { kind: "rejected", reason: "history-already-started" } });
  });

  it("commits, deduplicates, and rejects divergent events without changing bytes", async () => {
    const workspace = await tempWorkspace();
    const store = new SessionStore(workspace.context.dataDir);
    const created = creation("attempt-flash");
    expect(await store.commitLedgerEvent("ledger", created)).toEqual({ ok: true, value: { kind: "committed" } });
    const filePath = path.join(workspace.context.dataDir, "sessions", "ledger.jsonl");
    const beforeDuplicate = await readFile(filePath);
    expect(await store.commitLedgerEvent("ledger", created)).toEqual({ ok: true, value: { kind: "duplicate" } });
    expect(await readFile(filePath)).toEqual(beforeDuplicate);
    const divergent = ledgerEvent("attempt_created", "create-attempt-flash-other", {
      attemptId: created.attemptId,
      logicalOperationId: created.logicalOperationId,
      role: created.role,
      model: { ...created.model, providerRef: "other" },
      ...(created.context === undefined ? {} : { context: created.context })
    });
    if (divergent.type !== "attempt_created") throw new Error("creation fixture type mismatch");
    expect(await store.commitLedgerEvent("ledger", divergent)).toMatchObject({
      ok: true, value: { kind: "rejected", reason: "semantic-conflict" }
    });
    expect(await readFile(filePath)).toEqual(beforeDuplicate);
  });

  it("persists every non-reservation ledger event through projection-aware commit", async () => {
    const workspace = await tempWorkspace();
    const store = new SessionStore(workspace.context.dataDir);
    await store.reserveFirstSummary("committed", { sourceMessageId: "source", originalPrompt: "prompt" });
    const committedSession = await store.read("committed");
    if (!committedSession.ok) throw committedSession.error;
    const reserved = committedSession.value.events.find(event => event.type === "summary_reserved");
    if (reserved?.type !== "summary_reserved") throw new Error("reservation missing");
    for (const event of [
      creation("attempt-flash", { logicalOperationId: reserved.logicalOperationId }),
      ...succeeded("attempt-flash"),
      usage("attempt-flash", 0.01)
    ]) {
      expect(await store.commitLedgerEvent("committed", event)).toMatchObject({ ok: true, value: { kind: "committed" } });
    }
    const summaryCommit = ledgerEvent("summary_committed", "summary-commit", {
      reservationId: reserved.reservationId,
      attemptId: "attempt-flash",
      result: { title: "Title", generalSummary: "Summary", requestedItems: [] }
    });
    if (summaryCommit.type !== "summary_committed") throw new Error("commit fixture type mismatch");
    expect(await store.commitLedgerEvent("committed", summaryCommit))
      .toMatchObject({ ok: true, value: { kind: "committed" } });

    for (const [sessionId, type] of [["failed", "summary_failed_open"], ["cancelled", "summary_cancelled"]] as const) {
      await store.reserveFirstSummary(sessionId, { sourceMessageId: sessionId, originalPrompt: sessionId });
      const snapshot = await store.read(sessionId);
      if (!snapshot.ok) throw snapshot.error;
      const owner = snapshot.value.events.find(event => event.type === "summary_reserved");
      if (owner?.type !== "summary_reserved") throw new Error("reservation missing");
      const terminal = ledgerEvent(type, `${sessionId}-event`, {
        reservationId: owner.reservationId,
        reasonCode: sessionId === "failed" ? "route_exhausted" : "user_cancelled"
      });
      if (terminal.type === "summary_reserved") throw new Error("terminal fixture type mismatch");
      expect(await store.commitLedgerEvent(sessionId, terminal))
        .toMatchObject({ ok: true, value: { kind: "committed" } });
    }
  });

  it("runtime-rejects ledger events passed through the public conversation append", async () => {
    const workspace = await tempWorkspace();
    const store = new SessionStore(workspace.context.dataDir);
    const result = await Reflect.apply(store.append, store, ["bypass", reservation()]);
    expect(result).toMatchObject({ ok: false, error: { code: "SESSION_ERROR" } });
    expect((await store.read("bypass")).ok).toBe(false);
  });

  it("rejects stale lifecycle, lineage, and duplicate usage inside the queued snapshot", async () => {
    const workspace = await tempWorkspace();
    const store = new SessionStore(workspace.context.dataDir);
    await store.commitLedgerEvent("state", creation("attempt-flash"));
    expect(await store.commitLedgerEvent("state", lifecycle("attempt-flash", "end", {
      kind: "ended", outcome: "succeeded"
    }))).toMatchObject({ ok: true, value: { kind: "rejected", reason: "invalid-transition" } });
    expect(await store.commitLedgerEvent("state", creation("child", { parentAttemptId: "missing" })))
      .toMatchObject({ ok: true, value: { kind: "rejected", reason: "invalid-lineage" } });
    const direct = usage("attempt-flash", 0.01);
    expect(await store.commitLedgerEvent("state", direct)).toMatchObject({ ok: true, value: { kind: "committed" } });
    expect(await store.commitLedgerEvent("state", usage("attempt-flash", 0.02, {}, "retry")))
      .toMatchObject({ ok: true, value: { kind: "rejected", reason: "semantic-conflict" } });
  });

  it("rejects malformed persisted tails before ledger append and preserves bytes", async () => {
    const workspace = await tempWorkspace();
    const sessionsDir = path.join(workspace.context.dataDir, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, "torn.jsonl");
    await writeFile(filePath, `${JSON.stringify(reservation())}\n{\"type\":`, "utf8");
    const before = await readFile(filePath);
    expect((await new SessionStore(workspace.context.dataDir).commitLedgerEvent("torn", creation("attempt"))).ok).toBe(false);
    expect(await readFile(filePath)).toEqual(before);
  });

  it("validates complete lineage on read, readOrEmpty, and checkpoint source reads", async () => {
    const workspace = await tempWorkspace();
    const sessionsDir = path.join(workspace.context.dataDir, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(path.join(sessionsDir, "cycle.jsonl"), [
      JSON.stringify(creation("a", { parentAttemptId: "b" })),
      JSON.stringify(creation("b", { parentAttemptId: "a" })),
      ""
    ].join("\n"), "utf8");
    const store = new SessionStore(workspace.context.dataDir);
    const results = await Promise.all([
      store.read("cycle"), store.readOrEmpty("cycle"), store.readForCompaction("cycle")
    ]);
    expect(results.every(result => !result.ok && result.error.code === "SESSION_ERROR")).toBe(true);
  });

  it("uses the existing hard-link defense for reservation writes", async () => {
    const workspace = await tempWorkspace();
    const sessionsDir = path.join(workspace.context.dataDir, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const external = path.join(workspace.root, "external.jsonl");
    await writeFile(external, `${JSON.stringify(reservation())}\n`, "utf8");
    await link(external, path.join(sessionsDir, "linked.jsonl"));
    const before = await readFile(external);
    const result = await new SessionStore(workspace.context.dataDir)
      .reserveFirstSummary("linked", { sourceMessageId: "other", originalPrompt: "blocked" });
    expect(result.ok).toBe(false);
    expect(await readFile(external)).toEqual(before);
  });
});
