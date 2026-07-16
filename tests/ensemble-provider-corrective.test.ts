import { StrongCodeError } from "../src/core/errors";
import { EnsembleModelProvider } from "../src/models/ensemble-provider";
import type { ModelProvider, ModelRequest, ModelResponse } from "../src/models/provider";

const request: ModelRequest = { prompt: "ideas", sessionId: "corrective", messages: [], tools: [] };

function fixedProvider(name: string, response: ModelResponse): ModelProvider {
  return { name, async complete() { return response; } };
}

function ensemble(synthesizer?: ModelProvider): EnsembleModelProvider {
  return new EnsembleModelProvider({
    panelists: [1, 2, 3, 4].map(index => ({
      modelId: `model-${index}`,
      model: fixedProvider("duplicate-provider", { message: `idea-${index}`, toolCalls: [], usage: { inputTokens: index } })
    })),
    synthesizer,
    synthesizerModelId: "judge-model"
  });
}

describe("corrective ensemble attempt identity", () => {
  it("creates disjoint invocation identities with explicit provider and model provenance", async () => {
    // Given
    const model = ensemble(fixedProvider("duplicate-provider", { message: "synthesis", toolCalls: [], usage: { outputTokens: 2 } }));

    // When
    const [first, second, third] = await Promise.all([model.complete(request), model.complete(request), model.complete(request)]);

    // Then
    const attempts = [first, second, third].map(result => result.directAttempts ?? []);
    expect(attempts.every(group => new Set(group.map(attempt => attempt.attemptId)).size === 5)).toBe(true);
    expect(new Set(attempts.flatMap(group => group.map(attempt => attempt.attemptId))).size).toBe(15);
    expect(attempts[0].map(attempt => [attempt.provider, attempt.model])).toEqual([
      ["duplicate-provider", "model-1"],
      ["duplicate-provider", "model-2"],
      ["duplicate-provider", "model-3"],
      ["duplicate-provider", "model-4"],
      ["duplicate-provider", "judge-model"]
    ]);
  });

  it("passes the exact caller signal to synthesis and lets abort identity win after completion", async () => {
    // Given
    const controller = new AbortController();
    const reason = new StrongCodeError("CANCELLED", "corrective synthesis abort");
    let synthesisSignal: AbortSignal | undefined;
    const synthesizer: ModelProvider = {
      name: "judge-provider",
      async complete(synthesisRequest) {
        synthesisSignal = synthesisRequest.signal;
        controller.abort(reason);
        return { message: "late synthesis", toolCalls: [] };
      }
    };

    // When
    const completion = ensemble(synthesizer).complete({ ...request, signal: controller.signal });

    // Then
    await expect(completion).rejects.toBe(reason);
    expect(synthesisSignal).toBe(controller.signal);
  });

  it("does not invoke panelists for an already aborted ensemble request", async () => {
    // Given
    const controller = new AbortController();
    const reason = new StrongCodeError("CANCELLED", "pre-aborted ensemble");
    controller.abort(reason);
    let calls = 0;
    const panelists = [1, 2, 3, 4].map(index => ({
      modelId: `model-${index}`,
      model: { name: "provider", async complete() { calls += 1; return { message: "late", toolCalls: [] }; } }
    }));
    const model = new EnsembleModelProvider({ panelists });

    // When
    const completion = model.complete({ ...request, signal: controller.signal });

    // Then
    await expect(completion).rejects.toBe(reason);
    expect(calls).toBe(0);
  });
});
