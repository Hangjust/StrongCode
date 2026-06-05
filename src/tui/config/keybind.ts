export type TuiKeybindCommand =
  | "app_exit"
  | "command_palette"
  | "session_new"
  | "session_list"
  | "model_picker"
  | "theme_picker"
  | "status"
  | "prompt_history_previous"
  | "prompt_history_next"
  | "prompt_submit";

export interface TuiKeybindDefinition {
  command: TuiKeybindCommand;
  description: string;
  defaults: string[];
}

export type TuiKeybindMap = Record<TuiKeybindCommand, string[]>;

export const TUI_KEYBIND_DEFINITIONS: TuiKeybindDefinition[] = [
  { command: "app_exit", description: "Exit the TUI", defaults: ["ctrl+c", "escape"] },
  { command: "command_palette", description: "Open command palette", defaults: [] },
  { command: "session_new", description: "Start a new session", defaults: [] },
  { command: "session_list", description: "List sessions", defaults: [] },
  { command: "model_picker", description: "Open model picker", defaults: [] },
  { command: "theme_picker", description: "Open theme picker", defaults: [] },
  { command: "status", description: "Show status", defaults: [] },
  { command: "prompt_history_previous", description: "Previous prompt", defaults: ["up"] },
  { command: "prompt_history_next", description: "Next prompt", defaults: ["down"] },
  { command: "prompt_submit", description: "Submit prompt", defaults: ["return"] }
];

const commandSet = new Set<TuiKeybindCommand>(TUI_KEYBIND_DEFINITIONS.map(definition => definition.command));

export function defaultTuiKeybinds(): TuiKeybindMap {
  return Object.fromEntries(TUI_KEYBIND_DEFINITIONS.map(definition => [definition.command, [...definition.defaults]])) as TuiKeybindMap;
}

export function parseTuiKeybinds(value: unknown): TuiKeybindMap {
  const result = defaultTuiKeybinds();
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;

  for (const [command, bindings] of Object.entries(value)) {
    if (!commandSet.has(command as TuiKeybindCommand)) continue;
    if (bindings === "none") {
      result[command as TuiKeybindCommand] = [];
      continue;
    }
    if (typeof bindings === "string") {
      result[command as TuiKeybindCommand] = [bindings];
      continue;
    }
    if (Array.isArray(bindings) && bindings.every(binding => typeof binding === "string")) {
      result[command as TuiKeybindCommand] = bindings;
    }
  }

  return result;
}

export function describeKeybinds(keybinds: TuiKeybindMap): string[] {
  return TUI_KEYBIND_DEFINITIONS.map(definition => {
    const bindings = keybinds[definition.command];
    const label = bindings.length > 0 ? bindings.join(", ") : "disabled";
    return `${definition.command.padEnd(24)} ${label.padEnd(18)} ${definition.description}`;
  });
}
