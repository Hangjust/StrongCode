import { createInterface, emitKeypressEvents } from "node:readline";
import type { Key } from "node:readline";
import type { Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import pc from "picocolors";
import { STRONGCODE_WORDMARK_MIN_VIEWPORT, strongCodeWordmarkRows } from "../tui/ui/wordmark";
import { SetupCancelledError, SetupChoice, SetupPrompter, SetupStatus } from "./types";

type TerminalInput = Readable & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => void;
};

type TerminalOutput = Writable & {
  columns?: number;
};

const ANSI_ESCAPE_SEQUENCE = /\u001B\[[0-?]*[ -/]*[@-~]/gu;
const TERMINAL_CONTROL = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu;

function terminalText(value: string): string {
  return value
    .replace(ANSI_ESCAPE_SEQUENCE, "")
    .replace(TERMINAL_CONTROL, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function label(choice: SetupChoice, index: number): string {
  return `  ${index + 1}. ${terminalText(choice.label)}${choice.hint ? ` — ${terminalText(choice.hint)}` : ""}`;
}

const MENU_SIZE = 7;

function searchableChoice(choice: SetupChoice, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [choice.label, choice.hint, choice.value]
    .filter((value): value is string => Boolean(value))
    .some(value => value.toLocaleLowerCase().includes(needle));
}

function conciseSelection(choices: SetupChoice[], values: string[]): string {
  const labels = values.flatMap(value => {
    const choice = choices.find(item => item.value === value);
    return choice ? [terminalText(choice.label)] : [];
  });
  if (labels.length === 0) return "None";
  if (labels.length <= 3) return labels.join(" · ");
  return `${labels.slice(0, 2).join(" · ")} +${labels.length - 2}`;
}

function truncate(value: string, maxLength: number): string {
  maxLength = Math.max(1, maxLength);
  const characters = Array.from(value);
  if (characters.length <= maxLength) return value;
  if (maxLength === 1) return "…";
  return `${characters.slice(0, maxLength - 1).join("")}…`;
}

function parseIndexes(value: string, choices: SetupChoice[], multiple: boolean): string[] | undefined {
  const normalized = value.trim().toLowerCase();
  if (multiple && normalized === "all") return choices.map(choice => choice.value);
  const tokens = normalized.split(/[\s,]+/).filter(Boolean);
  if (!multiple && tokens.length !== 1) return undefined;
  const selected: string[] = [];
  for (const token of tokens) {
    const index = Number.parseInt(token, 10) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= choices.length) return undefined;
    const valueAtIndex = choices[index]?.value;
    if (valueAtIndex && !selected.includes(valueAtIndex)) selected.push(valueAtIndex);
  }
  return selected;
}

/** Compact terminal prompts with searchable menus and masked secret input. */
export class TerminalSetupPrompter implements SetupPrompter {
  private readonly input: TerminalInput;
  private readonly output: TerminalOutput;
  private readonly lineReader?: Interface;
  private readonly iterator?: AsyncIterator<string>;
  private closed = false;

  constructor(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout) {
    this.input = input as TerminalInput;
    this.output = output as TerminalOutput;
    if (!this.isInteractive()) {
      this.lineReader = createInterface({ input: input as Readable, crlfDelay: Infinity, terminal: false });
      this.iterator = this.lineReader[Symbol.asyncIterator]();
    }
  }

  intro(message: string): void {
    const rows = this.output.columns && this.output.columns < STRONGCODE_WORDMARK_MIN_VIEWPORT
      ? ["STRONGCODE"]
      : strongCodeWordmarkRows();
    this.write("\n");
    for (const row of rows) this.write(`  ${this.isInteractive() ? pc.bold(pc.cyan(row)) : row}\n`);
    const safeMessage = terminalText(message);
    this.write(`${this.isInteractive() ? pc.cyan("┌") : "┌"}  ${this.isInteractive() ? pc.bold(safeMessage) : safeMessage}\n`);
  }

  note(message: string): void {
    this.write(`${this.isInteractive() ? pc.dim("│") : "│"}  ${terminalText(message)}\n`);
  }

  outro(message: string): void {
    const mark = this.isInteractive() ? pc.green("✓") : "✓";
    const corner = this.isInteractive() ? pc.green("└") : "└";
    this.write(`${corner}  ${mark} ${terminalText(message)}\n\n`);
  }

  status(message: string): SetupStatus {
    message = terminalText(message);
    if (!this.isInteractive()) {
      this.write(`│  ${message}\n`);
      return {
        stop: finalMessage => {
          if (finalMessage && terminalText(finalMessage) !== message) this.write(`│  ${terminalText(finalMessage)}\n`);
        }
      };
    }

    const frames = ["◒", "◐", "◓", "◑"];
    let frame = 0;
    let stopped = false;
    const render = () => this.write(`\r\x1b[2K${pc.dim("│")}  ${pc.cyan(frames[frame++ % frames.length]!)} ${message}`);
    render();
    const timer = setInterval(render, 80);
    timer.unref?.();
    return {
      stop: (finalMessage = message, state = "success") => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        const symbol = state === "error" ? pc.red("×") : pc.green("✓");
        this.write(`\r\x1b[2K${pc.dim("│")}  ${symbol} ${terminalText(finalMessage)}\n`);
      }
    };
  }

  async select(message: string, choices: SetupChoice[], initialValue?: string): Promise<string> {
    if (choices.length === 0) throw new Error("A select prompt requires at least one choice");
    if (this.isInteractive()) {
      const selected = await this.readInteractiveMenu(message, choices, false, initialValue ? [initialValue] : []);
      return selected[0]!;
    }
    this.write(`${terminalText(message)}\n${choices.map(label).join("\n")}\n`);
    const defaultIndex = Math.max(0, choices.findIndex(choice => choice.value === initialValue));
    while (true) {
      const answer = await this.readLine(`Choose [${defaultIndex + 1}]: `, false);
      const selected = parseIndexes(answer || String(defaultIndex + 1), choices, false);
      if (selected?.[0]) return selected[0];
      this.note(`Enter a number from 1 to ${choices.length}.`);
    }
  }

  async multiselect(message: string, choices: SetupChoice[], initialValues: string[] = []): Promise<string[]> {
    if (choices.length === 0) return [];
    if (this.isInteractive()) return this.readInteractiveMenu(message, choices, true, initialValues);
    this.write(`${terminalText(message)}\n${choices.map(label).join("\n")}\n`);
    const initialIndexes = choices
      .map((choice, index) => initialValues.includes(choice.value) ? String(index + 1) : "")
      .filter(Boolean)
      .join(",");
    while (true) {
      const suffix = initialIndexes ? ` [${initialIndexes}]` : "";
      const answer = await this.readLine(`Choose comma-separated numbers or 'all'${suffix}: `, false);
      if (!answer.trim() && !initialIndexes) return [];
      const selected = parseIndexes(answer || initialIndexes, choices, true);
      if (selected) return selected;
      this.note(`Enter numbers from 1 to ${choices.length}, separated by commas, or 'all'.`);
    }
  }

  async text(message: string, options: { initialValue?: string; placeholder?: string; validate?: (value: string) => string | undefined } = {}): Promise<string> {
    while (true) {
      const hint = options.initialValue ?? options.placeholder;
      const prefix = this.isInteractive() ? `${pc.cyan("◆")}  ` : "";
      const safeHint = hint ? terminalText(hint) : "";
      const renderedHint = safeHint ? ` ${this.isInteractive() ? pc.dim(`[${safeHint}]`) : `[${safeHint}]`}` : "";
      const answer = await this.readLine(`${prefix}${terminalText(message)}${renderedHint}: `, false);
      const value = answer.trim() || options.initialValue || "";
      const validation = options.validate?.(value);
      if (!validation) return value;
      this.note(validation);
    }
  }

  async secret(message: string, options: { optional?: boolean } = {}): Promise<string> {
    while (true) {
      const prefix = this.isInteractive() ? `${pc.cyan("◆")}  ` : "";
      const optional = options.optional ? ` ${this.isInteractive() ? pc.dim("optional") : "(optional)"}` : "";
      const value = (await this.readLine(`${prefix}${terminalText(message)}${optional}: `, true)).trim();
      if (value || options.optional) return value;
      this.note("A value is required.");
    }
  }

  async confirm(message: string, initialValue = true): Promise<boolean> {
    if (this.isInteractive()) {
      const value = await this.readInteractiveMenu(message, [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" }
      ], false, [initialValue ? "yes" : "no"]);
      return value[0] === "yes";
    }
    while (true) {
      const answer = (await this.readLine(`${terminalText(message)} ${initialValue ? "[Y/n]" : "[y/N]"}: `, false)).trim().toLowerCase();
      if (!answer) return initialValue;
      if (["y", "yes"].includes(answer)) return true;
      if (["n", "no"].includes(answer)) return false;
      this.note("Enter yes or no.");
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.input.isTTY && this.input.setRawMode && this.input.isRaw) this.input.setRawMode(false);
    this.lineReader?.close();
    this.input.pause();
  }

  private isInteractive(): boolean {
    return this.input.isTTY === true && typeof this.input.setRawMode === "function";
  }

  private write(value: string): void {
    this.output.write(value);
  }

  private async readLine(prompt: string, masked: boolean): Promise<string> {
    if (this.closed) throw new SetupCancelledError();
    this.write(prompt);
    if (!this.isInteractive()) {
      const next = await this.iterator?.next();
      if (!next || next.done) throw new SetupCancelledError();
      this.write("\n");
      return String(next.value ?? "");
    }

    return this.readInteractiveLine(masked);
  }

  private async readInteractiveLine(masked: boolean): Promise<string> {
    emitKeypressEvents(this.input);
    const previousRaw = this.input.isRaw === true;
    this.input.setRawMode?.(true);
    this.input.resume();
    return new Promise<string>((resolve, reject) => {
      const chars: string[] = [];
      const cleanup = () => {
        this.input.off("keypress", onKeypress);
        if (!previousRaw) this.input.setRawMode?.(false);
      };
      const onKeypress = (text: string, key: Key) => {
        if (key.ctrl && key.name === "c") {
          cleanup();
          this.write("\n");
          reject(new SetupCancelledError());
          return;
        }
        if (key.name === "return" || key.name === "enter") {
          cleanup();
          this.write("\n");
          resolve(chars.join(""));
          return;
        }
        if (key.name === "backspace") {
          if (chars.pop() !== undefined) this.write("\b \b");
          return;
        }
        if (key.name === "escape") {
          cleanup();
          this.write("\n");
          reject(new SetupCancelledError());
          return;
        }
        if (!key.ctrl && !key.meta && text && !/[\r\n]/.test(text)) {
          chars.push(text);
          this.write(masked ? "•" : text);
        }
      };
      this.input.on("keypress", onKeypress);
    });
  }

  private async readInteractiveMenu(message: string, choices: SetupChoice[], multiple: boolean, initialValues: string[]): Promise<string[]> {
    if (this.closed) throw new SetupCancelledError();
    emitKeypressEvents(this.input);
    const previousRaw = this.input.isRaw === true;
    this.input.setRawMode?.(true);
    this.input.resume();

    return new Promise<string[]>((resolve, reject) => {
      const safeMessage = terminalText(message);
      const selected = new Set(initialValues.filter(value => choices.some(choice => choice.value === value)));
      let query = "";
      let cursor = Math.max(0, choices.findIndex(choice => choice.value === initialValues[0]));
      let renderedLines = 0;

      const filtered = () => choices.filter(choice => searchableChoice(choice, query));
      const clear = () => {
        for (let index = 0; index < renderedLines; index += 1) this.write("\x1b[1A\r\x1b[2K");
        renderedLines = 0;
      };
      const line = (value: string) => {
        this.write(`${value}\n`);
        renderedLines += 1;
      };
      const render = () => {
        clear();
        const available = filtered();
        if (cursor >= available.length) cursor = Math.max(0, available.length - 1);
        const start = Math.max(0, Math.min(cursor - Math.floor(MENU_SIZE / 2), Math.max(0, available.length - MENU_SIZE)));
        const visible = available.slice(start, start + MENU_SIZE);
        const availableWidth = Math.max(20, (this.output.columns ?? 100) - 10);
        line(`${pc.cyan("◆")}  ${pc.bold(safeMessage)}`);
        if (choices.length > MENU_SIZE || query) line(`${pc.dim("│")}  ${pc.dim("Search")} ${truncate(query, availableWidth) || pc.dim("type to filter")}`);
        if (visible.length === 0) {
          line(`${pc.dim("│")}  ${pc.dim("No matches")}`);
        } else {
          for (const [offset, choice] of visible.entries()) {
            const absoluteIndex = start + offset;
            const active = absoluteIndex === cursor;
            const marker = multiple
              ? selected.has(choice.value) ? pc.green("◼") : pc.dim("◻")
              : active ? pc.cyan("●") : pc.dim("○");
            const prefix = active ? pc.cyan("›") : " ";
            const safeLabel = terminalText(choice.label);
            const safeHint = terminalText(choice.hint ?? "");
            const plainHint = safeHint && Array.from(`${safeLabel} ${safeHint}`).length <= availableWidth ? safeHint : "";
            const plainLabel = truncate(safeLabel, availableWidth - (plainHint ? Array.from(plainHint).length + 1 : 0));
            const text = active ? pc.bold(plainLabel) : plainLabel;
            const hint = plainHint ? ` ${pc.dim(plainHint)}` : "";
            line(`${pc.dim("│")} ${prefix} ${marker} ${text}${hint}`);
          }
        }
        const instruction = multiple ? "↑↓ move · space select · enter done" : "↑↓ move · enter choose";
        line(`${pc.dim("│")}  ${pc.dim(instruction)}`);
      };
      const cleanup = () => {
        this.input.off("keypress", onKeypress);
        if (!previousRaw) this.input.setRawMode?.(false);
      };
      const finish = (values: string[]) => {
        cleanup();
        clear();
        const width = Math.max(20, (this.output.columns ?? 100) - 4);
        this.write(`${pc.green("◇")}  ${safeMessage}\n${pc.dim("│")}  ${pc.dim(truncate(conciseSelection(choices, values), width))}\n`);
        resolve(values);
      };
      const cancel = () => {
        cleanup();
        clear();
        this.write(`${pc.red("■")}  ${safeMessage}\n`);
        reject(new SetupCancelledError());
      };
      const onKeypress = (text: string, key: Key) => {
        if ((key.ctrl && key.name === "c") || key.name === "escape") {
          cancel();
          return;
        }
        const available = filtered();
        if (key.name === "up") cursor = Math.max(0, cursor - 1);
        else if (key.name === "down") cursor = Math.min(Math.max(0, available.length - 1), cursor + 1);
        else if (key.name === "home") cursor = 0;
        else if (key.name === "end") cursor = Math.max(0, available.length - 1);
        else if (key.name === "backspace") {
          query = Array.from(query).slice(0, -1).join("");
          cursor = 0;
        } else if (key.name === "space" && multiple && available[cursor]) {
          const value = available[cursor]!.value;
          if (selected.has(value)) selected.delete(value);
          else selected.add(value);
        } else if (key.name === "return" || key.name === "enter") {
          const active = available[cursor];
          if (multiple) finish(choices.filter(choice => selected.has(choice.value)).map(choice => choice.value));
          else if (active) finish([active.value]);
          return;
        } else if (!key.ctrl && !key.meta && text && !/[\r\n]/.test(text) && !(multiple && text === " ")) {
          query += text;
          cursor = 0;
        }
        render();
      };

      this.input.on("keypress", onKeypress);
      render();
    });
  }
}
