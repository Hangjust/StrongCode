export type TuiPluginSlot = "app" | "app_bottom" | "sidebar" | "status";

export interface TuiPluginContribution {
  id: string;
  slot: TuiPluginSlot;
  content: string[];
}

export class TuiPluginRuntime {
  private contributions: TuiPluginContribution[] = [];

  register(contribution: TuiPluginContribution): void {
    this.contributions = [...this.contributions.filter(existing => existing.id !== contribution.id), contribution];
  }

  unregister(id: string): void {
    this.contributions = this.contributions.filter(contribution => contribution.id !== id);
  }

  slot(slot: TuiPluginSlot): TuiPluginContribution[] {
    return this.contributions.filter(contribution => contribution.slot === slot);
  }

  render(slot: TuiPluginSlot): string {
    const rendered = this.slot(slot).flatMap(contribution => contribution.content);
    return rendered.join("\n");
  }

  list(): TuiPluginContribution[] {
    return [...this.contributions];
  }
}

export function createBuiltinPluginRuntime(): TuiPluginRuntime {
  const runtime = new TuiPluginRuntime();
  runtime.register({ id: "strongcode-status", slot: "status", content: ["Plugin slots ready: app, app_bottom, sidebar, status"] });
  return runtime;
}
