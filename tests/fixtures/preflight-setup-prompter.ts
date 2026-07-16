import type { SetupChoice, SetupPrompter } from "../../src/setup/types";

export class PreflightSetupPrompter implements SetupPrompter {
  readonly output: string[] = [];
  readonly selections: string[] = [];
  readonly multiselections: string[][] = [];
  readonly secrets: string[] = [];
  readonly confirmations: boolean[] = [];

  intro(message: string): void { this.output.push(message); }
  note(message: string): void { this.output.push(message); }
  outro(message: string): void { this.output.push(message); }
  close(): void {}

  async select(_message: string, _choices: SetupChoice[]): Promise<string> {
    return this.selections.shift() ?? "no";
  }

  async multiselect(_message: string, _choices: SetupChoice[]): Promise<string[]> {
    return this.multiselections.shift() ?? [];
  }

  async text(): Promise<string> { return ""; }
  async secret(): Promise<string> { return this.secrets.shift() ?? ""; }
  async confirm(): Promise<boolean> { return this.confirmations.shift() ?? false; }
}
