import { TuiKeybindCommand, TuiKeybindMap } from "./config/keybind";

export interface KeySequenceState {
  pending: string[];
  startedAt: number;
}

export type KeySequenceResult =
  | { type: "pending"; keys: string[]; hints: string[] }
  | { type: "matched"; command: TuiKeybindCommand; keys: string[] }
  | { type: "none" };

export function createKeySequenceState(): KeySequenceState {
  return { pending: [], startedAt: 0 };
}

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/^enter$/, "return");
}

function sequence(binding: string): string[] {
  return binding.split(/\s+/).map(normalizeKey).filter(Boolean);
}

function bindingEntries(keybinds: TuiKeybindMap): Array<{ command: TuiKeybindCommand; keys: string[] }> {
  return Object.entries(keybinds).flatMap(([command, bindings]) => bindings.map(binding => ({ command: command as TuiKeybindCommand, keys: sequence(binding) })));
}

export function dispatchKeySequence(state: KeySequenceState, keybinds: TuiKeybindMap, key: string, timeoutMs: number, now = Date.now()): KeySequenceResult {
  if (state.pending.length > 0 && now - state.startedAt > timeoutMs) {
    state.pending = [];
  }

  if (state.pending.length === 0) state.startedAt = now;
  state.pending = [...state.pending, normalizeKey(key)];

  const entries = bindingEntries(keybinds);
  const exact = entries.find(entry => entry.keys.length === state.pending.length && entry.keys.every((value, index) => value === state.pending[index]));
  if (exact) {
    const keys = state.pending;
    state.pending = [];
    return { type: "matched", command: exact.command, keys };
  }

  const possible = entries.filter(entry => state.pending.every((value, index) => value === entry.keys[index]));
  if (possible.length > 0) {
    return { type: "pending", keys: [...state.pending], hints: possible.map(entry => `${entry.keys.slice(state.pending.length).join(" ")} -> ${entry.command}`) };
  }

  state.pending = [];
  return { type: "none" };
}

export function renderWhichKey(result: Extract<KeySequenceResult, { type: "pending" }>): string {
  return [`Which key: ${result.keys.join(" ")}`, ...result.hints.map(hint => `  ${hint}`)].join("\n");
}
