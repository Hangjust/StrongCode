import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertToolAllowed, getToolPermission } from "../src/tools/permissions";
import { listFilesTool, resolveWorkspacePath } from "../src/tools/builtin/list-files";
import { readFileTool } from "../src/tools/builtin/read-file";
import { writeFileTool } from "../src/tools/builtin/write-file";
import { editFileTool } from "../src/tools/builtin/edit-file";
import { deletePathTool } from "../src/tools/builtin/delete-path";
import { shellTool } from "../src/tools/builtin/shell";
import { findFilesTool } from "../src/tools/builtin/find-files";
import { ripgrepTool } from "../src/tools/builtin/ripgrep";
import { tempWorkspace, testConfig } from "./helpers";

describe("tools and permissions", () => {
  it("denies unknown tools and non-interactive ask permissions", async () => {
    const workspace = await tempWorkspace();
    const config = testConfig(workspace.root);
    config.permissions.tools.read_file = "ask";

    expect(getToolPermission(config, "missing_tool")).toBe("deny");
    expect(assertToolAllowed(config, "missing_tool").ok).toBe(false);
    expect(assertToolAllowed(config, "read_file").ok).toBe(false);
    expect(assertToolAllowed(config, "list_files").ok).toBe(true);
  });

  it("supports wildcard permissions for namespaced MCP tools", () => {
    const config = testConfig(process.cwd());
    config.permissions.tools["mcp__context7__*"] = "allow";
    expect(getToolPermission(config, "mcp__context7__query_docs")).toBe("allow");
    expect(getToolPermission(config, "mcp__github__create_issue")).toBe("deny");
  });

  it("keeps a matching wildcard deny above an exact allow", () => {
    const config = testConfig(process.cwd());
    config.permissions.tools["mcp__fixture__*"] = "deny";
    config.permissions.tools.mcp__fixture__delete = "allow";

    expect(getToolPermission(config, "mcp__fixture__delete")).toBe("deny");
    expect(assertToolAllowed(config, "mcp__fixture__delete").ok).toBe(false);
  });

  it("prevents path traversal outside the workspace", async () => {
    const workspace = await tempWorkspace();

    const resolved = resolveWorkspacePath(workspace.context, "../outside.txt");
    const read = await readFileTool.execute({ path: "../outside.txt" }, workspace.context);

    expect(resolved.ok).toBe(false);
    expect(read.ok).toBe(false);
  });

  it("lists and reads only files inside the workspace", async () => {
    const workspace = await tempWorkspace();
    await mkdir(path.join(workspace.root, "docs"));
    await writeFile(path.join(workspace.root, "docs", "note.txt"), "safe content", "utf8");

    const listed = await listFilesTool.execute({ path: "docs" }, workspace.context);
    const read = await readFileTool.execute({ path: "docs/note.txt" }, workspace.context);

    expect(listed.ok).toBe(true);
    expect(read.ok).toBe(true);
    if (listed.ok) {
      expect(listed.value.content).toContain("note.txt");
    }
    if (read.ok) {
      expect(read.value.content).toBe("safe content");
    }
  });

  it("rejects workspace symlinks and junctions that resolve outside the workspace", async () => {
    const workspace = await tempWorkspace();
    const outside = await mkdtemp(path.join(tmpdir(), "strongcode-outside-"));
    const outsideFile = path.join(outside, "secret.txt");
    const link = path.join(workspace.root, "linked-secret.txt");
    await writeFile(outsideFile, "must not be read", "utf8");
    try {
      await symlink(outsideFile, link, "file");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error.code === "EPERM" || error.code === "ENOTSUP")) return;
      throw error;
    }

    const read = await readFileTool.execute({ path: "linked-secret.txt" }, workspace.context);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.code).toBe("PATH_OUTSIDE_WORKSPACE");
  });

  it("rejects nested external directory links but permits links that stay inside the workspace", async () => {
    const workspace = await tempWorkspace();
    const outside = await mkdtemp(path.join(tmpdir(), "strongcode-outside-directory-"));
    const inside = path.join(workspace.root, "inside");
    const externalLink = path.join(workspace.root, "external-directory");
    const internalLink = path.join(workspace.root, "internal-directory");
    await mkdir(inside);
    await writeFile(path.join(outside, "secret.txt"), "must not be read", "utf8");
    await writeFile(path.join(inside, "note.txt"), "safe content", "utf8");

    const linkType = process.platform === "win32" ? "junction" : "dir";
    try {
      await symlink(outside, externalLink, linkType);
      await symlink(inside, internalLink, linkType);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error.code === "EPERM" || error.code === "ENOTSUP")) return;
      throw error;
    }

    const externalList = await listFilesTool.execute({ path: "external-directory" }, workspace.context);
    const externalRead = await readFileTool.execute({ path: "external-directory/secret.txt" }, workspace.context);
    expect(externalList.ok).toBe(false);
    expect(externalRead.ok).toBe(false);
    if (!externalList.ok) expect(externalList.error.code).toBe("PATH_OUTSIDE_WORKSPACE");
    if (!externalRead.ok) expect(externalRead.error.code).toBe("PATH_OUTSIDE_WORKSPACE");

    const internalList = await listFilesTool.execute({ path: "internal-directory" }, workspace.context);
    const internalRead = await readFileTool.execute({ path: "internal-directory/note.txt" }, workspace.context);
    expect(internalList.ok).toBe(true);
    expect(internalRead.ok).toBe(true);
    if (internalList.ok) expect(internalList.value.content).toContain("note.txt");
    if (internalRead.ok) expect(internalRead.value.content).toBe("safe content");
  });

  it("writes, edits, and deletes workspace files with explicit overwrite semantics", async () => {
    const workspace = await tempWorkspace();
    const created = await writeFileTool.execute({ path: "notes/new.txt", content: "one" }, workspace.context);
    const duplicate = await writeFileTool.execute({ path: "notes/new.txt", content: "two" }, workspace.context);
    const edited = await editFileTool.execute({ path: "notes/new.txt", oldText: "one", newText: "three" }, workspace.context);
    const removed = await deletePathTool.execute({ path: "notes/new.txt" }, workspace.context);

    expect(created.ok).toBe(true);
    expect(duplicate.ok).toBe(false);
    expect(edited.ok).toBe(true);
    expect(removed.ok).toBe(true);
  });

  it("runs executables without invoking a command shell", async () => {
    const workspace = await tempWorkspace();
    const result = await shellTool.execute({ command: "node", args: ["-e", "process.stdout.write('safe')"] }, workspace.context);
    expect(result).toMatchObject({ ok: true, value: { content: "safe" } });
  });

  it("resolves native shell commands only from canonical external PATH directories", async () => {
    // Given
    const workspace = await tempWorkspace();
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-shell-resolution-"));
    const workspaceBin = path.join(workspace.root, "bin");
    const externalBin = path.join(root, "external-bin");
    const originalPath = process.env.PATH;
    const originalCredential = process.env.STRONGCODE_TEST_CREDENTIAL;
    await Promise.all([mkdir(workspaceBin), mkdir(externalBin), mkdir(path.join(workspace.root, "subdir"))]);
    const names = process.platform === "win32" ? ["node.exe", "git.exe"] : ["node", "git"];
    await Promise.all(names.flatMap(name => [
      copyFile(process.execPath, path.join(workspaceBin, name)),
      copyFile(process.execPath, path.join(externalBin, name))
    ]));
    if (process.platform !== "win32") {
      await Promise.all(names.flatMap(name => [
        chmod(path.join(workspaceBin, name), 0o755),
        chmod(path.join(externalBin, name), 0o755)
      ]));
    }

    try {
      process.env.PATH = [workspaceBin, externalBin].join(path.delimiter);
      process.env.STRONGCODE_TEST_CREDENTIAL = "must-not-reach-shell";
      for (const command of ["node", "git"]) {
        // When
        const result = await shellTool.execute({
          command,
          args: ["-e", "process.stdout.write(JSON.stringify({ executable: process.execPath, path: process.env.PATH, credential: process.env.STRONGCODE_TEST_CREDENTIAL }))"],
          cwd: "subdir"
        }, workspace.context);

        // Then
        expect(result.ok).toBe(true);
        if (!result.ok) throw result.error;
        expect(JSON.parse(result.value.content)).toEqual({
          executable: await realpath(path.join(externalBin, executableName(command))),
          path: await realpath(externalBin)
        });
      }

      process.env.PATH = workspaceBin;
      const unavailable = await shellTool.execute({ command: "git", args: ["-e", "process.exit(0)"] }, workspace.context);
      expect(unavailable).toMatchObject({ ok: false, error: { code: "TOOL_ERROR" } });

      if (process.platform === "win32") {
        process.env.PATH = externalBin;
        await writeFile(path.join(externalBin, "workspace-script.cmd"), "@exit /b 0\r\n", "utf8");
        const shim = await shellTool.execute({ command: "workspace-script", args: [] }, workspace.context);
        expect(shim).toMatchObject({ ok: false, error: { code: "TOOL_ERROR" } });
      }
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalCredential === undefined) delete process.env.STRONGCODE_TEST_CREDENTIAL;
      else process.env.STRONGCODE_TEST_CREDENTIAL = originalCredential;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the bundled ripgrep binary for file and content search", async () => {
    const workspace = await tempWorkspace();
    await writeFile(path.join(workspace.root, "searchable.ts"), "export const needle = 'found';\n", "utf8");
    const files = await findFilesTool.execute({ query: "searchable", globs: ["*.ts"] }, workspace.context);
    const matches = await ripgrepTool.execute({ pattern: "needle", globs: ["*.ts"] }, workspace.context);
    expect(files).toMatchObject({ ok: true });
    expect(matches).toMatchObject({ ok: true });
    if (files.ok) expect(files.value.content).toContain("searchable.ts");
    if (matches.ok) expect(matches.value.content).toContain("searchable.ts:1");
  });
});

function executableName(command: string): string {
  return process.platform === "win32" ? `${command}.exe` : command;
}
