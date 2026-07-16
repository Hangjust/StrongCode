import { immutableConversationItems } from "../src/agents/conversation-snapshot";
import type { ConversationItem } from "../src/core/types";

describe("immutable conversation snapshots", () => {
  it("deeply clones and freezes tool input without mutating the provider object", () => {
    // Given
    const providerInput = {
      path: "README.md",
      options: { lines: [1, 2] }
    };
    const items: readonly ConversationItem[] = [{
      type: "tool_call",
      role: "assistant",
      callId: "call-snapshot-1",
      name: "read_file",
      input: providerInput
    }];

    // When
    const snapshot = immutableConversationItems(items);
    providerInput.path = "AGENTS.md";
    providerInput.options.lines.push(3);

    // Then
    expect(snapshot).toEqual([{
      type: "tool_call",
      role: "assistant",
      callId: "call-snapshot-1",
      name: "read_file",
      input: { path: "README.md", options: { lines: [1, 2] } }
    }]);
    expect(Object.isFrozen(providerInput)).toBe(false);
    expect(Object.isFrozen(snapshot)).toBe(true);
    const call = snapshot[0];
    if (!call || call.type !== "tool_call") throw new Error("Expected tool call snapshot");
    expect(Object.isFrozen(call.input)).toBe(true);
  });

  it.each([
    ["undefined", { value: undefined }],
    ["non-finite number", { value: Number.POSITIVE_INFINITY }],
    ["non-plain object", { value: new Date("2026-07-14T00:00:00.000Z") }]
  ])("rejects %s in tool input", (_label, input) => {
    // Given
    const items: readonly ConversationItem[] = [{
      type: "tool_call",
      role: "assistant",
      callId: "call-invalid-json",
      name: "read_file",
      input
    }];

    // When / Then
    expect(() => immutableConversationItems(items)).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  });

  it("rejects cyclic tool input", () => {
    // Given
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const items: readonly ConversationItem[] = [{
      type: "tool_call",
      role: "assistant",
      callId: "call-cycle",
      name: "read_file",
      input: cyclic
    }];

    // When / Then
    expect(() => immutableConversationItems(items)).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  });

  it("preserves __proto__ as an own JSON key without changing the clone prototype", () => {
    // Given
    const providerInput: Record<string, unknown> = JSON.parse('{"__proto__":{"admin":true},"path":"README.md"}');
    const items: readonly ConversationItem[] = [{
      type: "tool_call",
      role: "assistant",
      callId: "call-prototype-key",
      name: "read_file",
      input: providerInput
    }];

    // When
    const snapshot = immutableConversationItems(items);

    // Then
    const call = snapshot[0];
    if (!call || call.type !== "tool_call" || typeof call.input !== "object" || call.input === null) {
      throw new Error("Expected object tool input");
    }
    expect(Object.hasOwn(call.input, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(call.input)).toBe(Object.prototype);
    expect(JSON.stringify(call.input)).toBe('{"__proto__":{"admin":true},"path":"README.md"}');
  });
});
