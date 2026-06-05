export interface PaletteCommand {
  id: string;
  title: string;
  description: string;
  slash: string;
}

export class CommandPalette {
  private commands: PaletteCommand[];
  private selectedIndex = 0;

  constructor(commands: PaletteCommand[]) {
    this.commands = commands;
  }

  list(): PaletteCommand[] {
    return [...this.commands];
  }

  find(input: string): PaletteCommand | undefined {
    const normalized = input.trim().toLowerCase();
    return this.commands.find(command => command.slash === normalized || command.id === normalized || command.title.toLowerCase() === normalized);
  }

  search(query: string): PaletteCommand[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return this.list();
    return this.commands.filter(command => [command.id, command.title, command.description, command.slash].some(value => value.toLowerCase().includes(normalized)));
  }

  selected(): PaletteCommand | undefined {
    return this.commands[this.selectedIndex];
  }

  move(delta: -1 | 1): PaletteCommand | undefined {
    if (this.commands.length === 0) return undefined;
    this.selectedIndex = (this.selectedIndex + delta + this.commands.length) % this.commands.length;
    return this.selected();
  }

  select(index: number): PaletteCommand | undefined {
    if (this.commands.length === 0) return undefined;
    this.selectedIndex = Math.max(0, Math.min(this.commands.length - 1, index));
    return this.selected();
  }

  cursor(): number {
    return this.selectedIndex;
  }
}

export function createDefaultPalette(): CommandPalette {
  return new CommandPalette([
    { id: "help", title: "Help", description: "Show command and keybinding help", slash: "/help" },
    { id: "status", title: "Status", description: "Show runtime, provider, and route status", slash: "/status" },
    { id: "sessions", title: "Sessions", description: "List saved sessions", slash: "/sessions" },
    { id: "new", title: "New Session", description: "Start a fresh local session view", slash: "/new" },
    { id: "model", title: "Model", description: "Open active model picker or select /model <id>", slash: "/model" },
    { id: "models", title: "Models", description: "List active provider models", slash: "/models" },
    { id: "themes", title: "Themes", description: "Show active theme and theme config location", slash: "/themes" },
    { id: "plugins", title: "Plugins", description: "Show registered TUI plugin slots", slash: "/plugins" },
    { id: "whichkey", title: "Which Key", description: "Show leader-key sequence hints", slash: "/whichkey" },
    { id: "diff", title: "Diff", description: "Review a file diff", slash: "/diff" },
    { id: "approve", title: "Approval", description: "Review a tool approval request", slash: "/approve" },
    { id: "pick", title: "Picker", description: "Show a generic selectable list", slash: "/pick" },
    { id: "paste", title: "Editor Paste", description: "Preview pasted or editor content", slash: "/paste" },
    { id: "provider", title: "Provider", description: "Inspect providers; configure custom with subcommands", slash: "/provider" },
    { id: "providers", title: "Providers", description: "Open provider picker", slash: "/providers" },
    { id: "commands", title: "Command Palette", description: "List palette commands", slash: "/commands" },
    { id: "toast", title: "Toasts", description: "Show toast stack", slash: "/toast" },
    { id: "exit", title: "Exit", description: "Quit the TUI", slash: "/exit" }
  ]);
}

export function renderPalette(commands: PaletteCommand[]): string {
  const rows = commands.map(command => `${command.slash.padEnd(14)} ${command.title.padEnd(18)} ${command.description}`);
  return ["Command Palette", ...rows].join("\n");
}

export function renderFilteredPalette(palette: CommandPalette, query: string): string {
  const commands = palette.search(query);
  const rows = commands.map((command, index) => `${index === 0 ? ">" : " "} ${command.slash.padEnd(12)} ${command.title.padEnd(18)} ${command.description}`);
  return [`Command Palette${query ? `: ${query}` : ""}`, ...rows].join("\n");
}
