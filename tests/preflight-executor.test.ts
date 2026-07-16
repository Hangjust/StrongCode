import { describe, expect, it } from "vitest";
import {
  completeDecision,
  modelResponse,
  scheduleInput,
  schedulerHarness,
  terminal
} from "./fixtures/preflight-scheduler-harness";

const safeCall = { callId: "safe-call", name: "read_file", input: { path: "README.md" } } as const;

describe("Preflight private executor", () => {
  it("advertises and executes only the full safe permission intersection", async () => {
    const harness = await schedulerHarness();
    harness.models.enqueue("summary",
      { message: "", toolCalls: [safeCall] },
      completeDecision()
    );
    const settled = await terminal(await harness.scheduler.run(scheduleInput(harness)));
    expect(settled.ok).toBe(true);
    expect(harness.models.requests.summary[0]?.tools).toEqual(["read_file", "ripgrep", "web_search"]);
    expect(harness.invocations).toEqual(["read_file:{\"path\":\"README.md\"}"]);
    expect(harness.models.requests.summary[1]?.items?.slice(-2)).toEqual([
      { type: "tool_call", role: "assistant", ...safeCall },
      { type: "tool_result", role: "tool", callId: "safe-call", content: "result-read_file", isError: false }
    ]);
  });

  it.each([
    "write_file", "shell", "question", "worker", "task", "spawn", "scheduler", "mcp__unknown__read"
  ])("denies %s with zero invocation", async name => {
    const harness = await schedulerHarness();
    harness.models.enqueue("summary", { message: "", toolCalls: [{ callId: `forbidden-${name}`, name, input: {} }] });
    const settled = await terminal(await harness.scheduler.run(scheduleInput(harness)));
    expect(settled).toMatchObject({ ok: true, value: { kind: "failed-open", reasonCode: "tool_permission_denied" } });
    expect(harness.invocations).toEqual([]);
  });

  it("admits a whole mixed batch before invoking any safe tool", async () => {
    const harness = await schedulerHarness();
    harness.models.enqueue("summary", {
      message: "",
      toolCalls: [safeCall, { callId: "bad-call", name: "write_file", input: {} }]
    });
    const settled = await terminal(await harness.scheduler.run(scheduleInput(harness)));
    expect(settled).toMatchObject({ ok: true, value: { kind: "failed-open" } });
    expect(harness.invocations).toEqual([]);
  });

  it("denies a mixed local-data and outbound-web batch before either tool runs", async () => {
    // Given
    const harness = await schedulerHarness();
    harness.models.enqueue("summary", {
      message: "",
      toolCalls: [safeCall, { callId: "outbound", name: "web_search", input: { query: "workspace data" } }]
    });

    // When
    const settled = await terminal(await harness.scheduler.run(scheduleInput(harness)));

    // Then
    expect(settled).toMatchObject({
      ok: true,
      value: { kind: "failed-open", reasonCode: "tool_data_boundary_denied" }
    });
    expect(harness.invocations).toEqual([]);
  });

  it("rejects a fifth call in one response before invocation", async () => {
    const harness = await schedulerHarness();
    harness.models.enqueue("summary", {
      message: "",
      toolCalls: Array.from({ length: 5 }, (_, index) => ({ callId: `call-${index}`, name: "read_file", input: { index } }))
    });
    const settled = await terminal(await harness.scheduler.run(scheduleInput(harness)));
    expect(settled).toMatchObject({ ok: true, value: { kind: "failed-open", reasonCode: "tool_step_limit" } });
    expect(harness.invocations).toEqual([]);
  });

  it("rejects repeated call sets even when call IDs change", async () => {
    const harness = await schedulerHarness();
    harness.models.enqueue("summary",
      { message: "", toolCalls: [safeCall] },
      { message: "", toolCalls: [{ ...safeCall, callId: "changed-id" }] }
    );
    const settled = await terminal(await harness.scheduler.run(scheduleInput(harness)));
    expect(settled).toMatchObject({ ok: true, value: { kind: "failed-open", reasonCode: "tool_loop_detected" } });
    expect(harness.invocations).toHaveLength(1);
  });

  it("rejects duplicate or missing call IDs before invocation", async () => {
    const harness = await schedulerHarness();
    harness.models.enqueue("summary", {
      message: "",
      toolCalls: [safeCall, { ...safeCall, callId: "safe-call" }]
    });
    const settled = await terminal(await harness.scheduler.run(scheduleInput(harness)));
    expect(settled).toMatchObject({ ok: true, value: { kind: "failed-open" } });
    expect(harness.invocations).toEqual([]);
  });

  it("rejects a truly missing call ID before invocation", async () => {
    const harness = await schedulerHarness();
    harness.models.enqueue("summary", {
      message: "",
      toolCalls: [{ name: "read_file", input: { path: "README.md" } }]
    });
    const settled = await terminal(await harness.scheduler.run(scheduleInput(harness)));
    expect(settled).toMatchObject({ ok: true, value: { kind: "failed-open" } });
    expect(harness.invocations).toEqual([]);
  });

  it("rejects a call ID reused from transcript history", async () => {
    const harness = await schedulerHarness();
    harness.models.enqueue(
      "summary",
      modelResponse("", [safeCall]),
      modelResponse("", [{ ...safeCall, input: { path: "AGENTS.md" } }])
    );
    const settled = await terminal(await harness.scheduler.run(scheduleInput(harness)));
    expect(settled).toMatchObject({ ok: true, value: { kind: "failed-open" } });
    expect(harness.invocations).toHaveLength(1);
  });

  it("rechecks effective permission immediately before invocation", async () => {
    const harness = await schedulerHarness();
    const permissions: Record<string, "allow" | "deny"> = { read_file: "allow" };
    harness.models.enqueue("summary", async () => {
      permissions.read_file = "deny";
      return modelResponse("", [safeCall]);
    });
    const settled = await terminal(await harness.scheduler.run(scheduleInput(harness, {
      effectivePermissions: permissions
    })));
    expect(harness.models.requests.summary[0]?.tools).toContain("read_file");
    expect(settled).toMatchObject({
      ok: true,
      value: { kind: "failed-open", reasonCode: "tool_permission_denied" }
    });
    expect(harness.invocations).toEqual([]);
  });

  it("enforces the cumulative tool-call ceiling before a later batch", async () => {
    const harness = await schedulerHarness();
    const firstBatch = Array.from({ length: 3 }, (_, index) => ({
      callId: `first-${index}`, name: "read_file", input: { index }
    }));
    const secondBatch = Array.from({ length: 2 }, (_, index) => ({
      callId: `second-${index}`, name: "ripgrep", input: { index }
    }));
    harness.models.enqueue("summary", modelResponse("", firstBatch), modelResponse("", secondBatch));
    const settled = await terminal(await harness.scheduler.run(scheduleInput(harness)));
    expect(settled).toMatchObject({
      ok: true,
      value: { kind: "failed-open", reasonCode: "tool_total_limit" }
    });
    expect(harness.invocations).toHaveLength(3);
  });

  it("rejects oversized tool input before invocation", async () => {
    const harness = await schedulerHarness();
    harness.models.enqueue("summary", modelResponse("", [{
      callId: "large-input",
      name: "read_file",
      input: { value: "x".repeat(32) }
    }]));
    const settled = await terminal(await harness.scheduler.run(scheduleInput(harness, {
      limits: { maxToolInputBytes: 16 }
    })));
    expect(settled).toMatchObject({
      ok: true,
      value: { kind: "failed-open", reasonCode: "tool_input_too_large" }
    });
    expect(harness.invocations).toEqual([]);
  });

  it("truncates one oversized tool result before model continuation", async () => {
    const harness = await schedulerHarness({ toolResults: { read_file: "x".repeat(64) } });
    harness.models.enqueue("summary", modelResponse("", [safeCall]), completeDecision());
    const settled = await terminal(await harness.scheduler.run(scheduleInput(harness, {
      limits: { maxToolResultBytes: 16 }
    })));
    expect(settled).toMatchObject({ ok: true, value: { kind: "committed" } });
    const toolResult = harness.models.requests.summary[1]?.items?.at(-1);
    expect(toolResult).toMatchObject({ type: "tool_result", callId: "safe-call", isError: false });
    if (toolResult?.type !== "tool_result") throw new Error("Missing bounded tool result");
    expect(toolResult.content.toLowerCase()).toContain("truncated");
  });

  it("stops before continuation when aggregate tool results exceed the ceiling", async () => {
    const harness = await schedulerHarness({
      toolResults: { read_file: "12345678", ripgrep: "abcdefgh" }
    });
    harness.models.enqueue("summary", modelResponse("", [
      safeCall,
      { callId: "search-call", name: "ripgrep", input: { query: "fixture" } }
    ]));
    const settled = await terminal(await harness.scheduler.run(scheduleInput(harness, {
      limits: { maxAggregateToolResultBytes: 12 }
    })));
    expect(settled).toMatchObject({
      ok: true,
      value: { kind: "failed-open", reasonCode: "tool_output_budget_exhausted" }
    });
    expect(harness.models.requests.summary).toHaveLength(1);
  });

  it("stops at the narrowed model-step ceiling", async () => {
    const harness = await schedulerHarness();
    harness.models.enqueue("summary", modelResponse("", [safeCall]));
    const settled = await terminal(await harness.scheduler.run(scheduleInput(harness, {
      limits: { maxModelSteps: 1 }
    })));
    expect(settled).toMatchObject({
      ok: true,
      value: { kind: "failed-open", reasonCode: "model_step_limit" }
    });
    expect(harness.models.requests.summary).toHaveLength(1);
  });
});
