import type { ModelProvider, ModelRequest, ModelResponse } from "./provider";
import { StrongCodeError } from "../core/errors";
import { modelRequestItems, modelResponseItems } from "./provider";
import { parseMockModelResponse, parseMockScript } from "./mock-response";

export class MockModelProvider implements ModelProvider {
  readonly name = "mock";
  private readonly script: readonly ModelResponse[];
  private completionCount = 0;

  constructor(script: readonly ModelResponse[] = []) {
    this.script = script.map(parseMockModelResponse);
  }

  static fromFixture(value: unknown): MockModelProvider {
    return new MockModelProvider(parseMockScript(value));
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    request.signal?.throwIfAborted();
    if (this.script.length > 0) {
      modelRequestItems(request);
      const response = this.script[this.completionCount];
      if (!response) {
        throw new StrongCodeError("MODEL_ERROR", `Mock provider script exhausted after ${this.completionCount} completion${this.completionCount === 1 ? "" : "s"}`);
      }
      modelResponseItems(response);
      this.completionCount += 1;
      return parseMockModelResponse(response);
    }

    const prompt = request.prompt.trim();
    const lowerPrompt = prompt.toLowerCase();

    if (request.tools.includes("list_files") && lowerPrompt.includes("list files")) {
      return {
        message: "I will list the workspace files.",
        toolCalls: [{ callId: `mock-call-${++this.completionCount}`, name: "list_files", input: { path: "." } }]
      };
    }

    const readPrefix = "read file ";
    if (request.tools.includes("read_file") && lowerPrompt.startsWith(readPrefix)) {
      return {
        message: `I will read ${prompt.slice(readPrefix.length)}.`,
        toolCalls: [{ callId: `mock-call-${++this.completionCount}`, name: "read_file", input: { path: prompt.slice(readPrefix.length).trim() } }]
      };
    }

    return {
      message: `Mock response: ${prompt || "(empty prompt)"}`,
      toolCalls: []
    };
  }
}

export class UnsupportedModelProvider implements ModelProvider {
  readonly name: string;
  private readonly providerType: string;

  constructor(providerName: string, providerType = providerName) {
    this.name = providerName;
    this.providerType = providerType;
  }

  async complete(): Promise<ModelResponse> {
    throw new StrongCodeError("MODEL_ERROR", `Provider '${this.name}' of type '${this.providerType}' is not supported for completions`);
  }
}
