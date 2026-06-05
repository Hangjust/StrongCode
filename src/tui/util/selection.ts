import { sanitizeDisplayValue } from "../render";

export interface SelectionRange {
  startLine: number;
  endLine: number;
}

export function copySelectionText(lines: string[], range: SelectionRange): string {
  const start = Math.max(0, Math.min(range.startLine, range.endLine));
  const end = Math.min(lines.length - 1, Math.max(range.startLine, range.endLine));
  return lines.slice(start, end + 1).map(line => sanitizeDisplayValue(line, "")).join("\n");
}
