import { BUILT_IN_AGENT_DEFINITIONS } from "../src/agents/registry";
import { createRuntimeToolRegistry } from "../src/mcp/runtime-registry";
import { DeepSeekQuestionSimplifier } from "../src/questions/simplifier";
import { QuestionRuntimeRegistrationError, installQuestionRuntime } from "../src/tui/question/runtime";
import { AUDITED_READ_ONLY_TOOL_PATTERNS, DEFAULT_AGENT_TOOLS, DEFAULT_TOOL_PERMISSIONS } from "../src/tools/defaults";
import { createDefaultToolRegistry } from "../src/tools/registry";
import { tempWorkspace } from "./helpers";

const questionInput = {
  questions: [{
    id: "runtime",
    header: "Runtime choice",
    question: "Which runtime should we use?",
    options: [
      { id: "node", label: "Node.js", description: "Use the current LTS." },
      { id: "bun", label: "Bun", description: "Use the fast runtime." }
    ]
  }]
};

describe("OpenTUI question runtime", () => {
  it("keeps generic registries free of question", async () => {
    // Given
    const workspace = await tempWorkspace();
    const defaultRegistry = createDefaultToolRegistry();
    const runtimeRegistry = await createRuntimeToolRegistry(workspace.context, { allowMcp: false });

    // When / Then
    expect(defaultRegistry.get("question")).toBeUndefined();
    expect(runtimeRegistry.get("question")).toBeUndefined();
    await runtimeRegistry.close();
  });

  it("installs one TUI question tool, exposes the DeepSeek simplifier, and closes pending work", async () => {
    // Given
    const workspace = await tempWorkspace();
    workspace.config.providers.deepseek = {
      type: "openai-compatible",
      displayName: "DeepSeek",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      baseUrl: "https://api.deepseek.com",
      enabled: true
    };
    workspace.config.permissions.tools.question = "allow";
    const registry = createDefaultToolRegistry();

    // When
    const runtime = installQuestionRuntime(registry, {
      context: workspace.context,
      authStore: { async get() { return undefined; }, async all() { return {}; } },
      allowEnvironmentCredentials: true
    });
    const tool = registry.get("question");
    if (!tool) throw new Error("question tool was not registered");
    const pending = tool.execute(questionInput, workspace.context);
    await Promise.resolve();
    await registry.close();

    // Then
    expect(registry.list().filter(candidate => candidate.name === "question")).toHaveLength(1);
    expect(runtime.simplifier).toBeInstanceOf(DeepSeekQuestionSimplifier);
    await expect(pending).resolves.toMatchObject({ ok: true, value: { content: '{"outcome":"dismissed"}' } });
  });

  it("rejects duplicate question registration with a typed error", async () => {
    // Given
    const workspace = await tempWorkspace();
    const registry = createDefaultToolRegistry();
    const options = {
      context: workspace.context,
      authStore: { async get() { return undefined; }, async all() { return {}; } },
      allowEnvironmentCredentials: false
    };
    installQuestionRuntime(registry, options);

    // When / Then
    expect(() => installQuestionRuntime(registry, options)).toThrow(QuestionRuntimeRegistrationError);
    await registry.close();
  });

  it("allows question in generated defaults and read-only roles", () => {
    // Given / When / Then
    expect(DEFAULT_AGENT_TOOLS).toContain("question");
    expect(DEFAULT_TOOL_PERMISSIONS.question).toBe("allow");
    expect(AUDITED_READ_ONLY_TOOL_PATTERNS.has("question")).toBe(true);
  });

  it("instructs every built-in agent to ask easy-English batched questions when available", () => {
    // Given / When / Then
    for (const agent of BUILT_IN_AGENT_DEFINITIONS) {
      expect(agent.systemPrompt).toContain("When the question tool is available and user input materially affects work");
      expect(agent.systemPrompt).toContain("very easy English");
      expect(agent.systemPrompt).toContain("exact technical terms");
    }
  });
});
