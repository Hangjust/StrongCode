export type ToastLevel = "info" | "success" | "warning" | "error";

export interface ToastMessage {
  id: string;
  level: ToastLevel;
  message: string;
  createdAt: number;
}

export class ToastManager {
  private messages: ToastMessage[] = [];

  push(level: ToastLevel, message: string): ToastMessage {
    const toast = { id: `toast-${Date.now()}-${this.messages.length}`, level, message, createdAt: Date.now() };
    this.messages = [...this.messages.slice(-4), toast];
    return toast;
  }

  list(): ToastMessage[] {
    return [...this.messages];
  }

  render(): string {
    return this.messages.map(toast => `▸ [${toast.level}] ${toast.message}`).join("\n");
  }
}
