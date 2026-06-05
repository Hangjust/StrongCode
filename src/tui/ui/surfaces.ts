import { sanitizeDisplayValue } from "../render";

const WIDTH = 80;

function clip(line: string): string {
  const safe = sanitizeDisplayValue(line, "");
  return safe.length <= WIDTH ? safe : safe.slice(0, WIDTH - 1) + ".";
}

function lines(title: string, body: string[]): string {
  return [title, "─".repeat(Math.min(WIDTH, Math.max(24, title.length + 8))), ...body].map(clip).join("\n");
}

export interface DiffSurfaceInput {
  filePath: string;
  before: string;
  after: string;
}

export function renderDiffSurface(input: DiffSurfaceInput): string {
  const before = input.before.split("\n");
  const after = input.after.split("\n");
  const max = Math.max(before.length, after.length);
  const rows: string[] = [`File ${input.filePath}`, "Review lane: before / after", ""];
  for (let index = 0; index < max; index += 1) {
    if ((before[index] ?? "") === (after[index] ?? "")) rows.push(`  ${before[index] ?? ""}`);
    else {
      if (before[index] !== undefined) rows.push(`- ${before[index]}`);
      if (after[index] !== undefined) rows.push(`+ ${after[index]}`);
    }
  }
  return lines("Diff Review", rows);
}

export interface ApprovalSurfaceInput {
  toolName: string;
  description: string;
  risk: "low" | "medium" | "high";
}

export function renderApprovalSurface(input: ApprovalSurfaceInput): string {
  return lines("Tool Approval", [
    `Tool ${input.toolName}`,
    `Risk ${input.risk}`,
    "Status pending operator decision",
    input.description,
    "Actions: allow once | deny | inspect"
  ]);
}

export interface PickerItem {
  id: string;
  label: string;
  description?: string;
}

export function renderPickerSurface(title: string, items: PickerItem[], selectedIndex: number): string {
  return lines(title, items.map((item, index) => `${index === selectedIndex ? ">" : " "} ${item.label} ${item.description ?? item.id}`));
}

export interface ProviderDialogItem {
  id: string;
  title: string;
  description: string;
  category: "Popular" | "Providers";
  connected: boolean;
  credential: string;
  footer?: string;
}

export function renderProviderDialogSurface(items: ProviderDialogItem[], selectedIndex: number, query = ""): string {
  const safeQuery = sanitizeDisplayValue(query, "");
  const body: string[] = [
    "esc                                                       ",
    safeQuery ? `Search ${safeQuery}` : "Search",
    ""
  ];
  let category = "";
  for (const [index, item] of items.entries()) {
    if (item.category !== category) {
      category = item.category;
      body.push(category);
    }
    const active = index === selectedIndex;
    const cursor = active ? ">" : " ";
    const check = item.connected ? "✓" : " ";
    body.push(`${cursor} ${check} ${item.title} ${item.description}`);
    body.push(`    ${item.id} · ${item.credential}`);
    if (item.footer) body.push(`    ${item.footer}`);
  }

  if (items.length === 0) {
    body.push("No results found");
  }

  return lines("Connect a provider", body);
}

export interface EditorPasteSurfaceInput {
  content: string;
  maxPreviewChars?: number;
}

export function renderEditorPasteSurface(input: EditorPasteSurfaceInput): string {
  const max = input.maxPreviewChars ?? 240;
  const preview = input.content.length > max ? `${input.content.slice(0, max)}...` : input.content;
  return lines("Editor Paste", [
    `Characters ${input.content.length}`,
    "Mode staged input preview",
    "Preview:",
    ...preview.split("\n"),
    "Actions: submit | edit externally | cancel"
  ]);
}

export interface DashboardMetric {
  label: string;
  value: string;
  state?: "ok" | "warn" | "muted";
}

export function renderStatusDashboard(title: string, metrics: DashboardMetric[]): string {
  return lines(title, metrics.map(metric => `${metric.state === "ok" ? "●" : metric.state === "warn" ? "▲" : "○"} ${metric.label.padEnd(14)} ${metric.value}`));
}

export interface ThemePickerInput {
  activeTheme: string;
  themes: string[];
}

export function renderThemePicker(input: ThemePickerInput): string {
  return lines("Theme Picker", input.themes.map(theme => `${theme === input.activeTheme ? ">" : " "} ${theme}`));
}

export interface SidebarPanelInput {
  title: string;
  rows: Array<{ label: string; value: string }>;
}

export function renderSidebarPanel(input: SidebarPanelInput): string {
  return lines(input.title, input.rows.map(row => `› ${row.label.padEnd(12)} ${row.value}`));
}
