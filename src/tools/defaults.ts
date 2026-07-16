import type { PermissionDecision } from "../config/schema";

export const DEFAULT_AGENT_TOOLS = [
  "question",
  "list_files",
  "read_file",
  "find_files",
  "ripgrep",
  "write_file",
  "edit_file",
  "delete_path",
  "shell",
  "web_search",
  "mcp_list_tools",
  "mcp_call",
  "mcp__context7__*",
  "mcp__grep_app__*",
  "mcp__graphify__*",
  "mcp__semble__*",
  "mcp__playwright__*",
  "mcp__chrome_devtools__*",
  "mcp__github__*",
  "mcp__exa__*",
  "mcp__tinyfish__*",
  "mcp__headroom__*"
] as const;

export const AUDITED_READ_ONLY_TOOL_PATTERNS = new Set([
  "question",
  "list_files",
  "read_file",
  "find_files",
  "ripgrep",
  "web_search",
  "mcp__context7__*",
  "mcp__grep_app__*",
  "mcp__graphify__*",
  "mcp__semble__*",
  "mcp__exa__*"
]);

export const DEFAULT_TOOL_PERMISSIONS: Record<string, PermissionDecision> = Object.fromEntries(
  DEFAULT_AGENT_TOOLS.map(tool => [tool, "allow" as const])
);
