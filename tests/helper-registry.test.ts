import { describe, expect, it } from "vitest";
import {
  ENABLED_HELPER_IDS,
  HELPER_DEFINITIONS,
  HELPER_IDS,
  getHelperDefinition,
  listHelperDefinitions
} from "../src/agents/helper-registry";
import { PRIMARY_AGENT_IDS, getAgentDefinition } from "../src/agents/registry";

const EXPECTED_HELPER_IDS = [
  "explore",
  "librarian",
  "oracle",
  "metis",
  "momus",
  "multimodal-looker",
  "plan",
  "build",
  "general",
  "strongcode-worker"
] as const;

const EXPECTED_ENABLED_HELPER_IDS = ["explore", "librarian", "oracle", "metis", "momus"] as const;

describe("helper registry", () => {
  it("locks the exact ten helper IDs and five enabled defaults", () => {
    const definitions = listHelperDefinitions();

    expect(HELPER_IDS).toEqual(EXPECTED_HELPER_IDS);
    expect(ENABLED_HELPER_IDS).toEqual(EXPECTED_ENABLED_HELPER_IDS);
    expect(definitions.map(definition => definition.id)).toEqual(EXPECTED_HELPER_IDS);
    expect(definitions.filter(definition => definition.enabledByDefault).map(definition => definition.id)).toEqual(EXPECTED_ENABLED_HELPER_IDS);
    expect(definitions.filter(definition => !definition.enabledByDefault).map(definition => definition.id)).toEqual([
      "multimodal-looker",
      "plan",
      "build",
      "general",
      "strongcode-worker"
    ]);
  });

  it("keeps helper lookup separate from built-in aliases and primary cycling", () => {
    expect(PRIMARY_AGENT_IDS).toEqual(["tesla", "newton", "jbp", "bob-the-builder"]);
    expect(getAgentDefinition("general")?.id).toBe("tesla");
    expect(getHelperDefinition("general")?.id).toBe("general");
  });

  it("keeps disabled definitions inert but administratively queryable", () => {
    const build = getHelperDefinition("build");
    const disabledDefinitions = listHelperDefinitions(false);

    expect(build).toMatchObject({ id: "build", enabledByDefault: false });
    expect(disabledDefinitions.map(definition => definition.id)).toEqual([
      "multimodal-looker",
      "plan",
      "build",
      "general",
      "strongcode-worker"
    ]);
    expect(disabledDefinitions.every(definition => definition.modelPreferences.length === 0)).toBe(true);
    expect(disabledDefinitions.every(definition => definition.toolCeiling.tools.length === 0)).toBe(true);
  });

  it("assigns fast chains to researchers and reasoning chains to reviewers", () => {
    expect(getHelperDefinition("explore")?.modelPreferences.map(preference => preference.label)).toEqual([
      "Gemini Flash",
      "Claude Haiku",
      "GPT Mini"
    ]);
    expect(getHelperDefinition("librarian")?.modelPreferences.map(preference => preference.label)).toEqual([
      "Gemini Flash",
      "Claude Haiku",
      "GPT Mini"
    ]);

    for (const id of ["oracle", "metis", "momus"] as const) {
      expect(getHelperDefinition(id)?.modelPreferences.map(preference => preference.label)).toEqual([
        "GPT 5.6 SOL Ultra",
        "Claude Opus 4.8",
        "Gemini 3.1 Pro"
      ]);
    }
  });

  it("defines complete backstage, model, tool, and prompt metadata", () => {
    for (const definition of HELPER_DEFINITIONS) {
      expect(definition.description.length).toBeGreaterThan(0);
      expect(definition.systemPrompt.length).toBeGreaterThan(0);
      expect(definition.backstagePolicy).toEqual({
        visibility: "backstage",
        activation: "delegated-only",
        maySpawnChildren: false
      });
      expect(definition.toolCeiling.canUseShell).toBe(false);
      expect(definition.toolCeiling.canWriteWorkspace).toBe(false);
    }

    for (const definition of listHelperDefinitions(true)) {
      expect(definition.modelPreferences.length).toBeGreaterThan(1);
    }
  });

  it("returns undefined for malformed or unknown helper IDs", () => {
    expect(getHelperDefinition(" Explore ")).toBeUndefined();
    expect(getHelperDefinition("unknown-helper")).toBeUndefined();
    expect(getHelperDefinition("")).toBeUndefined();
  });

  it("keeps canonical definitions deeply immutable under runtime mutation attacks", () => {
    const explore = HELPER_DEFINITIONS[0];
    const metis = HELPER_DEFINITIONS[3];
    const firstPreference = explore.modelPreferences[0];
    if (firstPreference === undefined) throw new TypeError("Explore requires a model preference");
    const originalPrompt = explore.systemPrompt;

    Reflect.set(explore, "enabledByDefault", false);
    Reflect.set(explore, "systemPrompt", "MUTATED");
    Reflect.set(explore.backstagePolicy, "maySpawnChildren", true);
    Reflect.set(explore.toolCeiling, "canWriteWorkspace", true);
    Reflect.set(explore.toolCeiling.tools, explore.toolCeiling.tools.length, "write_file");
    Reflect.set(firstPreference, "label", "Injected");
    Reflect.set(firstPreference.patterns, 0, "injected");
    Reflect.set(explore.modelPreferences, explore.modelPreferences.length, { label: "Injected", patterns: ["injected"] });

    expect(Object.isFrozen(HELPER_IDS)).toBe(true);
    expect(Object.isFrozen(ENABLED_HELPER_IDS)).toBe(true);
    expect(Object.isFrozen(HELPER_DEFINITIONS)).toBe(true);
    expect(Object.isFrozen(explore)).toBe(true);
    expect(Object.isFrozen(explore.backstagePolicy)).toBe(true);
    expect(Object.isFrozen(explore.toolCeiling)).toBe(true);
    expect(Object.isFrozen(explore.toolCeiling.tools)).toBe(true);
    expect(Object.isFrozen(explore.modelPreferences)).toBe(true);
    expect(Object.isFrozen(firstPreference)).toBe(true);
    expect(Object.isFrozen(firstPreference.patterns)).toBe(true);
    expect(getHelperDefinition("explore")).toMatchObject({
      enabledByDefault: true,
      systemPrompt: originalPrompt,
      backstagePolicy: { maySpawnChildren: false },
      toolCeiling: { canWriteWorkspace: false, tools: ["list_files", "read_file", "find_files", "ripgrep"] }
    });
    expect(getHelperDefinition("explore")?.modelPreferences.map(preference => preference.label)).toEqual([
      "Gemini Flash",
      "Claude Haiku",
      "GPT Mini"
    ]);
    expect(getHelperDefinition("explore")?.modelPreferences[0]?.patterns).toEqual(["gemini-flash", "gemini flash"]);
    expect(metis.toolCeiling.tools).toEqual(["list_files", "read_file", "find_files", "ripgrep"]);
  });
});
