import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { parseTuiKeybinds, TuiKeybindMap } from "./keybind";

export const DEFAULT_TUI_CONFIG_FILES = ["strongcode.tui.json", "strongcode.tui.yaml", "tui.json", "tui.yaml"];

export interface TuiThemeConfig {
  name: string;
  background: string;
  panel: string;
  element: string;
  border: string;
  primary: string;
  secondary: string;
  success: string;
  warning: string;
  text: string;
  muted: string;
}

export interface TuiConfig {
  sourceFiles: string[];
  leader: string;
  leaderTimeout: number;
  mouse: boolean;
  diffStyle: "unified" | "split";
  attentionSound?: string;
  theme: TuiThemeConfig;
  keybinds: TuiKeybindMap;
}

const defaultTheme: TuiThemeConfig = {
  name: "ember",
  background: "#0a0a0a",
  panel: "#141414",
  element: "#1e1e1e",
  border: "#484848",
  primary: "#fab283",
  secondary: "#5c9cf5",
  success: "#7fd88f",
  warning: "#f5a742",
  text: "#eeeeee",
  muted: "#808080"
};

export function defaultTuiConfig(): TuiConfig {
  return {
    sourceFiles: [],
    leader: "",
    leaderTimeout: 2000,
    mouse: true,
    diffStyle: "unified",
    theme: { ...defaultTheme },
    keybinds: parseTuiKeybinds(undefined)
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseConfigSource(source: string, filePath: string): Record<string, unknown> {
  const parsed = filePath.endsWith(".json") ? JSON.parse(source) : YAML.parse(source);
  return isObject(parsed) ? parsed : {};
}

function mergeTheme(base: TuiThemeConfig, value: unknown): TuiThemeConfig {
  if (!isObject(value)) return base;
  return {
    ...base,
    ...Object.fromEntries(Object.entries(value).filter(([, nested]) => typeof nested === "string"))
  };
}

function resolveSoundPath(raw: unknown, configPath: string): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  return path.isAbsolute(raw) ? raw : path.resolve(path.dirname(configPath), raw);
}

function applyTuiConfig(base: TuiConfig, raw: Record<string, unknown>, configPath: string): TuiConfig {
  const leader = typeof raw.leader === "string" && raw.leader ? raw.leader : base.leader;
  const leaderTimeout = typeof raw.leader_timeout === "number" && Number.isFinite(raw.leader_timeout)
    ? raw.leader_timeout
    : typeof raw.leaderTimeout === "number" && Number.isFinite(raw.leaderTimeout)
      ? raw.leaderTimeout
      : base.leaderTimeout;
  const diffStyle = raw.diff_style === "split" || raw.diffStyle === "split" ? "split" : base.diffStyle;
  const attentionSound = resolveSoundPath(raw.attention_sound ?? raw.attentionSound, configPath) ?? base.attentionSound;

  return {
    ...base,
    sourceFiles: [...base.sourceFiles, configPath],
    leader,
    leaderTimeout,
    mouse: typeof raw.mouse === "boolean" ? raw.mouse : base.mouse,
    diffStyle,
    attentionSound,
    theme: mergeTheme(base.theme, raw.theme),
    keybinds: parseTuiKeybinds({ ...base.keybinds, ...(isObject(raw.keybinds) ? raw.keybinds : {}) })
  };
}

async function loadTuiConfigFile(config: TuiConfig, filePath: string): Promise<TuiConfig> {
  if (!existsSync(filePath)) return config;
  const source = await readFile(filePath, "utf8");
  return applyTuiConfig(config, parseConfigSource(source, filePath), filePath);
}

export async function loadTuiConfig(cwd = process.cwd()): Promise<TuiConfig> {
  let config = defaultTuiConfig();
  const envPath = process.env.STRONGCODE_TUI_CONFIG;
  if (envPath) config = await loadTuiConfigFile(config, path.resolve(envPath));

  for (const fileName of DEFAULT_TUI_CONFIG_FILES) {
    config = await loadTuiConfigFile(config, path.resolve(cwd, fileName));
  }

  return config;
}
