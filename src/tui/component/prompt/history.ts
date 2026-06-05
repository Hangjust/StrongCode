import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export class PromptHistory {
  private entries: string[] = [];
  private cursor = 0;

  add(value: string): void {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (this.entries[this.entries.length - 1] !== trimmed) this.entries.push(trimmed);
    this.cursor = this.entries.length;
  }

  previous(): string | undefined {
    if (this.entries.length === 0) return undefined;
    this.cursor = Math.max(0, this.cursor - 1);
    return this.entries[this.cursor];
  }

  next(): string | undefined {
    if (this.entries.length === 0) return undefined;
    this.cursor = Math.min(this.entries.length, this.cursor + 1);
    return this.cursor === this.entries.length ? "" : this.entries[this.cursor];
  }

  list(): string[] {
    return [...this.entries];
  }

  replace(entries: string[]): void {
    this.entries = entries.map(entry => entry.trim()).filter(Boolean);
    this.cursor = this.entries.length;
  }
}

export class PromptHistoryStore {
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "tui", "prompt-history.json");
  }

  async load(): Promise<PromptHistory> {
    const history = new PromptHistory();
    if (!existsSync(this.filePath)) return history;
    const source = await readFile(this.filePath, "utf8");
    const parsed = JSON.parse(source) as unknown;
    if (Array.isArray(parsed) && parsed.every(entry => typeof entry === "string")) history.replace(parsed);
    return history;
  }

  async save(history: PromptHistory): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(history.list().slice(-100), null, 2)}\n`, "utf8");
  }
}
