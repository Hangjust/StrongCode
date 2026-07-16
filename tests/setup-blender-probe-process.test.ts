import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { nodeProbeProcessAdapter } from "../src/setup/blender/probe";
import type { ProbeProcessRequest, ProbeProcessResult } from "../src/setup/blender/types";
import { runProcess, terminateProcessTree, waitForChildClose } from "../src/tools/builtin/run-process";

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

async function fixtureRequest(trigger: "exit" | "overflow" | "timeout"): Promise<{
  readonly processIdFile: string;
  readonly request: ProbeProcessRequest;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "strongcode-blender-probe-process-"));
  roots.add(root);
  const grandchildPath = path.join(root, "grandchild.cjs");
  const parentPath = path.join(root, "parent.cjs");
  const processIdFile = path.join(root, "grandchild.pid");
  const readyFile = path.join(root, "grandchild.ready");
  await writeFile(grandchildPath, [
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.argv[2], 'ready');",
    "setInterval(() => fs.writeFileSync(process.argv[2], 'ready'), 100);"
  ].join("\n"), "utf8");
  await writeFile(parentPath, [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "const [grandchildPath, processIdFile, readyFile, trigger] = process.argv.slice(2);",
    "const grandchild = spawn(process.execPath, [grandchildPath, readyFile], { detached: true, stdio: 'ignore' });",
    "grandchild.unref();",
    "writeFileSync(processIdFile, JSON.stringify({ parent: process.pid, grandchild: grandchild.pid }));",
    "if (trigger === 'overflow') process.stdout.write('x'.repeat(4096));",
    "if (trigger !== 'exit') setInterval(() => {}, 1000);"
  ].join("\n"), "utf8");
  return {
    processIdFile,
    request: {
      executable: process.execPath,
      args: [parentPath, grandchildPath, processIdFile, readyFile, trigger],
      cwd: root,
      env: process.env,
      timeoutMs: trigger === "overflow" ? 5_000 : 6_000,
      maxOutputBytes: 64,
      shell: false
    }
  };
}

async function readProcessIds(processIdFile: string): Promise<{
  readonly grandchild: number;
  readonly parent: number;
}> {
  const processIds: unknown = JSON.parse(await readFile(processIdFile, "utf8"));
  if (
    typeof processIds !== "object"
    || processIds === null
    || !("parent" in processIds)
    || !("grandchild" in processIds)
    || typeof processIds.parent !== "number"
    || typeof processIds.grandchild !== "number"
  ) throw new TypeError("Invalid process fixture PID record");
  return { grandchild: processIds.grandchild, parent: processIds.parent };
}

async function runFixture(trigger: "overflow" | "timeout"): Promise<{
  readonly processIdFile: string;
  readonly result: ProbeProcessResult;
}> {
  const fixture = await fixtureRequest(trigger);
  const result = await nodeProbeProcessAdapter.run(fixture.request);
  return { processIdFile: fixture.processIdFile, result };
}

afterEach(async () => {
  await Promise.all([...survivingProcessIds].map(stopSurvivingProcess));
  survivingProcessIds.clear();
  await Promise.all([...roots].map(root => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 20
  })));
  roots.clear();
});

describe("native Blender probe process adapter", () => {
  it("bounds a child close wait when the close event never arrives", async () => {
    // Given
    const startedAt = Date.now();

    // When
    const closed = await waitForChildClose(new Promise(() => undefined), 25);

    // Then
    expect(closed).toBe(false);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(20);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it.skipIf(process.platform !== "win32").each([undefined, "relative-system-root"])(
    "maps missing or invalid parent SystemRoot %s to declared process failure channels",
    async systemRoot => {
      // Given
      const originalSystemRoot = process.env.SystemRoot;
      if (systemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = systemRoot;
      const request: ProbeProcessRequest = {
        executable: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 1_000,
        maxOutputBytes: 64,
        shell: false
      };

      try {
        // When
        const [processResult, probeResult] = await Promise.all([
          runProcess({
            command: request.executable,
            args: request.args,
            cwd: request.cwd,
            env: request.env,
            timeoutMs: request.timeoutMs,
            maxOutputBytes: request.maxOutputBytes
          }),
          nodeProbeProcessAdapter.run(request)
        ]);

        // Then
        expect(processResult).toMatchObject({ ok: false, error: { code: "TOOL_ERROR" } });
        expect(probeResult).toMatchObject({ kind: "spawn-error" });
      } finally {
        if (originalSystemRoot === undefined) delete process.env.SystemRoot;
        else process.env.SystemRoot = originalSystemRoot;
      }
    }
  );

  it("preserves output and exit status for a completed process", async () => {
    // Given
    const request: ProbeProcessRequest = {
      executable: process.execPath,
      args: ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(23)"],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 10_000,
      maxOutputBytes: 64,
      shell: false
    };

    // When
    const result = await nodeProbeProcessAdapter.run(request);

    // Then
    expect(result).toEqual({ kind: "completed", exitCode: 23, stdout: "out", stderr: "err" });
  }, 15_000);

  it.skipIf(process.platform !== "win32")(
    "rejects unmanaged Windows child termination",
    async () => {
      // Given
      const fixture = await fixtureRequest("exit");
      const child = spawn(fixture.request.executable, [...fixture.request.args], {
        cwd: fixture.request.cwd,
        env: fixture.request.env,
        shell: false,
        windowsHide: true,
        stdio: "ignore"
      });
      await once(child, "close");
      const processIds = await readProcessIds(fixture.processIdFile);
      survivingProcessIds.add(processIds.grandchild);

      // When
      const termination = terminateProcessTree(child);

      // Then
      await expect(termination).rejects.toMatchObject({ code: "TOOL_ERROR" });
    }
  );

  it.skipIf(process.platform !== "win32")(
    "keeps an exited target contained until its descendant is terminated on timeout",
    async () => {
      // Given
      const fixture = await fixtureRequest("exit");

      // When
      const result = await nodeProbeProcessAdapter.run(fixture.request);

      // Then
      const processIds = await readProcessIds(fixture.processIdFile);
      survivingProcessIds.add(processIds.grandchild);
      expect({
        grandchildExists: processExists(processIds.grandchild),
        parentExists: processExists(processIds.parent),
        result
      }).toEqual({
        grandchildExists: false,
        parentExists: false,
        result: { kind: "timeout" }
      });
    },
    10_000
  );

  it.each(["timeout", "overflow"] as const)(
    "terminates the complete child tree and waits for close on %s",
    async trigger => {
      // Given
      const expected: ProbeProcessResult = { kind: trigger };

      // When
      const fixture = await runFixture(trigger);

      // Then
      expect(fixture.result).toEqual(expected);
      const processIds = await readProcessIds(fixture.processIdFile);
      survivingProcessIds.add(processIds.parent);
      survivingProcessIds.add(processIds.grandchild);
      expect(processExists(processIds.parent)).toBe(false);
      expect(processExists(processIds.grandchild)).toBe(false);
    },
    15_000
  );
});
