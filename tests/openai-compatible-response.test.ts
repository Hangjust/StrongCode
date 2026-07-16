import { describe, expect, it } from "vitest";
import { parseOpenAICompatibleResponse } from "../src/models/openai-compatible-response";

describe("OpenAI-compatible response reasoning", () => {
  it("returns reasoning_content separately while preserving final content and response metadata", () => {
    // Given
    const responseText = JSON.stringify({
      id: "chatcmpl-reasoning-1",
      choices: [{
        message: {
          content: "Final answer",
          reasoning_content: "  First reason  ",
          tool_calls: [{
            id: "call-reasoning-1",
            type: "function",
            function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" }
          }]
        }
      }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 8,
        total_tokens: 20,
        completion_tokens_details: { reasoning_tokens: 3 }
      }
    });

    // When
    const response = parseOpenAICompatibleResponse(responseText, "request-reasoning-1");

    // Then
    expect(response).toEqual({
      message: "Final answer",
      reasoning: "First reason",
      toolCalls: [{ callId: "call-reasoning-1", name: "read_file", input: { path: "README.md" } }],
      usage: { inputTokens: 12, outputTokens: 8, reasoningTokens: 3, totalTokens: 20 },
      providerRequestId: "request-reasoning-1",
      providerResponseId: "chatcmpl-reasoning-1"
    });
  });

  it("uses reasoning when reasoning_content is blank", () => {
    // Given
    const responseText = JSON.stringify({
      choices: [{ message: { content: "Final answer", reasoning_content: " \n ", reasoning: "  Fallback reason  " } }]
    });

    // When
    const response = parseOpenAICompatibleResponse(responseText);

    // Then
    expect(response).toEqual({ message: "Final answer", reasoning: "Fallback reason", toolCalls: [] });
  });

  it("joins supported reasoning_details text and summaries in source order", () => {
    // Given
    const responseText = JSON.stringify({
      choices: [{
        message: {
          content: "Final answer",
          reasoning_details: [
            { type: "reasoning.text", text: "  First detail  " },
            { type: "reasoning.summary", summary: "  Second detail  " },
            { type: "reasoning.text", text: " \n " },
            { type: "reasoning.summary", summary: "Third detail" }
          ]
        }
      }]
    });

    // When
    const response = parseOpenAICompatibleResponse(responseText);

    // Then
    expect(response).toEqual({
      message: "Final answer",
      reasoning: "First detail\nSecond detail\nThird detail",
      toolCalls: []
    });
  });

  it("prefers the first non-empty explicit reasoning source", () => {
    // Given
    const responseText = JSON.stringify({
      choices: [{
        message: {
          content: "Final answer",
          reasoning_content: "  Highest priority  ",
          reasoning: "Lower priority",
          reasoning_details: [{ type: "reasoning.text", text: "Lowest priority" }]
        }
      }]
    });

    // When
    const response = parseOpenAICompatibleResponse(responseText);

    // Then
    expect(response.reasoning).toBe("Highest priority");
  });

  it("ignores encrypted, data, signature, and arbitrary reasoning detail entries", () => {
    // Given
    const responseText = JSON.stringify({
      choices: [{
        message: {
          content: "Final answer",
          reasoning_details: [
            { type: "reasoning.encrypted", encrypted_content: "opaque-ciphertext" },
            { type: "reasoning.data", data: { vendor: "opaque-blob" } },
            { type: "reasoning.signature", signature: "opaque-signature" },
            { type: "vendor.reasoning", text: "must not be read", vendor_field: "opaque" }
          ]
        }
      }]
    });

    // When
    const response = parseOpenAICompatibleResponse(responseText);

    // Then
    expect(response).toEqual({ message: "Final answer", toolCalls: [] });
  });

  it("ignores malformed optional reasoning metadata without invalidating final content", () => {
    // Given
    const responseText = JSON.stringify({
      choices: [{
        message: {
          content: "Final answer",
          reasoning_content: 42,
          reasoning: { text: "not an explicit string" },
          reasoning_details: [
            null,
            "not a record",
            { type: "reasoning.text", text: 7 },
            { type: "reasoning.summary", summary: null }
          ]
        }
      }]
    });

    // When
    const response = parseOpenAICompatibleResponse(responseText);

    // Then
    expect(response).toEqual({ message: "Final answer", toolCalls: [] });
  });

  it("keeps literal think tags in final content and does not infer reasoning from them", () => {
    // Given
    const content = "Use the literal text <think>example</think> in the final answer.";
    const responseText = JSON.stringify({ choices: [{ message: { content } }] });

    // When
    const response = parseOpenAICompatibleResponse(responseText);

    // Then
    expect(response).toEqual({ message: content, toolCalls: [] });
  });
});
