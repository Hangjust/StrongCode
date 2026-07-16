export const HELPER_IDS = Object.freeze([
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
] as const);

export type HelperId = (typeof HELPER_IDS)[number];

export const ENABLED_HELPER_IDS = Object.freeze(
  ["explore", "librarian", "oracle", "metis", "momus"] as const satisfies readonly HelperId[]
);

export type HelperModelPreference = {
  readonly label: string;
  readonly patterns: readonly string[];
};

export type HelperBackstagePolicy = {
  readonly visibility: "backstage";
  readonly activation: "delegated-only";
  readonly maySpawnChildren: false;
};

export type HelperToolCeiling = {
  readonly tools: readonly string[];
  readonly canWriteWorkspace: false;
  readonly canUseShell: false;
};

export type HelperDefinition = {
  readonly id: HelperId;
  readonly displayName: string;
  readonly description: string;
  readonly enabledByDefault: boolean;
  readonly backstagePolicy: HelperBackstagePolicy;
  readonly modelPreferences: readonly HelperModelPreference[];
  readonly toolCeiling: HelperToolCeiling;
  readonly systemPrompt: string;
};

const BACKSTAGE_POLICY = {
  visibility: "backstage",
  activation: "delegated-only",
  maySpawnChildren: false
} as const satisfies HelperBackstagePolicy;

const NO_TOOLS = {
  tools: [],
  canWriteWorkspace: false,
  canUseShell: false
} as const satisfies HelperToolCeiling;

const WORKSPACE_READ_TOOLS = {
  tools: ["list_files", "read_file", "find_files", "ripgrep"],
  canWriteWorkspace: false,
  canUseShell: false
} as const satisfies HelperToolCeiling;

const RESEARCH_TOOLS = {
  tools: ["web_search", "mcp_list_tools"],
  canWriteWorkspace: false,
  canUseShell: false
} as const satisfies HelperToolCeiling;

const FAST_MODEL_PREFERENCES = [
  { label: "Gemini Flash", patterns: ["gemini-flash", "gemini flash"] },
  { label: "Claude Haiku", patterns: ["claude-haiku", "haiku"] },
  { label: "GPT Mini", patterns: ["gpt-mini", "mini"] }
] as const satisfies readonly HelperModelPreference[];

const REASONING_MODEL_PREFERENCES = [
  { label: "GPT 5.6 SOL Ultra", patterns: ["gpt-5.6-sol-ultra", "gpt 5.6 sol ultra", "sol-ultra"] },
  { label: "Claude Opus 4.8", patterns: ["claude-opus-4.8", "opus-4.8", "opus 4.8"] },
  { label: "Gemini 3.1 Pro", patterns: ["gemini-3.1-pro", "gemini 3.1 pro"] }
] as const satisfies readonly HelperModelPreference[];

const COMMON_HELPER_RULES = `
You are a backstage StrongCode helper. Work only on the bounded assignment supplied by the parent agent. Return concise evidence and conclusions to the parent; do not address the user as the outcome owner. Never spawn another helper, broaden scope, expose secrets, overwrite unrelated dirty-worktree changes, or treat optimistic command text as proof when the observable result disagrees.
`.trim();

function helperPrompt(rolePrompt: string): string {
  return `${rolePrompt.trim()}\n\n${COMMON_HELPER_RULES}`;
}

function disabledPrompt(purpose: string): string {
  return `Reserved disabled helper definition for ${purpose}. It is administratively queryable but has no runtime model, tools, or activation.`;
}

function freezeHelperDefinition(definition: HelperDefinition): void {
  Object.freeze(definition.backstagePolicy);
  Object.freeze(definition.toolCeiling.tools);
  Object.freeze(definition.toolCeiling);
  for (const preference of definition.modelPreferences) {
    Object.freeze(preference.patterns);
    Object.freeze(preference);
  }
  Object.freeze(definition.modelPreferences);
  Object.freeze(definition);
}

function freezeHelperDefinitions<const Definitions extends readonly HelperDefinition[]>(definitions: Definitions): Readonly<Definitions> {
  definitions.forEach(freezeHelperDefinition);
  return Object.freeze(definitions);
}

export const HELPER_DEFINITIONS = freezeHelperDefinitions([
  {
    id: "explore",
    displayName: "Explore",
    description: "Maps repository code, symbols, dependencies, and behavior using read-only evidence.",
    enabledByDefault: true,
    backstagePolicy: BACKSTAGE_POLICY,
    modelPreferences: FAST_MODEL_PREFERENCES,
    toolCeiling: WORKSPACE_READ_TOOLS,
    systemPrompt: helperPrompt("Inspect the requested code area deeply enough to answer the parent accurately. Trace definitions and callers, quote exact paths, distinguish facts from inferences, and make no edits.")
  },
  {
    id: "librarian",
    displayName: "Librarian",
    description: "Finds current official documentation and trustworthy external implementation references.",
    enabledByDefault: true,
    backstagePolicy: BACKSTAGE_POLICY,
    modelPreferences: FAST_MODEL_PREFERENCES,
    toolCeiling: RESEARCH_TOOLS,
    systemPrompt: helperPrompt("Research the external library, API, or implementation question assigned by the parent. Prefer official current documentation, identify versions and source URLs, separate documented behavior from examples, and make no repository edits.")
  },
  {
    id: "oracle",
    displayName: "Oracle",
    description: "Provides high-confidence reasoning on difficult architecture, debugging, and design decisions.",
    enabledByDefault: true,
    backstagePolicy: BACKSTAGE_POLICY,
    modelPreferences: REASONING_MODEL_PREFERENCES,
    toolCeiling: NO_TOOLS,
    systemPrompt: helperPrompt("Analyze the parent’s difficult technical question from first principles. Challenge assumptions, compare viable options, identify failure modes and invariants, and return a decisive recommendation with explicit uncertainty.")
  },
  {
    id: "metis",
    displayName: "Metis",
    description: "Finds ambiguity, missing constraints, and hidden dependencies before implementation planning.",
    enabledByDefault: true,
    backstagePolicy: BACKSTAGE_POLICY,
    modelPreferences: REASONING_MODEL_PREFERENCES,
    toolCeiling: WORKSPACE_READ_TOOLS,
    systemPrompt: helperPrompt("Preflight the proposed work before implementation. Identify unstated decisions, scope traps, dependency order, acceptance gaps, and questions only the owner can answer. Return actionable planning guidance, not implementation.")
  },
  {
    id: "momus",
    displayName: "Momus",
    description: "Critically reviews implementation plans for completeness, executability, and verification quality.",
    enabledByDefault: true,
    backstagePolicy: BACKSTAGE_POLICY,
    modelPreferences: REASONING_MODEL_PREFERENCES,
    toolCeiling: WORKSPACE_READ_TOOLS,
    systemPrompt: helperPrompt("Audit the supplied plan against the real constraints and repository evidence. Return a clear pass or reject verdict, then list only concrete omissions, contradictions, unsafe assumptions, and missing verification gates. Do not implement the plan.")
  },
  {
    id: "multimodal-looker",
    displayName: "Multimodal Looker",
    description: "Reserved helper for future image, PDF, diagram, and media inspection.",
    enabledByDefault: false,
    backstagePolicy: BACKSTAGE_POLICY,
    modelPreferences: [],
    toolCeiling: NO_TOOLS,
    systemPrompt: disabledPrompt("future multimodal inspection")
  },
  {
    id: "plan",
    displayName: "Plan",
    description: "Reserved helper definition for delegated implementation planning.",
    enabledByDefault: false,
    backstagePolicy: BACKSTAGE_POLICY,
    modelPreferences: [],
    toolCeiling: NO_TOOLS,
    systemPrompt: disabledPrompt("delegated implementation planning")
  },
  {
    id: "build",
    displayName: "Build",
    description: "Reserved helper definition for delegated implementation work.",
    enabledByDefault: false,
    backstagePolicy: BACKSTAGE_POLICY,
    modelPreferences: [],
    toolCeiling: NO_TOOLS,
    systemPrompt: disabledPrompt("delegated implementation work")
  },
  {
    id: "general",
    displayName: "General",
    description: "Reserved generic helper definition kept separate from Tesla's general alias.",
    enabledByDefault: false,
    backstagePolicy: BACKSTAGE_POLICY,
    modelPreferences: [],
    toolCeiling: NO_TOOLS,
    systemPrompt: disabledPrompt("generic delegated assistance")
  },
  {
    id: "strongcode-worker",
    displayName: "StrongCode Worker",
    description: "Reserved StrongCode-specific delegated worker definition.",
    enabledByDefault: false,
    backstagePolicy: BACKSTAGE_POLICY,
    modelPreferences: [],
    toolCeiling: NO_TOOLS,
    systemPrompt: disabledPrompt("StrongCode-specific delegated work")
  }
] as const satisfies readonly HelperDefinition[]);

function copyHelperDefinition(definition: HelperDefinition): HelperDefinition {
  return {
    ...definition,
    backstagePolicy: { ...definition.backstagePolicy },
    modelPreferences: definition.modelPreferences.map(preference => ({ ...preference, patterns: [...preference.patterns] })),
    toolCeiling: { ...definition.toolCeiling, tools: [...definition.toolCeiling.tools] }
  };
}

export function getHelperDefinition(value: string): HelperDefinition | undefined {
  const definition = HELPER_DEFINITIONS.find(helper => helper.id === value);
  return definition ? copyHelperDefinition(definition) : undefined;
}

export function listHelperDefinitions(enabledByDefault?: boolean): HelperDefinition[] {
  return HELPER_DEFINITIONS
    .filter(definition => enabledByDefault === undefined || definition.enabledByDefault === enabledByDefault)
    .map(copyHelperDefinition);
}
