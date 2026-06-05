import { DialogState } from "./dialog";
import { ToastMessage } from "./toast";
import { PaletteCommand } from "./palette";

export function renderDialogOverlay(dialog: DialogState): string {
  const width = Math.max(40, dialog.title.length + 4, ...dialog.body.map(line => line.length + 4));
  const border = "─".repeat(width - 2);
  const body = dialog.body.map(line => `│ ${line.padEnd(width - 4)} │`);
  const actions = dialog.actions.length > 0 ? [`│ ${dialog.actions.map(action => `[${action.label}]`).join(" ").padEnd(width - 4)} │`] : [];
  return [`╭${border}╮`, `│ ${dialog.title.padEnd(width - 4)} │`, `├${border}┤`, ...body, ...actions, `╰${border}╯`].join("\n");
}

export function renderToastOverlay(toasts: ToastMessage[]): string {
  return toasts.map(toast => `▸ [${toast.level}] ${toast.message}`).join("\n");
}

export function renderPaletteOverlay(commands: PaletteCommand[], selectedIndex: number): string {
  const rows = commands.map((command, index) => `${index === selectedIndex ? ">" : " "} ${command.slash.padEnd(12)} ${command.title.padEnd(18)} ${command.description}`);
  return ["Command Palette", "────────────────────────", ...rows].join("\n");
}

const SLASH_COMMAND_LIMIT = 10;

export function renderSlashCommandOverlay(commands: PaletteCommand[], selectedIndex: number, _query: string, scrollIndex?: number): string {
  const width = 76;
  const maxStart = Math.max(0, commands.length - SLASH_COMMAND_LIMIT);
  const startIndex = Math.max(0, Math.min(scrollIndex ?? Math.max(0, selectedIndex - SLASH_COMMAND_LIMIT + 1), maxStart));
  const visibleCommands = commands.slice(startIndex, startIndex + SLASH_COMMAND_LIMIT);
  const contentWidth = width - 4;
  const clip = (value: string, length: number) => value.length > length ? `${value.slice(0, length - 1)}…` : value;
  const rows = visibleCommands.length > 0
    ? visibleCommands.map((command, index) => {
      const active = index + startIndex === selectedIndex;
      const trigger = clip(command.slash, 18);
      const description = clip(command.description, contentWidth - trigger.length - 5);
      const row = `${active ? "›" : " "} ${trigger.padEnd(18)} ${description}`;
      return `│ ${row.padEnd(contentWidth)} │`;
    })
    : [`│ ${"No matching commands".padEnd(contentWidth)} │`];
  const border = "─".repeat(width - 2);
  return [`╭${border}╮`, ...rows, `╰${border}╯`].join("\n");
}
