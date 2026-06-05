export interface DialogAction {
  id: string;
  label: string;
}

export interface DialogState {
  id: string;
  title: string;
  body: string[];
  actions: DialogAction[];
}

export class DialogManager {
  private stack: DialogState[] = [];

  open(dialog: DialogState): void {
    this.stack = [...this.stack.filter(existing => existing.id !== dialog.id), dialog];
  }

  close(id?: string): void {
    if (!id) {
      this.stack = this.stack.slice(0, -1);
      return;
    }
    this.stack = this.stack.filter(dialog => dialog.id !== id);
  }

  active(): DialogState | undefined {
    return this.stack[this.stack.length - 1];
  }

  render(): string {
    const dialog = this.active();
    if (!dialog) return "";
    const actions = dialog.actions.length > 0 ? `Actions: ${dialog.actions.map(action => action.label).join(", ")}` : "";
    return [dialog.title, ...dialog.body, actions].filter(Boolean).join("\n");
  }
}
