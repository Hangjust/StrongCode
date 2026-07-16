import { describe, expect, it } from "vitest";
import type { ModelResponse } from "../src/models/provider";
import {
  completeDecision,
  deferred,
  modelResponse,
  scheduleInput,
  schedulerHarness,
  terminal
} from "./fixtures/preflight-scheduler-harness";

describe("PreflightScheduler trace", () => {
  it("emits monotonic deeply frozen trace records", async () => {
    const harness = await schedulerHarness();
    harness.models.enqueue("summary", completeDecision());
    await terminal(await harness.scheduler.run(scheduleInput(harness)));
    expect(harness.traces.length).toBeGreaterThan(0);
    const sequences = harness.traces.map(event => event.sequence);
    expect(sequences).toEqual(Array.from({ length: sequences.length }, (_, index) => index + 1));
    for (const event of harness.traces) {
      expect(Object.isFrozen(event)).toBe(true);
      for (const value of Object.values(event)) {
        if (typeof value === "object" && value !== null) expect(Object.isFrozen(value)).toBe(true);
      }
    }
  });

  it("records outbound attempts, tool decisions, and validation codes", async () => {
    const harness = await schedulerHarness();
    harness.models.enqueue(
      "summary",
      modelResponse("", [{ callId: "trace-call", name: "read_file", input: { path: "README.md" } }]),
      completeDecision()
    );
    await terminal(await harness.scheduler.run(scheduleInput(harness)));
    expect(harness.traces).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "provider-attempt", code: "outbound" }),
      expect.objectContaining({ kind: "tool-decision", code: "advertise" }),
      expect.objectContaining({ kind: "tool-decision", code: "invoke" }),
      expect.objectContaining({ kind: "validation", code: "accepted" })
    ]));
  });

  it("redacts prompt, model prose, tool payloads, outputs, and raw errors", async () => {
    const sentinels = [
      "UNIQUE_PROMPT_SENTINEL",
      "UNIQUE_MODEL_SENTINEL",
      "UNIQUE_TOOL_INPUT_SENTINEL",
      "UNIQUE_TOOL_OUTPUT_SENTINEL",
      "UNIQUE_ERROR_SENTINEL"
    ] as const;
    const harness = await schedulerHarness({
      toolResults: { read_file: sentinels[3] }
    });
    harness.models.enqueue(
      "summary",
      modelResponse("", [{
        callId: "redacted-call",
      name: "read_file",
        input: { value: sentinels[2] }
      }]),
      completeDecision(sentinels[1])
    );
    await terminal(await harness.scheduler.run(scheduleInput(harness, {
      originalPrompt: sentinels[0]
    })));
    const serialized = JSON.stringify(harness.traces);
    for (const sentinel of sentinels) expect(serialized).not.toContain(sentinel);
  });

  it("isolates a throwing trace callback from scheduler completion", async () => {
    const harness = await schedulerHarness({
      emitTrace: () => { throw new Error("trace callback sentinel"); }
    });
    harness.models.enqueue("summary", completeDecision());
    const settled = await terminal(await harness.scheduler.run(scheduleInput(harness)));
    expect(settled).toMatchObject({ ok: true, value: { kind: "committed" } });
  });

  it("records strict validation failure without raw malformed output", async () => {
    const harness = await schedulerHarness();
    harness.models.enqueue("summary", modelResponse("malformed UNIQUE_MALFORMED_SENTINEL"));
    await terminal(await harness.scheduler.run(scheduleInput(harness)));
    expect(harness.traces).toContainEqual(expect.objectContaining({
      kind: "validation", code: "root_json_invalid"
    }));
    expect(JSON.stringify(harness.traces)).not.toContain("UNIQUE_MALFORMED_SENTINEL");
  });

  it("fences a late provider settlement and traces only its static code", async () => {
    const harness = await schedulerHarness();
    expect(harness.schedulerAvailable, "Todo 7 private scheduler is missing").toBe(true);
    const pending = deferred<ModelResponse>();
    harness.models.enqueue("summary", () => pending.promise);
    const observed = harness.models.waitForRequests("summary", 1);
    const scheduled = await harness.scheduler.run(scheduleInput(harness));
    await observed;
    harness.clock.advanceBy(90_000);
    await terminal(scheduled);
    pending.resolve(completeDecision("UNIQUE_LATE_SENTINEL"));
    await Promise.resolve();
    expect(harness.traces).toContainEqual(expect.objectContaining({
      kind: "provider-attempt", code: "late-dropped"
    }));
    expect(JSON.stringify(harness.traces)).not.toContain("UNIQUE_LATE_SENTINEL");
  });

  it("reports provider identity collision as a static validation code", async () => {
    const harness = await schedulerHarness();
    harness.models.enqueue(
      "summary",
      {
      ...modelResponse("", [{ callId: "next", name: "read_file", input: {} }]),
        providerResponseId: "same-response"
      },
      { ...completeDecision(), providerResponseId: "same-response" }
    );
    await terminal(await harness.scheduler.run(scheduleInput(harness)));
    expect(harness.traces).toContainEqual(expect.objectContaining({
      kind: "validation", code: "provider_identity_collision"
    }));
  });

  it("leaves no deadline timer or live registry entry after callback isolation", async () => {
    const harness = await schedulerHarness({ emitTrace: () => { throw new Error("ignored"); } });
    harness.models.enqueue("summary", completeDecision());
    await terminal(await harness.scheduler.run(scheduleInput(harness)));
    expect(harness.clock.pendingTimers()).toBe(0);
    expect(harness.registry.size).toBe(0);
  });
});
