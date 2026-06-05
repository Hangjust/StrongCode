import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertToolAllowed, getToolPermission } from "../src/tools/permissions";
import { listFilesTool, resolveWorkspacePath } from "../src/tools/builtin/list-files";
import { readFileTool } from "../src/tools/builtin/read-file";
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
});
