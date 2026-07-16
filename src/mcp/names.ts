import { createHash } from "node:crypto";

function safeMcpName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "tool";
  if (normalized.length <= 40) return normalized;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `${normalized.slice(0, 31)}_${digest}`;
}

export function mcpServerNamespace(serverId: string): string {
  return safeMcpName(serverId);
}

export function namespacedMcpToolPattern(serverId: string): string {
  return `mcp__${mcpServerNamespace(serverId)}__*`;
}

export function namespacedMcpToolName(serverId: string, toolName: string): string {
  const name = `mcp__${mcpServerNamespace(serverId)}__${safeMcpName(toolName)}`;
  if (name.length <= 64) return name;
  const digest = createHash("sha256").update(`${serverId}\0${toolName}`).digest("hex").slice(0, 8);
  return `${name.slice(0, 55)}_${digest}`;
}
