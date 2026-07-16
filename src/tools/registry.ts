import { Tool } from "./tool";
import { listFilesTool } from "./builtin/list-files";
import { readFileTool } from "./builtin/read-file";
import { writeFileTool } from "./builtin/write-file";
import { editFileTool } from "./builtin/edit-file";
import { deletePathTool } from "./builtin/delete-path";
import { findFilesTool } from "./builtin/find-files";
import { ripgrepTool } from "./builtin/ripgrep";
import { shellTool } from "./builtin/shell";

function globPattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export function toolNameMatches(pattern: string, toolName: string): boolean {
  return pattern === toolName || (pattern.includes("*") && globPattern(pattern).test(toolName));
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly closers: Array<() => Promise<void>> = [];

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  resolve(patterns: readonly string[]): Tool[] {
    const selected = this.list().filter(tool => patterns.some(pattern => toolNameMatches(pattern, tool.name)));
    return [...new Map(selected.map(tool => [tool.name, tool])).values()];
  }

  addCloser(closer: () => Promise<void>): void {
    this.closers.push(closer);
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.closers.map(closer => closer()));
  }
}

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(listFilesTool);
  registry.register(readFileTool);
  registry.register(findFilesTool);
  registry.register(ripgrepTool);
  registry.register(writeFileTool);
  registry.register(editFileTool);
  registry.register(deletePathTool);
  registry.register(shellTool);
  return registry;
}
