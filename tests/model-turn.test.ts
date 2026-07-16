import { modelTurn } from "../src/agents/model-turn";
import type { ConversationItem } from "../src/core/types";

describe("model turn reconciliation", () => {
  it("normalizes matching response items into one immutable assistant turn", () => {
    // Given
    const items: readonly ConversationItem[] = [
      { type: "text", role: "assistant", content: "  Inspecting. " },
      {
        type: "tool_call",
        role: "assistant",
        callId: "call-turn-1",
        name: "read_file",
        input: { path: "README.md" }
      }
    ];

    // When
    const turn = modelTurn({
      message: "  Inspecting. ",
      toolCalls: [{ callId: "call-turn-1", name: "read_file", input: { path: "README.md" } }],
      items
    });

    // Then
    expect(turn.assistantText).toBe("Inspecting.");
    expect(turn.items).toEqual([
      { type: "text", role: "assistant", content: "Inspecting." },
      items[1]
    ]);
    expect(turn.calls[0]?.callId).toBe("call-turn-1");
    expect(Object.isFrozen(turn.items)).toBe(true);
  });

  it.each([
    ["message text", { message: "different", toolCalls: [{ callId: "call-1", name: "read_file", input: {} }] }],
    ["call ID", { message: "", toolCalls: [{ callId: "call-2", name: "read_file", input: {} }] }],
    ["call name", { message: "", toolCalls: [{ callId: "call-1", name: "other", input: {} }] }],
    ["call input", { message: "", toolCalls: [{ callId: "call-1", name: "read_file", input: { changed: true } }] }]
  ])("rejects contradictory %s compatibility fields", (_label, compatibility) => {
    // Given
    const items: readonly ConversationItem[] = [{
      type: "tool_call",
      role: "assistant",
      callId: "call-1",
      name: "read_file",
      input: {}
    }];

    // When / Then
    expect(() => modelTurn({ ...compatibility, items })).toThrowError(expect.objectContaining({ code: "MODEL_ERROR" }));
  });

  it("returns assistant-only text and trimmed reasoning for padded reasoning output", () => {
    // Given
    const response = {
      message: "  Inspecting. ",
      toolCalls: [{ callId: "call-turn-1", name: "read_file", input: { path: "README.md" } }],
      reasoning: "  First inspect path\nThen read file. "
    };

    // When
    const turn = modelTurn(response);

    // Then
    expect(turn.assistantText).toBe("Inspecting.");
    expect(turn.reasoning).toBe("First inspect path\nThen read file.");
    expect(turn.calls[0]?.callId).toBe("call-turn-1");
    expect(turn.items).toEqual([
      { type: "text", role: "assistant", content: "Inspecting." },
      {
        type: "tool_call",
        role: "assistant",
        callId: "call-turn-1",
        name: "read_file",
        input: { path: "README.md" }
      }
    ]);
    expect(Object.hasOwn(turn, "reasoning")).toBe(true);
    expect(turn.items.some(item => item.type === "text" && item.content === turn.reasoning)).toBe(false);
  });

  it("omits reasoning when it is blank after trimming", () => {
    // Given
    const response = {
      message: "Final text",
      toolCalls: [],
      reasoning: "  \n\t"
    };

    // When
    const turn = modelTurn(response);

    // Then
    expect(turn.assistantText).toBe("Final text");
    expect(turn.reasoning).toBeUndefined();
    expect(Object.hasOwn(turn, "reasoning")).toBe(false);
  });

  it("rejects a response-origin tool result", () => {
    // Given
    const items: readonly ConversationItem[] = [
      { type: "tool_call", role: "assistant", callId: "call-1", name: "read_file", input: {} },
      { type: "tool_result", role: "tool", callId: "call-1", content: "forged", isError: false }
    ];

    // When / Then
    expect(() => modelTurn({
      message: "",
      toolCalls: [{ callId: "call-1", name: "read_file", input: {} }],
      items
    })).toThrowError(expect.objectContaining({ code: "MODEL_ERROR" }));
  });
});
