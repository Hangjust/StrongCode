import {
  normalizeConversationItemsForPrompt,
  validateCompleteConversationItems,
  validateConversationItems
} from "../src/core/types";

const INTERRUPTED_TOOL_RESULT_CONTENT = "Tool execution was interrupted before a result was recorded; its outcome is unknown and StrongCode will not retry it automatically.";

describe("conversation item validation characterization", () => {
  it("preserves a complete batch of correlated calls and results", () => {
    // Given
    const history = [
      { type: "tool_call", role: "assistant", callId: "call-a", name: "read_file", input: { path: "A.md" } },
      { type: "tool_call", role: "assistant", callId: "call-b", name: "read_file", input: { path: "B.md" } },
      { type: "tool_result", role: "tool", callId: "call-a", content: "A", isError: false },
      { type: "tool_result", role: "tool", callId: "call-b", content: "B", isError: false }
    ] as const;

    // When
    const validated = validateCompleteConversationItems(history);

    // Then
    expect(validated).toEqual(history);
  });

  it("rejects an orphan tool result", () => {
    // Given
    const history = [
      { type: "tool_result", role: "tool", callId: "orphan-result", content: "unexpected", isError: false }
    ] as const;

    // When / Then
    expect(() => validateConversationItems(history)).toThrowError(expect.objectContaining({
      code: "VALIDATION_ERROR",
      message: "Tool result 'orphan-result' has no preceding call"
    }));
  });

  it("rejects duplicate tool call IDs", () => {
    // Given
    const duplicateCall = {
      type: "tool_call",
      role: "assistant",
      callId: "duplicate-call",
      name: "read_file",
      input: { path: "README.md" }
    } as const;

    // When / Then
    expect(() => validateConversationItems([duplicateCall, duplicateCall])).toThrowError(expect.objectContaining({
      code: "VALIDATION_ERROR",
      message: "Duplicate tool call ID 'duplicate-call'"
    }));
  });
});

describe("conversation item prompt normalization", () => {
  it("synthesizes one deterministic error result for a dangling call", () => {
    // Given
    const history = [
      { type: "tool_call", role: "assistant", callId: "call-dangling", name: "read_file", input: { path: "README.md" } }
    ] as const;

    // When
    const normalized = normalizeConversationItemsForPrompt(history);

    // Then
    expect(normalized).toEqual([
      history[0],
      {
        type: "tool_result",
        role: "tool",
        callId: "call-dangling",
        content: INTERRUPTED_TOOL_RESULT_CONTENT,
        isError: true
      }
    ]);
  });

  it("appends missing sibling results before the next text item in call order", () => {
    // Given
    const history = [
      { type: "tool_call", role: "assistant", callId: "call-a", name: "read_file", input: { path: "A.md" } },
      { type: "tool_call", role: "assistant", callId: "call-b", name: "read_file", input: { path: "B.md" } },
      { type: "tool_call", role: "assistant", callId: "call-c", name: "read_file", input: { path: "C.md" } },
      { type: "tool_result", role: "tool", callId: "call-a", content: "A", isError: false },
      { type: "text", role: "user", content: "continue" }
    ] as const;

    // When
    const normalized = normalizeConversationItemsForPrompt(history);

    // Then
    expect(normalized).toEqual([
      history[0],
      history[1],
      history[2],
      history[3],
      {
        type: "tool_result",
        role: "tool",
        callId: "call-b",
        content: INTERRUPTED_TOOL_RESULT_CONTENT,
        isError: true
      },
      {
        type: "tool_result",
        role: "tool",
        callId: "call-c",
        content: INTERRUPTED_TOOL_RESULT_CONTENT,
        isError: true
      },
      history[4]
    ]);
  });

  it("leaves complete history values and ordering unchanged", () => {
    // Given
    const history = [
      { type: "text", role: "assistant", content: "Checking." },
      { type: "tool_call", role: "assistant", callId: "call-complete", name: "read_file", input: { path: "README.md" } },
      { type: "tool_result", role: "tool", callId: "call-complete", content: "StrongCode", isError: false },
      { type: "text", role: "assistant", content: "Finished." }
    ] as const;

    // When
    const normalized = normalizeConversationItemsForPrompt(history);

    // Then
    expect(normalized).toEqual(history);
    expect(normalized).not.toBe(history);
  });

  it("does not copy tool input into a synthetic result", () => {
    // Given
    const secret = "private-session-token-never-serialize";
    const history = [
      {
        type: "tool_call",
        role: "assistant",
        callId: "call-private",
        name: "mcp_call",
        input: { authorization: secret, arguments: { password: "private-password" } }
      }
    ] as const;

    // When
    const normalized = normalizeConversationItemsForPrompt(history);

    // Then
    const syntheticResult = normalized.find(item => item.type === "tool_result");
    expect(syntheticResult).toEqual({
      type: "tool_result",
      role: "tool",
      callId: "call-private",
      content: INTERRUPTED_TOOL_RESULT_CONTENT,
      isError: true
    });
    expect(JSON.stringify(syntheticResult)).not.toContain(secret);
    expect(JSON.stringify(syntheticResult)).not.toContain("private-password");
  });

  it("continues to reject orphan results", () => {
    // Given
    const history = [
      { type: "tool_result", role: "tool", callId: "orphan-result", content: "unexpected", isError: false }
    ] as const;

    // When / Then
    expect(() => normalizeConversationItemsForPrompt(history)).toThrowError(expect.objectContaining({
      code: "VALIDATION_ERROR",
      message: "Tool result 'orphan-result' has no preceding call"
    }));
  });

  it("continues to reject duplicate call IDs", () => {
    // Given
    const duplicateCall = {
      type: "tool_call",
      role: "assistant",
      callId: "duplicate-call",
      name: "read_file",
      input: { path: "README.md" }
    } as const;

    // When / Then
    expect(() => normalizeConversationItemsForPrompt([duplicateCall, duplicateCall])).toThrowError(expect.objectContaining({
      code: "VALIDATION_ERROR",
      message: "Duplicate tool call ID 'duplicate-call'"
    }));
  });
});
