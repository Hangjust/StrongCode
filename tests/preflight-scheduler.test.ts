import { describe, expect, it } from "vitest";
import {
  completeDecision,
  CompletionBarrier,
  finalResult,
  finding,
  modelResponse,
  researchDecision,
  researchRequests,
  scheduleInput,
  schedulerHarness,
  terminal
} from "./fixtures/preflight-scheduler-harness";
import { PreflightMemorySessionStore } from "./fixtures/preflight-memory-session-store";

describe("PreflightScheduler flow", () => {
  it("ignores whitespace without creating a session or provider request", async () => {
    const harness = await schedulerHarness();
    const result = await harness.scheduler.run(scheduleInput(harness, { originalPrompt: " \t\n" }));
    expect(result).toEqual({ ok: true, value: { kind: "ignored-empty" } });
    expect((await harness.sessions.read("preflight-session")).ok).toBe(false);
    expect(harness.models.requests.summary).toHaveLength(0);
  });

  it("commits a direct complete result without children or finalizer", async () => {
    const harness = await schedulerHarness();
    harness.models.enqueue("summary", completeDecision());
    const settled = await terminal(await harness.scheduler.run(scheduleInput(harness)));
    expect(settled).toMatchObject({ ok: true, value: { kind: "committed", result: { title: "Fixture title" } } });
    expect(harness.models.created).toEqual(["summary"]);
  });

  it("runs exactly one finalizer for valid zero-request research", async () => {
    const harness = await schedulerHarness();
    harness.models.enqueue("summary", researchDecision(0), finalResult());
    const settled = await terminal(await harness.scheduler.run(scheduleInput(harness)));
    expect(settled).toMatchObject({ ok: true, value: { kind: "committed", result: { title: "Final title" } } });
    expect(harness.models.requests.summary).toHaveLength(2);
    expect(harness.models.created).toEqual(["summary", "summary"]);
  });

  it("launches twenty-five depth-one children and finalizes in source order", async () => {
    let sessions: PreflightMemorySessionStore | undefined;
    const harness = await schedulerHarness({
      createSessions: () => {
        sessions = new PreflightMemorySessionStore();
        return sessions;
      }
    });
    if (sessions === undefined) throw new Error("Missing memory session store");
    expect(harness.schedulerAvailable, "Todo 7 private scheduler is missing").toBe(true);
    const barrier = new CompletionBarrier(25);
    harness.models.enqueue("summary", researchDecision(25), finalResult());
    for (let index = 0; index < 25; index += 1) {
      harness.models.enqueue(
        index % 2 === 0 ? "analysis" : "explorer",
        barrier.completion(index, finding(index))
      );
    }
    const scheduled = await harness.scheduler.run(scheduleInput(harness));
    let settled;
    try {
      await barrier.waitUntilFull();
      expect(barrier.peak).toBe(25);
      expect(barrier.started).toEqual(Array.from({ length: 25 }, (_, index) => index));
      expect(sessions.childAttemptCommits("preflight-session")).toBe(0);
    } finally {
      barrier.release();
      settled = await terminal(scheduled);
    }
    expect(settled).toMatchObject({ ok: true, value: { kind: "committed" } });
    expect(harness.models.requests.analysis).toHaveLength(13);
    expect(harness.models.requests.explorer).toHaveLength(12);
    const evidence = harness.models.requests.summary[1]?.items?.at(-1);
    expect(evidence).toMatchObject({ type: "text", role: "user" });
    if (evidence?.type !== "text") throw new Error("Missing finalizer evidence");
    expect(JSON.parse(evidence.content).untrustedResearch.map((entry: { index: number }) => entry.index))
      .toEqual(Array.from({ length: 25 }, (_, index) => index));
    const stored = await sessions.read("preflight-session");
    if (!stored.ok) throw stored.error;
    const attempts = stored.value.events.filter(event => event.type === "attempt_created");
    const root = attempts.find(event => event.role === "summary");
    if (root === undefined) throw new Error("Missing root attempt");
    expect(attempts.filter(event => event.role === "analysis" || event.role === "explorer")
      .every(event => event.parentAttemptId === root.attemptId)).toBe(true);
    expect(harness.registry.size).toBe(0);
    expect(harness.clock.pendingTimers()).toBe(0);
  });

  it("fails open on twenty-six requests without creating a child", async () => {
    const harness = await schedulerHarness();
    harness.models.enqueue("summary", researchDecision(26));
    const settled = await terminal(await harness.scheduler.run(scheduleInput(harness)));
    expect(settled).toMatchObject({ ok: true, value: { kind: "failed-open", reasonCode: "research_limit_exceeded" } });
    expect(harness.models.created).toEqual(["summary"]);
  });

  it("respects a narrowed FIFO concurrency ceiling", async () => {
    const harness = await schedulerHarness();
    harness.models.enqueue("summary", researchDecision(3), finalResult());
    harness.models.enqueue("analysis", finding(0), finding(2));
    harness.models.enqueue("explorer", finding(1));
    const settled = await terminal(await harness.scheduler.run(scheduleInput(harness, {
      limits: { maxConcurrentChildren: 1 }
    })));
    expect(settled.ok).toBe(true);
    const starts = harness.traces.filter(event => event.kind === "child-transition" && event.code === "running");
    expect(starts.map(event => event.sourceIndex)).toEqual([0, 1, 2]);
  });

  it.each([
    ["prose", modelResponse("before {}"), "root_json_invalid"],
    ["fenced JSON", modelResponse("```json\n{}\n```"), "root_json_invalid"],
    ["unknown fields", modelResponse(JSON.stringify({ kind: "complete", result: {
      title: "Valid", generalSummary: "Summary", requestedItems: [], injected: true
    } })), "root_decision_invalid"],
    ["twenty-one word title", completeDecision(Array.from({ length: 21 }, (_, index) => `w${index}`).join(" ")), "title_word_limit"],
    ["terminal control", completeDecision("unsafe\u001btitle"), "unsafe_display_text"]
  ])("fails open on strict root %s", async (_label, response, reasonCode) => {
    const harness = await schedulerHarness();
    harness.models.enqueue("summary", response);
    const settled = await terminal(await harness.scheduler.run(scheduleInput(harness)));
    expect(settled).toMatchObject({ ok: true, value: { kind: "failed-open", reasonCode } });
  });

  it("rejects oversized root output before parsing", async () => {
    const harness = await schedulerHarness();
    harness.models.enqueue("summary", modelResponse("x".repeat(65)));
    const settled = await terminal(await harness.scheduler.run(scheduleInput(harness, {
      limits: { maxFinalTextBytes: 64 }
    })));
    expect(settled).toMatchObject({
      ok: true,
      value: { kind: "failed-open", reasonCode: "root_output_too_large" }
    });
  });

  it.each([
    ["duplicate IDs", [
      { id: "duplicate", role: "analysis" as const, question: "One" },
      { id: "duplicate", role: "explorer" as const, question: "Two" }
    ], {}, "research_duplicate_id"],
    ["question bytes", [
      { id: "large", role: "analysis" as const, question: "12345" }
    ], { maxQuestionBytes: 4 }, "research_question_too_large"],
    ["aggregate bytes", [
      { id: "one", role: "analysis" as const, question: "one" },
      { id: "two", role: "explorer" as const, question: "two" }
    ], { maxResearchBytes: 8 }, "research_payload_too_large"]
  ])("atomically rejects %s before creating children", async (_label, requests, limits, reasonCode) => {
    const harness = await schedulerHarness();
    harness.models.enqueue("summary", researchRequests(requests));
    const settled = await terminal(await harness.scheduler.run(scheduleInput(harness, { limits })));
    expect(settled).toMatchObject({ ok: true, value: { kind: "failed-open", reasonCode } });
    expect(harness.models.created).toEqual(["summary"]);
  });

  it("turns child failures into source-ordered static gaps", async () => {
    const harness = await schedulerHarness();
    harness.models.enqueue("summary", researchDecision(4), finalResult());
    harness.models.enqueue("analysis", async () => { throw new Error("provider sentinel"); });
    harness.models.enqueue("explorer", modelResponse("not-json"));
    harness.models.enqueue("analysis", finding(2, "explorer"));
    harness.models.enqueue("explorer", modelResponse(JSON.stringify({
      requestId: "request-3", role: "explorer", summary: "oversized", sources: []
    })));
    const settled = await terminal(await harness.scheduler.run(scheduleInput(harness, {
      limits: { maxFindingBytes: 32 }
    })));
    expect(settled).toMatchObject({ ok: true, value: { kind: "committed" } });
    const evidence = harness.models.requests.summary[1]?.items?.at(-1);
    expect(evidence).toMatchObject({ type: "text", role: "user" });
    if (evidence?.type !== "text") throw new Error("Missing finalizer evidence");
    expect(JSON.parse(evidence.content).untrustedResearch.map(
      (entry: { outcome: { code: string } }) => entry.outcome.code
    )).toEqual(["provider_failed", "malformed_json", "finding_mismatch", "finding_too_large"]);
  });

  it("gives the mandatory finalizer one model step and zero tools", async () => {
    const harness = await schedulerHarness();
    harness.models.enqueue("summary", researchDecision(0), finalResult());
    const settled = await terminal(await harness.scheduler.run(scheduleInput(harness)));
    expect(settled).toMatchObject({ ok: true, value: { kind: "committed" } });
    expect(harness.models.requests.summary[1]?.tools).toEqual([]);
  });

  it.each([
    ["tool call", modelResponse("", [{ callId: "late-tool", name: "read_file", input: {} }]), "finalizer_tool_requested"],
    ["research decision", researchDecision(0), "finalizer_result_invalid"],
    ["malformed result", modelResponse("not-json"), "finalizer_json_invalid"]
  ])("fails open when the finalizer returns %s", async (_label, response, reasonCode) => {
    const harness = await schedulerHarness();
    harness.models.enqueue("summary", researchDecision(0), response);
    const settled = await terminal(await harness.scheduler.run(scheduleInput(harness)));
    expect(settled).toMatchObject({ ok: true, value: { kind: "failed-open", reasonCode } });
  });

  it("rejects forged recursive dispatch before reservation or agent creation", async () => {
    const harness = await schedulerHarness();
    const result = await terminal(await harness.scheduler.run(scheduleInput(harness, { parentDepth: 1 })));
    expect(result).toMatchObject({
      ok: true,
      value: { kind: "failed-open", reasonCode: "nested_research_denied" }
    });
    expect(harness.models.created).toEqual([]);
    expect((await harness.sessions.read("preflight-session")).ok).toBe(false);
  });
});
