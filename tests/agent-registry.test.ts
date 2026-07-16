import { describe, expect, it } from "vitest";
import {
  BUILT_IN_AGENT_DEFINITIONS,
  PRIMARY_AGENT_IDS,
  agentPromptMarkdown,
  cyclePrimaryAgent,
  getAgentDefinition,
  getAgentDisplayName,
  listAgentDefinitions
} from "../src/agents/registry";
import { listPreflightAgentDefinitions } from "../src/agents/preflight/roles";

describe("built-in agent registry", () => {
  it("registers the requested roster with stable names and order", () => {
    expect(BUILT_IN_AGENT_DEFINITIONS.map(agent => [agent.id, agent.displayName])).toEqual([
      ["tesla", "Tesla"],
      ["newton", "Newton"],
      ["jbp", "JBP"],
      ["bob-the-builder", "Bob The Builder"],
      ["hood-research-department", "Hood Research Department"],
      ["steve-jobs", "Steve Jobs"],
      ["government", "Government"],
      ["meta", "Meta"],
      ["sugar-boo", "Sugar Boo"],
      ["warren-buffer", "Warren Buffer"]
    ]);
    expect(PRIMARY_AGENT_IDS).toEqual(["tesla", "newton", "jbp", "bob-the-builder"]);
  });

  it("assigns the canonical composer roles only to primary agents", () => {
    expect(listAgentDefinitions("primary").map(agent => [agent.id, agent.primaryRole])).toEqual([
      ["tesla", "Main Agent"],
      ["newton", "Deep Worker"],
      ["jbp", "Plan Builder"],
      ["bob-the-builder", "Plan Executor"]
    ]);
    expect(listAgentDefinitions("specialist").every(agent => agent.primaryRole === undefined)).toBe(true);
  });

  it("formats canonical primary display names while leaving other names unsuffixed", () => {
    expect([
      getAgentDisplayName("tesla", "Tesla"),
      getAgentDisplayName("newton", "Newton"),
      getAgentDisplayName("jbp", "JBP"),
      getAgentDisplayName("bob-the-builder", "Bob The Builder")
    ]).toEqual([
      "Tesla - Main Agent",
      "Newton - Deep Worker",
      "JBP - Plan Builder",
      "Bob The Builder - Plan Executor"
    ]);
    expect(getAgentDisplayName("government", "Government")).toBe("Government");
    expect(getAgentDisplayName("custom", "My Custom Agent")).toBe("My Custom Agent");
  });

  it("derives primary roles only from exact canonical built-in identities", () => {
    expect(getAgentDisplayName("custom-agent", "Tesla")).toBe("Tesla");
    expect(getAgentDisplayName("tesla", "Ada")).toBe("Ada - Main Agent");
    expect(getAgentDisplayName("tesla", "JBP")).toBe("JBP - Main Agent");
    expect(getAgentDisplayName("Sisyphus", "Sisyphus")).toBe("Sisyphus");
  });

  it("resolves compatibility aliases without creating duplicate entries", () => {
    expect(getAgentDefinition("Sisyphus")?.id).toBe("tesla");
    expect(getAgentDefinition("Deep Agent")?.id).toBe("newton");
    expect(getAgentDefinition("Plan Builder")?.id).toBe("jbp");
    expect(getAgentDefinition("Atlas-Plan Builder")?.id).toBe("bob-the-builder");
    expect(getAgentDefinition("Warren Buffett")?.id).toBe("warren-buffer");
    expect(listAgentDefinitions()).toHaveLength(10);
  });

  it("records OMO inspiration separately from compatibility aliases", () => {
    expect(listAgentDefinitions().filter(agent => agent.omoInspiration).map(agent => [agent.id, agent.omoInspiration])).toEqual([
      ["tesla", "Sisyphus"],
      ["newton", "Hephaestus"],
      ["jbp", "Prometheus"],
      ["bob-the-builder", "Atlas"]
    ]);
  });

  it("cycles only the four primary agents in both directions", () => {
    expect(cyclePrimaryAgent("tesla").id).toBe("newton");
    expect(cyclePrimaryAgent("newton").id).toBe("jbp");
    expect(cyclePrimaryAgent("jbp").id).toBe("bob-the-builder");
    expect(cyclePrimaryAgent("bob-the-builder").id).toBe("tesla");
    expect(cyclePrimaryAgent("tesla", -1).id).toBe("bob-the-builder");
    expect(cyclePrimaryAgent("government").id).toBe("tesla");
  });

  it("encodes the four-model brainstorm and approval-gated plan handoff", () => {
    const hood = getAgentDefinition("hood");
    const jbp = getAgentDefinition("jbp");
    const bob = getAgentDefinition("bob");
    expect(hood?.orchestration).toMatchObject({ strategy: "ensemble", minimumDistinctModels: 4, maximumDistinctModels: 5 });
    expect(jbp?.orchestration).toMatchObject({ strategy: "plan-only", handoffTo: "bob-the-builder", requiresExplicitApproval: true });
    expect(bob?.orchestration).toMatchObject({ strategy: "execute-plan", receivesFrom: "jbp", requiresExplicitApproval: true });
    expect(jbp?.systemPrompt).toContain("do not implement");
    expect(bob?.systemPrompt).toContain("explicitly approved");
  });

  it("carries the transferable primary-agent behavior contracts without OMO runtime machinery", () => {
    const prompts = Object.fromEntries(listAgentDefinitions("primary").map(agent => [agent.id, agent.systemPrompt.toLowerCase()]));

    expect(prompts.tesla).toMatch(/delegate|delegation/);
    expect(prompts.tesla).toMatch(/own.*outcome|outcome.*owner/);
    expect(prompts.tesla).toMatch(/integrat|verify/);
    expect(prompts.newton).toMatch(/goal|outcome/);
    expect(prompts.newton).toMatch(/explore|inspect|map/);
    expect(prompts.newton).toMatch(/implement|changing code/);
    expect(prompts.newton).toMatch(/surface|observable/);
    expect(prompts.jbp).toMatch(/plan.*do not implement|do not implement.*plan/);
    expect(prompts.jbp).toMatch(/decision-complete|executable/);
    expect(prompts.jbp).toContain("/start-work");
    expect(prompts["bob-the-builder"]).toMatch(/approved.*jbp plan|jbp plan.*approved/);
    expect(prompts["bob-the-builder"]).toMatch(/dependenc/);
    expect(prompts["bob-the-builder"]).toMatch(/continue|next/);
    expect(prompts["bob-the-builder"]).toMatch(/checkpoint|verification gate/);
    expect(prompts["bob-the-builder"]).toMatch(/own.*integration|integration.*owner/);

    for (const systemPrompt of Object.values(prompts)) {
      expect(systemPrompt).not.toMatch(/\.omo|boulder|notepad|task_id|background id|category=/);
    }
  });

  it("produces review-only prompt documentation without losing model preferences", () => {
    const markdown = listAgentDefinitions("specialist")
      .map(agentPromptMarkdown)
      .find(document => document.startsWith("# Steve Jobs")) ?? "";
    expect(markdown).toContain("# Steve Jobs");
    expect(markdown).toContain("GPT 5.6");
    expect(markdown).toContain("Edits to this file do not affect runtime");
    expect(markdown).toContain("## System prompt");
  });

  it("documents role metadata and the canonical prompt for every primary agent", () => {
    for (const agent of listAgentDefinitions("primary")) {
      const markdown = agentPromptMarkdown(agent);
      expect(markdown).toContain(`- Role: ${agent.role}`);
      expect(markdown).toContain(`- Primary role: \`${agent.primaryRole}\``);
      expect(markdown).toContain(agent.systemPrompt);
      expect(markdown).toContain(`- OMO design inspiration: ${agent.omoInspiration}`);
      expect(markdown).toContain(`- Compatibility alias: ${agent.legacyName}`);
      expect(markdown).not.toContain("Previous name:");
    }
  });

  it("places the review-only runtime notice before metadata for every built-in agent", () => {
    for (const agent of listAgentDefinitions()) {
      const markdown = agentPromptMarkdown(agent);
      const noticeIndex = markdown.indexOf("Generated review-only mirror");
      expect(noticeIndex).toBeGreaterThan(markdown.indexOf(`# ${agent.displayName}`));
      expect(noticeIndex).toBeLessThan(markdown.indexOf(`- ID: \`${agent.id}\``));
      expect(markdown).toContain("Edits to this file do not affect runtime");
      expect(markdown).toContain("AgentDefinition.systemPrompt");
      expect(markdown).toContain("AGENTS.md");
      expect(markdown).toContain("configured addenda");
      if (agent.omoInspiration) {
        expect(markdown).toContain("does not mean this role had a previous StrongCode identity");
      }
      expect(markdown).not.toContain("Previous name:");
      expect(markdown).toContain("not runtime-loaded");
    }
  });

  it("keeps preflight roles hidden from user rosters while exposing a diagnostic list", () => {
    expect(listAgentDefinitions().map(agent => agent.id)).not.toContain("$summary");
    expect(BUILT_IN_AGENT_DEFINITIONS.map(agent => agent.id)).not.toContain("$summary-analysis");
    expect(listPreflightAgentDefinitions().map(agent => agent.id)).toEqual([
      "$summary",
      "$summary-analysis",
      "$summary-explorer"
    ]);
    expect(PRIMARY_AGENT_IDS).toEqual(["tesla", "newton", "jbp", "bob-the-builder"]);
  });
});
