import { watch } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolInvocationContext } from "../src/runtime/context";
import { WriteOwnershipRegistry } from "../src/tasks/ownership";
import { runProcess } from "../src/tools/builtin/run-process";
import { shellTool } from "../src/tools/builtin/shell";
import { tempWorkspace } from "./helpers";

const roots = new Set<string>();
const survivingProcessIds = new Set<number>();

function processExists(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function stopSurvivingProcess(processId: number): Promise<void> {
  if (!processExists(processId)) return;
  process.kill(processId, "SIGKILL");
  const deadline = Date.now() + 2_000;
  while (processExists(processId) && Date.now() < deadline) await delay(10);
  if (processExists(processId)) throw new Error(`Unable to clean up fixture process ${processId}`);
}

async function waitForProcessExit(processId: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (processExists(processId) && Date.now() < deadline) await delay(10);
  if (processExists(processId)) throw new Error(`Fixture process ${processId} did not exit`);
}

async function readProcessId(filename: string): Promise<number> {
  const processId = Number(await readFile(filename, "utf8"));
  if (!Number.isInteger(processId) || processId <= 0) throw new TypeError(`Invalid process ID in ${filename}`);
  return processId;
}

async function childContext(): Promise<ToolInvocationContext> {
  const workspace = await tempWorkspace();
  roots.add(workspace.root);
  return { ...workspace.context, taskId: `task-${crypto.randomUUID()}` };
}

function waitForFile(directory: string, filename: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const watcher = watch(directory, (_event, changed) => {
      if (changed !== filename) return;
      clearTimeout(timer);
      watcher.close();
      resolve();
    });
    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error(`Timed out waiting for ${filename}`));
    }, 10_000);
  });
}

afterEach(async () => {
  await Promise.all([...survivingProcessIds].map(stopSurvivingProcess));
  survivingProcessIds.clear();
  await Promise.all([...roots].map(root => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("child process boundaries", () => {
  it("requires whole-workspace ownership and exclusive admission for shell", async () => {
    const context = await childContext();
    const registry = new WriteOwnershipRegistry();
    const partial = await registry.reserve({ context, ownerId: "partial", writePaths: ["owned.txt"] });
    if (!partial.ok) throw partial.error;
    const denied = await shellTool.execute(
      { command: "node", args: ["-e", "process.stdout.write('unexpected')"] },
      { ...context, ownership: partial.value.paths }
    );
    partial.value.release();
    const exclusive = await registry.reserve({ context, ownerId: "shell", writePaths: ["."] });
    if (!exclusive.ok) throw exclusive.error;
    try {
      const competing = await registry.reserve({ context, ownerId: "other", writePaths: ["other.txt"] });
      const allowed = await shellTool.execute(
        { command: "node", args: ["-e", "process.stdout.write('safe')"] },
        { ...context, ownership: exclusive.value.paths }
      );
      expect(denied).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
      expect(competing).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
      expect(allowed).toMatchObject({ ok: true, value: { content: "safe" } });
    } finally {
      exclusive.value.release();
    }
  });

  it("aborts a process tree idempotently without a post-return orphan", async () => {
    const context = await childContext();
    const marker = path.join(context.workspaceRoot, "orphan.txt");
    const ready = path.join(context.workspaceRoot, "ready.txt");
    const cancelled = path.join(context.workspaceRoot, "cancelled.txt");
    const controller = new AbortController();
    const grandchildSource = [
      `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready')`,
      `setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(cancelled)})) require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'orphan') }, 50)`
    ].join(";");
    const parentSource = [
      `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], { stdio: 'ignore' })`,
      "setInterval(() => {}, 1000)"
    ].join(";");
    const readySignal = waitForFile(context.workspaceRoot, "ready.txt");
    const execution = runProcess({
      command: process.execPath,
      args: ["-e", parentSource],
      cwd: context.workspaceRoot,
      timeoutMs: 10_000,
      maxOutputBytes: 1_000,
      signal: controller.signal
    });

    try {
      await readySignal;
      controller.abort();
      controller.abort();
      const result = await execution;
      await writeFile(cancelled, "cancelled", "utf8");
      await delay(300);
      expect(result).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
      await expect(readFile(marker, "utf8")).rejects.toThrow();
    } finally {
      controller.abort();
      await execution;
    }
  }, 15_000);

  it.skipIf(process.platform !== "win32")(
    "kills C before cancellation returns after A and B have exited",
    async () => {
      // Given
      const context = await childContext();
      const root = context.workspaceRoot;
      const childA = path.join(root, "a.cjs");
      const childB = path.join(root, "b.cjs");
      const childC = path.join(root, "c.cjs");
      const processIdA = path.join(root, "a.pid");
      const processIdB = path.join(root, "b.pid");
      const processIdC = path.join(root, "c.pid");
      const ready = path.join(root, "c.ready");
      const trigger = path.join(root, "trigger");
      const marker = path.join(root, "c-survived");
      await writeFile(childC, [
        "const fs = require('node:fs');",
        "const [pidFile, readyFile, triggerFile, markerFile] = process.argv.slice(2);",
        "fs.writeFileSync(pidFile, String(process.pid));",
        "fs.writeFileSync(readyFile, 'ready');",
        "setInterval(() => { if (fs.existsSync(triggerFile)) fs.writeFileSync(markerFile, 'survived'); }, 10);"
      ].join("\n"), "utf8");
      await writeFile(childB, [
        "const { spawn } = require('node:child_process'); const fs = require('node:fs');",
        "const [pidFile, childPath, ...childArgs] = process.argv.slice(2);",
        "fs.writeFileSync(pidFile, String(process.pid));",
        "const child = spawn(process.execPath, [childPath, ...childArgs], { detached: true, stdio: 'ignore' });",
        "child.unref();"
      ].join("\n"), "utf8");
      await writeFile(childA, [
        "const { spawn } = require('node:child_process'); const fs = require('node:fs');",
        "const [pidFile, childPath, ...childArgs] = process.argv.slice(2);",
        "fs.writeFileSync(pidFile, String(process.pid));",
        "const child = spawn(process.execPath, [childPath, ...childArgs], { detached: true, stdio: 'ignore' });",
        "child.unref();"
      ].join("\n"), "utf8");
      const readySignal = waitForFile(root, "c.ready");
      const controller = new AbortController();
      const execution = runProcess({
        command: process.execPath,
        args: [childA, processIdA, childB, processIdB, childC, processIdC, ready, trigger, marker],
        cwd: root,
        timeoutMs: 10_000,
        maxOutputBytes: 1_000,
        signal: controller.signal
      });

      try {
        await readySignal;
        const [a, b, c] = await Promise.all([
          readProcessId(processIdA),
          readProcessId(processIdB),
          readProcessId(processIdC)
        ]);
        survivingProcessIds.add(c);
        await Promise.all([waitForProcessExit(a), waitForProcessExit(b)]);

        // When
        controller.abort();
        const result = await execution;
        await writeFile(trigger, "trigger", "utf8");
        await delay(300);

        // Then
        expect(result).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
        expect(processExists(c)).toBe(false);
        await expect(readFile(marker, "utf8")).rejects.toThrow();
      } finally {
        controller.abort();
        await execution;
      }
    },
    15_000
  );

  it("does not spawn a process for an already-aborted signal", async () => {
    const context = await childContext();
    const marker = path.join(context.workspaceRoot, "never-started.txt");
    const controller = new AbortController();
    controller.abort();

    const result = await runProcess({
      command: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`],
      cwd: context.workspaceRoot,
      timeoutMs: 1_000,
      maxOutputBytes: 1_000,
      signal: controller.signal
    });
    await delay(100);

    expect(result).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  });
});
