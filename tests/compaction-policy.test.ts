import { StrongCodeError } from "../src/core/errors";
import type { ConversationItem, Role } from "../src/core/types";
import {
  buildCompactionReplacement,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_TRUNCATION_MARKER,
  COMPACTION_USER_TOKEN_BUDGET
} from "../src/sessions/compaction";

function text(role: Role, content: string): ConversationItem {
  return { type: "text", role, content };
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

describe("compaction replacement policy", () => {
  it("retains an exact 20,000-token newest user message", () => {
    // Given
    const exactBudgetMessage = "x".repeat(80_000);
    const activeItems = [text("user", "older"), text("user", exactBudgetMessage)];

    // When
    const result = buildCompactionReplacement(activeItems, "Continue the task.");

    // Then
    expect(COMPACTION_USER_TOKEN_BUDGET).toBe(20_000);
    expect(result.replacementHistory.map(item => item.content)).toEqual([
      exactBudgetMessage,
      `${COMPACTION_SUMMARY_PREFIX}\nContinue the task.`
    ]);
  });

  it("selects newest user messages and restores chronological order", () => {
    // Given
    const activeItems = [
      text("user", "oldest!!"),
      text("user", "middle!!"),
      text("user", "newest!!")
    ];

    // When
    const result = buildCompactionReplacement(activeItems, "Summary", 4);

    // Then
    expect(result.replacementHistory.map(item => item.content)).toEqual([
      "middle!!",
      "newest!!",
      `${COMPACTION_SUMMARY_PREFIX}\nSummary`
    ]);
  });

  it("rounds partial four-byte groups up to the next estimated token", () => {
    // Given
    const activeItems = [text("user", "12345")];

    // When
    const result = buildCompactionReplacement(activeItems, "Summary", 1);

    // Then
    expect(result.replacementHistory).toEqual([
      { type: "text", role: "user", content: `${COMPACTION_SUMMARY_PREFIX}\nSummary` }
    ]);
  });

  it("excludes prior summaries and non-user conversation items", () => {
    // Given
    const activeItems: readonly ConversationItem[] = [
      text("user", `${COMPACTION_SUMMARY_PREFIX}\nPrior checkpoint`),
      text("assistant", "assistant history"),
      text("tool", "legacy tool history"),
      { type: "tool_call", role: "assistant", callId: "call-1", name: "read_file", input: {} },
      { type: "tool_result", role: "tool", callId: "call-1", content: "tool output", isError: false },
      text("user", "   "),
      text("user", "real user request")
    ];

    // When
    const result = buildCompactionReplacement(activeItems, "Current checkpoint");

    // Then
    expect(result.replacementHistory.map(item => item.content)).toEqual([
      "real user request",
      `${COMPACTION_SUMMARY_PREFIX}\nCurrent checkpoint`
    ]);
  });

  it("middle-truncates one ASCII boundary message within the marker allowance", () => {
    // Given
    const boundaryMessage = "abcdefghijklmnopqrstuvwxyz".repeat(4);

    // When
    const result = buildCompactionReplacement([text("user", boundaryMessage)], "Summary", 10);

    // Then
    const truncated = result.replacementHistory[0].content;
    expect(truncated).toBe(`abc${COMPACTION_TRUNCATION_MARKER}yz`);
    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(40);
  });

  it("preserves complete emoji code points at a truncation boundary", () => {
    // Given
    const boundaryMessage = `${"A😀".repeat(20)}Z`;

    // When
    const result = buildCompactionReplacement([text("user", boundaryMessage)], "Summary", 11);

    // Then
    const truncated = result.replacementHistory[0].content;
    expect(truncated).toBe(`A😀${COMPACTION_TRUNCATION_MARKER}Z`);
    expect(truncated).not.toContain("�");
    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(44);
  });

  it("omits the boundary message when the truncation marker cannot fit", () => {
    // Given
    const markerBytes = Buffer.byteLength(COMPACTION_TRUNCATION_MARKER, "utf8");
    const tinyBudget = Math.floor((markerBytes - 1) / 4);

    // When
    const result = buildCompactionReplacement([text("user", "x".repeat(100))], "Summary", tinyBudget);

    // Then
    expect(result.replacementHistory).toEqual([
      { type: "text", role: "user", content: `${COMPACTION_SUMMARY_PREFIX}\nSummary` }
    ]);
  });

  it("returns a trimmed prefixed summary as the final user text item", () => {
    // Given
    const activeItems = [text("user", "request")];

    // When
    const result = buildCompactionReplacement(activeItems, "  Keep exact paths.  ");

    // Then
    expect(result.summary).toBe(`${COMPACTION_SUMMARY_PREFIX}\nKeep exact paths.`);
    expect(result.replacementHistory.at(-1)).toEqual({
      type: "text",
      role: "user",
      content: result.summary
    });
  });

  it("does not mutate source items", () => {
    // Given
    const sourceItem = Object.freeze({ type: "text", role: "user", content: "original request" } as const);
    const activeItems: readonly ConversationItem[] = Object.freeze([sourceItem]);

    // When
    buildCompactionReplacement(activeItems, "Summary", 2);

    // Then
    expect(activeItems).toEqual([text("user", "original request")]);
    expect(sourceItem.content).toBe("original request");
  });

  it.each(["", "  \n\t  "])("rejects an empty summary body %#", summaryBody => {
    // Given
    const activeItems = [text("user", "request")];

    // When
    const error = validationError(() => buildCompactionReplacement(activeItems, summaryBody));

    // Then
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.message).toContain("summary");
  });
});
