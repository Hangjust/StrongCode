import { describe, expect, it } from "vitest";
import { summaryFailedOpenEvent } from "../src/sessions/session-ledger-events";
import { SessionStore } from "../src/sessions/session-store";
import { tempWorkspace } from "./helpers";

describe("SessionStore guarded ledger commit", () => {
  it("rejects a stale terminal append at the secure write boundary without persisting it", async () => {
    const workspace = await tempWorkspace();
    const store = new SessionStore(workspace.context.dataDir);
    const reserved = await store.reserveFirstSummary("guarded-ledger", {
      sourceMessageId: "source",
      originalPrompt: "prompt"
    });
    if (!reserved.ok || reserved.value.kind !== "reserved") throw new Error("Reservation failed");
    let guardCalls = 0;

    const committed = await store.commitLedgerEvent(
      "guarded-ledger",
      summaryFailedOpenEvent({ reservationId: reserved.value.reservationId, reasonCode: "overall_timeout" }),
      () => {
        guardCalls += 1;
        return false;
      }
    );

    expect(committed).toEqual({ ok: true, value: { kind: "rejected", reason: "stale" } });
    expect(guardCalls).toBe(1);
    const session = await store.read("guarded-ledger");
    if (!session.ok) throw session.error;
    expect(session.value.events.filter(event => event.type === "summary_failed_open")).toEqual([]);
  });
});
