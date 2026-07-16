import { describe, expect, it } from "vitest";
import {
  decideRuntimeToolAccess,
  effectiveConfiguredTools,
  filterToolsForRuntimeRole
} from "../src/tools/capability-policy";
import { listFilesTool } from "../src/tools/builtin/list-files";
import { readFileTool } from "../src/tools/builtin/read-file";
import { findFilesTool } from "../src/tools/builtin/find-files";
import { ripgrepTool } from "../src/tools/builtin/ripgrep";
import { writeFileTool } from "../src/tools/builtin/write-file";
import { editFileTool } from "../src/tools/builtin/edit-file";
import { deletePathTool } from "../src/tools/builtin/delete-path";
import { shellTool } from "../src/tools/builtin/shell";
import type { Tool } from "../src/tools/tool";

const REQUESTED_TOOLS = [
  "read_file",
  "ripgrep",
  "web_search",
  "write_file",
  "edit_file",
  "delete_path",
  "shell",
  "worker",
  "task_spawn",
  "mcp_call",
  "mcp__unknown__read"
] as const;

describe("preflight capability policy", () => {
  it("classifies every built-in tool with an explicit effect", () => {
    expect([
      listFilesTool,
      readFileTool,
      findFilesTool,
      ripgrepTool,
      writeFileTool,
      editFileTool,
      deletePathTool,
      shellTool
    ].map(tool => [tool.name, tool.effect])).toEqual([
      ["list_files", "read"],
      ["read_file", "read"],
      ["find_files", "search"],
      ["ripgrep", "search"],
      ["write_file", "mutation"],
      ["edit_file", "mutation"],
      ["delete_path", "mutation"],
      ["shell", "shell"]
    ]);
  });

  it("allows only host-classified reads, searches, and read-only web operations", () => {
    for (const role of ["summary", "analysis", "explorer"] as const) {
      expect(REQUESTED_TOOLS.filter(name => decideRuntimeToolAccess(role, name).kind === "allow")).toEqual([
        "read_file",
        "ripgrep",
        "web_search"
      ]);
    }
  });

  it("intersects configured tools without allowing JSON to broaden the ceiling", () => {
    expect(effectiveConfiguredTools("summary", REQUESTED_TOOLS)).toEqual(["read_file", "ripgrep", "web_search"]);
    expect(effectiveConfiguredTools("primary", REQUESTED_TOOLS)).toEqual(REQUESTED_TOOLS);
    expect(effectiveConfiguredTools("explorer", ["write_file", "shell", "mcp__unknown__*"])).toEqual([]);
  });

  it("denies malformed, confused, recursive, and unclassified MCP names", () => {
    for (const name of [
      " read_file",
      "READ_FILE",
      "read_file\u0000write_file",
      "read-file",
      "web_search.execute",
      "spawn",
      "agent.spawn",
      "scheduler",
      "mcp__context7__unknown",
      "mcp__github__create_issue"
    ]) {
      expect(decideRuntimeToolAccess("analysis", name)).toMatchObject({ kind: "deny" });
    }
  });

  it("uses runtime role rather than provider or model identity", () => {
    expect(decideRuntimeToolAccess("primary", "write_file")).toMatchObject({ kind: "allow" });
    expect(decideRuntimeToolAccess("summary", "write_file")).toMatchObject({ kind: "deny" });
  });

  it("filters forbidden tools before model advertisement", () => {
    const disguisedMcp: Tool = {
      ...readFileTool,
      name: "mcp__unknown__read",
      effect: "read-only-web"
    };
    const disguisedWorker: Tool = {
      ...readFileTool,
      name: "scheduler",
      effect: "read"
    };
    const available = [readFileTool, ripgrepTool, writeFileTool, shellTool, disguisedMcp, disguisedWorker];
    expect(filterToolsForRuntimeRole("summary", available).map(tool => tool.name)).toEqual(["read_file", "ripgrep"]);
    expect(filterToolsForRuntimeRole("primary", available).map(tool => tool.name)).toEqual(available.map(tool => tool.name));
  });

});
