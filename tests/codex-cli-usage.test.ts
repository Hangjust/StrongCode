import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexCliModelProvider } from "../src/models/codex-cli-provider";

const request = { prompt: "usage", sessionId: "codex-usage", messages: [], tools: [] };

async function fixtureProvider(events: readonly unknown[]): Promise<{ readonly provider: CodexCliModelProvider; readonly root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "strongcode-codex-usage-"));
  const fixturePath = path.join(root, "codex-events.cjs");
  await writeFile(fixturePath, `for (const event of ${JSON.stringify(events)}) process.stdout.write(JSON.stringify(event) + "\\n");\n`, "utf8");
  const commandPath = path.join(root, process.platform === "win32" ? "codex.cmd" : "codex");
  const source = process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${fixturePath}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${fixturePath}" "$@"\n`;
  await writeFile(commandPath, source, "utf8");
  if (process.platform !== "win32") await chmod(commandPath, 0o755);
  await mkdir(path.join(root, "workspace"), { recursive: true });
  return {
    root,
    provider: new CodexCliModelProvider({
      providerId: "codex-cli",
      modelId: "gpt-test",
      modelConfig: { model: "gpt-test" },
      command: commandPath,
      cwd: path.join(root, "workspace")
    })
  };
}

describe("Codex CLI terminal usage", () => {
  it.each([
    ["empty", {}],
    ["all malformed", { input_tokens: -1, cached_input_tokens: "1", output_tokens: 1.5, reasoning_output_tokens: null }],
    ["missing", undefined],
    ["null", null],
    ["unknown-only", { total_tokens: 13 }]
  ])("retains the last valid snapshot after a wholly invalid %s terminal event", async (_caseName, invalidUsage) => {
    // Given
    const fixture = await fixtureProvider([
      { type: "turn.completed", usage: { input_tokens: 8, output_tokens: 5 } },
      { type: "turn.completed", usage: invalidUsage },
      { type: "agent_message", message: "retained" }
    ]);

    try {
      // When
      const result = await fixture.provider.complete(request);

      // Then
      expect(result.message).toBe("retained");
      expect(result.usage).toEqual({ inputTokens: 8, outputTokens: 5 });
      expect(result.providerUsage?.map(metric => [metric.category, metric.tokens])).toEqual([["input", 8], ["output", 5]]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("atomically replaces a full snapshot with a valid partial literal-zero snapshot", async () => {
    // Given
    const fixture = await fixtureProvider([
      { type: "turn.completed", usage: { input_tokens: 9, cached_input_tokens: 4, output_tokens: 7, reasoning_output_tokens: 3 } },
      { type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: -1, output_tokens: "bad" } },
      { type: "agent_message", message: "partial zero" }
    ]);

    try {
      // When
      const result = await fixture.provider.complete(request);

      // Then
      expect(result.usage).toEqual({ inputTokens: 0 });
      expect(result.providerUsage).toEqual([
        { source: "provider-reported", provider: "openai-codex-cli", field: "turn.completed.usage.input_tokens", category: "input", tokens: 0, semantics: "input-includes-cache" }
      ]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("uses a lower last valid snapshot after a duplicate and ignores a malformed tail", async () => {
    // Given
    const high = { input_tokens: 12, output_tokens: 8 };
    const fixture = await fixtureProvider([
      { type: "turn.completed", usage: high },
      { type: "turn.completed", usage: high },
      { type: "turn.completed", usage: { input_tokens: 2, output_tokens: 1 } },
      { type: "turn.completed", usage: { input_tokens: "invalid" } },
      { type: "agent_message", message: "lower" }
    ]);

    try {
      // When
      const result = await fixture.provider.complete(request);

      // Then
      expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 1 });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    ["valid then message then invalid", [
      { type: "turn.completed", usage: { input_tokens: 3 } },
      { type: "agent_message", message: "middle" },
      { type: "turn.completed", usage: null }
    ]],
    ["message then valid", [
      { type: "agent_message", message: "first" },
      { type: "turn.completed", usage: { output_tokens: 4 } }
    ]],
    ["valid then message then valid", [
      { type: "turn.completed", usage: { input_tokens: 7 } },
      { type: "agent_message", message: "between" },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 0 } }
    ]]
  ] as const)("retains message and last valid usage for %s ordering", async (_caseName, events) => {
    // Given
    const fixture = await fixtureProvider(events);

    try {
      // When
      const result = await fixture.provider.complete(request);

      // Then
      expect(result.message).toMatch(/middle|first|between/);
      expect(result.usage).toBeDefined();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("accepts an explicit all-zero snapshot and rejects usage without a message", async () => {
    // Given
    const zero = await fixtureProvider([
      { type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } },
      { type: "agent_message", message: "zero" }
    ]);
    const usageOnly = await fixtureProvider([{ type: "turn.completed", usage: { input_tokens: 1 } }]);

    try {
      // When
      const zeroResult = await zero.provider.complete(request);
      const usageOnlyResult = usageOnly.provider.complete(request);

      // Then
      expect(zeroResult.usage).toEqual({ inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0 });
      await expect(usageOnlyResult).rejects.toMatchObject({ code: "MODEL_ERROR" });
    } finally {
      await Promise.all([rm(zero.root, { recursive: true, force: true }), rm(usageOnly.root, { recursive: true, force: true })]);
    }
  });

  it("uses the last terminal snapshot independently of agent-message ordering", async () => {
    // Given
    const fixture = await fixtureProvider([
      { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 1, output_tokens: 1, reasoning_output_tokens: 1 } },
      { type: "item.completed", item: { type: "agent_message", text: "delegated response" } },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 6, reasoning_output_tokens: 2 } }
    ]);

    try {
      // When
      const result = await fixture.provider.complete(request);

      // Then
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 6, reasoningTokens: 2, cacheReadTokens: 4 });
      expect(result.providerUsage).toEqual([
        { source: "provider-reported", provider: "openai-codex-cli", field: "turn.completed.usage.input_tokens", category: "input", tokens: 10, semantics: "input-includes-cache" },
        { source: "provider-reported", provider: "openai-codex-cli", field: "turn.completed.usage.cached_input_tokens", category: "cache-read", tokens: 4, semantics: "input-overlap" },
        { source: "provider-reported", provider: "openai-codex-cli", field: "turn.completed.usage.output_tokens", category: "output", tokens: 6, semantics: "output-includes-reasoning" },
        { source: "provider-reported", provider: "openai-codex-cli", field: "turn.completed.usage.reasoning_output_tokens", category: "reasoning", tokens: 2, semantics: "output-subset" }
      ]);
      expect(result.usage).not.toHaveProperty("totalTokens");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("captures completed reasoning text while keeping agent message and usage selection", async () => {
    // Given
    const fixture = await fixtureProvider([
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
      { type: "item.completed", item: { type: "reasoning", text: "first reasoning block" } },
      { type: "item.completed", item: { type: "agent_message", text: "delegated response" } },
      { type: "item.completed", item: { type: "reasoning", text: "second reasoning block" } },
      { type: "item.completed", item: { type: "reasoning", text: "   " } },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }
    ]);

    try {
      // When
      const result = await fixture.provider.complete(request);

      // Then
      expect(result.message).toBe("delegated response");
      expect(result.reasoning).toBe("first reasoning block\n\nsecond reasoning block");
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("omits malformed terminal categories independently and leaves missing usage unknown", async () => {
    // Given
    const partial = await fixtureProvider([
      { type: "turn.completed", usage: { input_tokens: 3, cached_input_tokens: -1, output_tokens: "2", reasoning_output_tokens: 0 } },
      { type: "agent_message", message: "partial" }
    ]);
    const missing = await fixtureProvider([{ type: "agent_message", message: "missing" }]);

    try {
      // When
      const partialResult = await partial.provider.complete(request);
      const missingResult = await missing.provider.complete(request);

      // Then
      expect(partialResult.usage).toEqual({ inputTokens: 3, reasoningTokens: 0 });
      expect(missingResult).not.toHaveProperty("usage");
      expect(missingResult).not.toHaveProperty("providerUsage");
    } finally {
      await Promise.all([rm(partial.root, { recursive: true, force: true }), rm(missing.root, { recursive: true, force: true })]);
    }
  });
});
