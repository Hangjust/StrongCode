import { slashCommandPaletteRows } from "../slash-command-registry";

export interface PaletteCommand {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly slash: string;
}

export class CommandPalette {
  private commands: PaletteCommand[];
  private selectedIndex = 0;

  constructor(commands: readonly PaletteCommand[]) {
    this.commands = [...commands];
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
  return new CommandPalette(slashCommandPaletteRows);
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
