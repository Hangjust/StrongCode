export type FullTuiCommandRoute = "providers" | "models" | "help" | "summary";
export type SlashCommandHelpSection = "models-agents" | "session";

export type SlashCommandPaletteRow = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly slash: string;
};

export type SlashCommandHelpRow = {
  readonly section: SlashCommandHelpSection;
  readonly text: string;
  readonly order: number;
};

type SlashCommandDefinitionShape = {
  readonly canonical: string;
  readonly triggers: readonly (SlashCommandPaletteRow & {
    readonly fullTuiRoute?: FullTuiCommandRoute;
    readonly modelAction?: "open" | "list";
  })[];
  readonly plainAliases?: readonly string[];
  readonly help: readonly SlashCommandHelpRow[];
  readonly availability?: {
    readonly requiredAgent: string;
    readonly unavailableMessage: string;
  };
};

export const slashCommandRegistry = [
  {
    canonical: "connect",
    triggers: [{ id: "connect", title: "Connect", description: "Open provider login and API-key setup", slash: "/connect", fullTuiRoute: "providers" }],
    help: [{ section: "models-agents", text: "  /connect           Open provider login / API-key setup", order: 5 }]
  },
  {
    canonical: "agent",
    triggers: [
      { id: "agent", title: "Agent", description: "List or activate StrongCode agents", slash: "/agent" },
      { id: "agents", title: "Agents", description: "Alias for /agent", slash: "/agents" }
    ],
    help: [{ section: "models-agents", text: "  /agent [name]      List or activate any agent", order: 6 }]
  },
  {
    canonical: "start-work",
    triggers: [{ id: "start-work", title: "Start Work", description: "Approve a JBP plan and hand it to Bob The Builder", slash: "/start-work" }],
    help: [{ section: "models-agents", text: "  /start-work        Approve JBP plan → Bob The Builder", order: 7 }],
    availability: {
      requiredAgent: "jbp",
      unavailableMessage: "Start-work requires an active JBP planning session. Switch with /agent jbp, create the plan, review it, then explicitly run /start-work."
    }
  },
  {
    canonical: "compact",
    triggers: [{ id: "compact", title: "Compact", description: "Compact active context", slash: "/compact" }],
    help: [{ section: "session", text: "  /compact           Compact active context", order: 8 }]
  },
  {
    canonical: "computer-use",
    triggers: [{ id: "computer-use", title: "Computer Use", description: "Enable computer use for one turn", slash: "/computer use" }],
    help: [{ section: "session", text: "  /computer use [task] Enable computer use for one turn", order: 9 }]
  },
  {
    canonical: "model",
    triggers: [
      { id: "model", title: "Model", description: "Choose a model for the active agent", slash: "/model", fullTuiRoute: "models", modelAction: "open" },
      { id: "models", title: "Models", description: "List available model choices", slash: "/models", modelAction: "list" }
    ],
    help: [
      { section: "models-agents", text: "  /model             Pick a model for the active agent", order: 1 },
      { section: "models-agents", text: "  /model <id>        Set the active agent model directly", order: 2 },
      { section: "models-agents", text: "  /model <agent> <id> Set a specific agent model", order: 3 },
      { section: "models-agents", text: "  /models            List available model choices", order: 4 }
    ]
  },
  {
    canonical: "summary",
    triggers: [{ id: "summary", title: "Summary", description: "Open session telemetry and the latest turn", slash: "/summary", fullTuiRoute: "summary" }],
    help: [{ section: "session", text: "  /summary / F2     Tokens · cost · tools · MCPs", order: 10 }]
  },
  {
    canonical: "help",
    triggers: [{ id: "help", title: "Help", description: "Show commands and keyboard shortcuts", slash: "/help", fullTuiRoute: "help" }],
    help: []
  },
  {
    canonical: "exit",
    triggers: [{ id: "exit", title: "Exit", description: "Close StrongCode", slash: "/exit" }],
    plainAliases: ["exit", "quit"],
    help: [{ section: "session", text: "  /exit              Exit StrongCode", order: 11 }]
  }
] as const satisfies readonly SlashCommandDefinitionShape[];

export type CanonicalSlashCommand = (typeof slashCommandRegistry)[number]["canonical"];
type SlashCommandDefinition = (typeof slashCommandRegistry)[number];
type SlashCommandTrigger = SlashCommandDefinition["triggers"][number];
type SlashCommandMatch = {
  readonly definition: SlashCommandDefinition;
  readonly trigger: SlashCommandTrigger;
};

const slashCommandMatches: readonly SlashCommandMatch[] = (() => {
  const matches: SlashCommandMatch[] = [];
  for (const definition of slashCommandRegistry) {
    for (const trigger of definition.triggers) matches.push({ definition, trigger });
  }
  return matches;
})();

export type ParsedSlashCommand =
  | { readonly command: "connect"; readonly rawArgs: string }
  | { readonly command: "agent"; readonly action: "list" | "next" | "previous" }
  | { readonly command: "agent"; readonly action: "select"; readonly target: string }
  | { readonly command: "start-work" }
  | { readonly command: "compact" }
  | { readonly command: "computer-use" }
  | { readonly command: "model"; readonly action: "open" }
  | { readonly command: "model"; readonly action: "list" }
  | { readonly command: "model"; readonly action: "select"; readonly modelId: string; readonly agentId?: string }
  | { readonly command: "summary" }
  | { readonly command: "help" }
  | { readonly command: "exit" }
  | { readonly command: "unknown"; readonly input: string };

export const slashCommandPaletteRows: readonly SlashCommandPaletteRow[] = slashCommandMatches.map(match => match.trigger);
export const slashCommandHelpRows: readonly SlashCommandHelpRow[] = (() => {
  const rows: SlashCommandHelpRow[] = [];
  for (const command of slashCommandRegistry) {
    for (const row of command.help) rows.push(row);
  }
  return rows.sort((left, right) => left.order - right.order);
})();

type CommandInput = {
  readonly trimmed: string;
  readonly token: string;
  readonly normalizedToken: string;
  readonly rawArgs?: string;
};

function tokenizeCommandInput(input: string): CommandInput | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  const separatorIndex = trimmed.search(/\s/);
  const token = separatorIndex === -1 ? trimmed : trimmed.slice(0, separatorIndex);
  const rawArgs = separatorIndex === -1 ? undefined : trimmed.slice(separatorIndex).trimStart();
  return rawArgs === undefined
    ? { trimmed, token, normalizedToken: token.toLowerCase() }
    : { trimmed, token, normalizedToken: token.toLowerCase(), rawArgs };
}

export function parseSlashCommand(input: string): ParsedSlashCommand | undefined {
  const parsedInput = tokenizeCommandInput(input);
  if (!parsedInput) return undefined;
  const normalizedInput = parsedInput.trimmed.toLowerCase();
  const slashMatch = slashCommandMatches.find(match => (
    normalizedInput === match.trigger.slash || normalizedInput.startsWith(`${match.trigger.slash} `)
  ));
  const definition = slashMatch?.definition ?? slashCommandRegistry.find(command =>
    "plainAliases" in command && command.plainAliases.some(alias => alias === parsedInput.normalizedToken)
  );
  if (!definition) return parsedInput.normalizedToken.startsWith("/") ? { command: "unknown", input: parsedInput.trimmed } : undefined;

  switch (definition.canonical) {
    case "connect":
      return { command: "connect", rawArgs: parsedInput.rawArgs ?? "" };
    case "agent": {
      if (parsedInput.rawArgs === undefined) return { command: "agent", action: "list" };
      const normalizedTarget = parsedInput.rawArgs.toLowerCase();
      if (normalizedTarget === "next") return { command: "agent", action: "next" };
      if (normalizedTarget === "previous" || normalizedTarget === "prev") return { command: "agent", action: "previous" };
      return { command: "agent", action: "select", target: parsedInput.rawArgs };
    }
    case "start-work":
    case "compact":
    case "summary":
    case "help":
    case "exit":
      return parsedInput.rawArgs === undefined
        ? { command: definition.canonical }
        : { command: "unknown", input: parsedInput.trimmed };
    case "computer-use":
      return { command: "computer-use" };
    case "model": {
      if (slashMatch && "modelAction" in slashMatch.trigger && slashMatch.trigger.modelAction === "list") {
        return parsedInput.rawArgs === undefined
          ? { command: "model", action: "list" }
          : { command: "unknown", input: parsedInput.trimmed };
      }
      if (parsedInput.rawArgs === undefined) return { command: "model", action: "open" };
      const separatorIndex = parsedInput.rawArgs.search(/\s/);
      if (separatorIndex === -1) return { command: "model", action: "select", modelId: parsedInput.rawArgs };
      return {
        command: "model",
        action: "select",
        agentId: parsedInput.rawArgs.slice(0, separatorIndex),
        modelId: parsedInput.rawArgs.slice(separatorIndex).trimStart()
      };
    }
    default:
      return assertNever(definition);
  }
}

export function slashCommandAllowedDuringTurn(command: ParsedSlashCommand): boolean {
  switch (command.command) {
    case "unknown":
    case "exit":
    case "help":
    case "summary":
      return true;
    case "connect":
      return command.rawArgs.length === 0;
    case "agent":
      return command.action === "list";
    case "model":
      return command.action === "open" || command.action === "list";
    case "start-work":
    case "compact":
    case "computer-use":
      return false;
    default:
      return assertNever(command);
  }
}

export function slashCommandAvailability(command: CanonicalSlashCommand, activeAgentId: string | undefined): { readonly available: true } | { readonly available: false; readonly message: string } {
  const definition = slashCommandRegistry.find(candidate => candidate.canonical === command);
  if (!definition || !("availability" in definition) || definition.availability.requiredAgent === activeAgentId) return { available: true };
  return { available: false, message: definition.availability.unavailableMessage };
}

export function fullTuiRouteForInput(input: string): FullTuiCommandRoute | undefined {
  const parsedInput = tokenizeCommandInput(input);
  if (!parsedInput || parsedInput.rawArgs !== undefined) return undefined;
  const match = slashCommandMatches.find(candidate => candidate.trigger.slash === parsedInput.normalizedToken);
  return match && "fullTuiRoute" in match.trigger ? match.trigger.fullTuiRoute : undefined;
}

export function resolveSlashSubmission(submittedText: string, selectedTrigger: string | undefined): string | undefined {
  const trimmed = submittedText.trim();
  if (!trimmed.startsWith("/") || trimmed.length === 1) return undefined;
  const parsed = parseSlashCommand(trimmed);
  if (parsed?.command !== "unknown") return trimmed;
  if (selectedTrigger && !/\s/.test(trimmed) && selectedTrigger.toLowerCase().startsWith(trimmed.toLowerCase())) return selectedTrigger;
  return trimmed;
}

function assertNever(value: never): never {
  throw new Error(`Unexpected slash command definition: ${String(value)}`);
}
