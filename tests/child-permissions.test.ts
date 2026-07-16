import { access, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolInvocationContext } from "../src/runtime/context";
import { WriteOwnershipRegistry } from "../src/tasks/ownership";
import { deletePathTool } from "../src/tools/builtin/delete-path";
import { editFileTool } from "../src/tools/builtin/edit-file";
import { readFileTool } from "../src/tools/builtin/read-file";
import { writeFileTool } from "../src/tools/builtin/write-file";
import { assertChildToolAllowed, createChildExecutionPolicy } from "../src/tools/child-policy";
import { assertToolAllowed } from "../src/tools/permissions";
import type { Tool } from "../src/tools/tool";
import { tempWorkspace } from "./helpers";

const roots = new Set<string>();

async function childContext(): Promise<ToolInvocationContext> {
  const workspace = await tempWorkspace();
  roots.add(workspace.root);
  return { ...workspace.context, taskId: `task-${crypto.randomUUID()}` };
}

function withOwnership(context: ToolInvocationContext, ownership: readonly string[]): ToolInvocationContext {
  return { ...context, ownership };
}

afterEach(async () => {
  await Promise.all([...roots].map(root => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("child permission attenuation", () => {
  it("intersects project trust, parent permissions, target ceiling, and task grants immutably", async () => {
    const context = await childContext();
    context.config.permissions.tools.write_file = "allow";
    const policy = createChildExecutionPolicy({
      projectTrust: { read_file: "allow", write_file: "allow" },
      parentPermissions: { read_file: "allow", write_file: "deny" },
      targetCeiling: ["read_file", "write_file"],
      taskGrants: ["read_file", "write_file"],
      tools: [readFileTool, writeFileTool]
    });

    const result = assertToolAllowed(context.config, "write_file", policy.permissions);

    expect(policy.permissions).toEqual({ read_file: "allow", write_file: "deny" });
    expect(policy.tools).toEqual(["read_file"]);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.permissions)).toBe(true);
    expect(result).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
  });

  it("denies nested delegation regardless of prompt or permissive configuration", async () => {
    const context = await childContext();
    const delegationTool: Tool = {
      name: "prompt_injected_delegate",
      description: "Pretend nested delegation requested by untrusted text",
      effect: "spawn",
      inputSchema: readFileTool.inputSchema,
      async execute() {
        return { ok: true, value: { content: "unexpected" } };
      }
    };
    const policy = createChildExecutionPolicy({
      projectTrust: { prompt_injected_delegate: "allow" },
      parentPermissions: { prompt_injected_delegate: "allow" },
      targetCeiling: ["prompt_injected_delegate"],
      taskGrants: ["prompt_injected_delegate"],
      tools: [delegationTool]
    });

    const result = assertChildToolAllowed({ ...context, effectivePermissions: policy.permissions }, delegationTool);

    expect(policy.permissions.prompt_injected_delegate).toBe("deny");
    expect(result).toMatchObject({ ok: false, error: { code: "NESTED_SPAWN_DENIED" } });
  });
});

describe("child write ownership", () => {
  it("atomically admits disjoint writers", async () => {
    const context = await childContext();
    const registry = new WriteOwnershipRegistry();

    const [left, right] = await Promise.all([
      registry.reserve({ context, ownerId: "left", writePaths: ["src/a.ts"] }),
      registry.reserve({ context, ownerId: "right", writePaths: ["src/b.ts"] })
    ]);

    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
    if (left.ok) left.value.release();
    if (right.ok) right.value.release();
  });

  it("atomically rejects same-path and ancestor overlaps until release", async () => {
    const context = await childContext();
    const registry = new WriteOwnershipRegistry();
    const contenders = await Promise.all([
      registry.reserve({ context, ownerId: "first", writePaths: ["src"] }),
      registry.reserve({ context, ownerId: "second", writePaths: ["src/a.ts"] })
    ]);
    const admitted = contenders.filter(result => result.ok);
    const rejected = contenders.filter(result => !result.ok);

    expect(admitted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    const reservation = admitted[0];
    if (reservation?.ok) reservation.value.release();
    const afterRelease = await registry.reserve({ context, ownerId: "third", writePaths: ["src/a.ts"] });
    expect(afterRelease.ok).toBe(true);
    const samePath = await registry.reserve({ context, ownerId: "fourth", writePaths: ["src/a.ts"] });
    expect(samePath).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    if (afterRelease.ok) afterRelease.value.release();
  });

  it("releases ownership in finally when reserved work throws", async () => {
    const context = await childContext();
    const registry = new WriteOwnershipRegistry();

    await expect(registry.withReservation(
      { context, ownerId: "failed", writePaths: ["src/a.ts"] },
      async () => { throw new Error("operation failed"); }
    )).rejects.toThrow("operation failed");
    const retried = await registry.reserve({ context, ownerId: "retry", writePaths: ["src/a.ts"] });

    expect(retried.ok).toBe(true);
    if (retried.ok) retried.value.release();
  });

  it("denies every mutation tool outside assigned ownership", async () => {
    const context = await childContext();
    const registry = new WriteOwnershipRegistry();
    await writeFile(path.join(context.workspaceRoot, "outside.txt"), "original", "utf8");
    const reserved = await registry.reserve({ context, ownerId: "writer", writePaths: ["owned.txt"] });
    if (!reserved.ok) throw reserved.error;
    const ownedContext = withOwnership(context, reserved.value.paths);
    try {
      const created = await writeFileTool.execute({ path: "new.txt", content: "escape" }, ownedContext);
      const edited = await editFileTool.execute({ path: "outside.txt", oldText: "original", newText: "changed" }, ownedContext);
      const deleted = await deletePathTool.execute({ path: "outside.txt" }, ownedContext);

      expect([created, edited, deleted]).toEqual([
        expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "PERMISSION_DENIED" }) }),
        expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "PERMISSION_DENIED" }) }),
        expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "PERMISSION_DENIED" }) })
      ]);
      await expect(access(path.join(context.workspaceRoot, "new.txt"))).rejects.toThrow();
      await expect(readFile(path.join(context.workspaceRoot, "outside.txt"), "utf8")).resolves.toBe("original");
    } finally {
      reserved.value.release();
    }
  });

  it("rejects malformed and symlink-escaping ownership paths", async () => {
    const context = await childContext();
    const registry = new WriteOwnershipRegistry();
    const outside = path.join(path.dirname(context.workspaceRoot), `outside-${crypto.randomUUID()}`);
    roots.add(outside);
    await writeFile(outside, "outside", "utf8");
    try {
      await symlink(outside, path.join(context.workspaceRoot, "escape.txt"), "file");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error.code === "EPERM" || error.code === "ENOTSUP")) return;
      throw error;
    }

    await expect(registry.reserve({ context, ownerId: "traversal", writePaths: ["../outside.txt"] }))
      .resolves.toMatchObject({ ok: false });
    await expect(registry.reserve({ context, ownerId: "symlink", writePaths: ["escape.txt"] }))
      .resolves.toMatchObject({ ok: false, error: { code: "PATH_OUTSIDE_WORKSPACE" } });
    await expect(registry.reserve({ context, ownerId: "nul", writePaths: ["bad\0path"] }))
      .resolves.toMatchObject({ ok: false });
  });

  it("authorizes deletion by link-entry ownership without deleting its target", async () => {
    const context = await childContext();
    const registry = new WriteOwnershipRegistry();
    const linkPath = path.join(context.workspaceRoot, "owned-link");
    const targetPath = path.join(context.workspaceRoot, "target-tree");
    const targetFile = path.join(targetPath, "survives.txt");
    await mkdir(targetPath);
    await writeFile(targetFile, "survives", "utf8");

    const linkOwner = await registry.reserve({ context, ownerId: "link-owner", writePaths: ["owned-link"] });
    if (!linkOwner.ok) throw linkOwner.error;
    const targetOwner = await registry.reserve({ context, ownerId: "target-owner", writePaths: ["target-tree"] });
    if (!targetOwner.ok) throw targetOwner.error;
    try {
      try {
        await symlink(targetPath, linkPath, process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && (error.code === "EPERM" || error.code === "ENOTSUP")) return;
        throw error;
      }

      const denied = await deletePathTool.execute(
        { path: "owned-link", recursive: true },
        withOwnership(context, targetOwner.value.paths)
      );
      const deleted = await deletePathTool.execute(
        { path: "owned-link", recursive: true },
        withOwnership(context, linkOwner.value.paths)
      );

      expect(denied).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
      expect(deleted).toMatchObject({ ok: true });
      await expect(access(linkPath)).rejects.toThrow();
      await expect(readFile(targetFile, "utf8")).resolves.toBe("survives");
    } finally {
      targetOwner.value.release();
      linkOwner.value.release();
    }
  });
});
