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
    { id: "connect", title: "Connect", description: "Connect a provider with /connect <provider> <api-key>", slash: "/connect" },
    { id: "model", title: "Model", description: "Show and switch the active model", slash: "/model" },
    { id: "models", title: "Models", description: "Alias for /model", slash: "/models" },
    { id: "exit", title: "Exit", description: "Close StrongCode", slash: "/exit" }
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
