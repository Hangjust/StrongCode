import { ModelProvider, ModelRequest, ModelResponse } from "./provider";
import { StrongCodeError } from "../core/errors";

export class MockModelProvider implements ModelProvider {
  readonly name = "mock";

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const prompt = request.prompt.trim();
    const lowerPrompt = prompt.toLowerCase();

    if (request.tools.includes("list_files") && lowerPrompt.includes("list files")) {
      return {
        message: "I will list the workspace files.",
        toolCalls: [{ name: "list_files", input: { path: "." } }]
      };
    }

    const readPrefix = "read file ";
    if (request.tools.includes("read_file") && lowerPrompt.startsWith(readPrefix)) {
      return {
        message: `I will read ${prompt.slice(readPrefix.length)}.`,
        toolCalls: [{ name: "read_file", input: { path: prompt.slice(readPrefix.length).trim() } }]
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
