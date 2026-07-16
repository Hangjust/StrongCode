import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { StrongCodeError } from "../src/core/errors";
import {
  isManagedWindowsJobProcess,
  spawnWindowsJobProcess
} from "../src/tools/builtin/windows-job-process";
import {
  spawnHostInParentJob,
  writeAssignmentFailureHost
} from "./windows-job-host-parent-fixture";
import {
  cleanupWindowsJobFixtures,
  fixtureRoot,
  nodeEnvironment,
  spawnRawHost,
  trackProcess,
  unsafeLaunchSpecification,
  waitForClose,
  waitForFile,
  windowsJobHostAsset
} from "./windows-job-host-process-fixture";

const HOST_INPUT_LIMIT_BYTES = 1024 * 1024;

afterEach(async () => {
  await cleanupWindowsJobFixtures();
});

describe.skipIf(process.platform !== "win32")("Windows Job Object host", () => {
  it.each(["relative-executable", "relative-cwd", "device-executable", "control-cwd"] as const)(
    "rejects unsafe %s at both launcher and raw host boundaries before target launch",
    async kind => {
      // Given
      const root = await fixtureRoot();
      const marker = path.join(root, `${kind}.marker`);
      const target = path.join(root, `${kind}.cjs`);
      await writeFile(target, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'launched');`, "utf8");
      const specification = await unsafeLaunchSpecification(kind, root, target);
      let launchError: StrongCodeError | undefined;
      try {
        const child = trackProcess(spawnWindowsJobProcess(specification));
        await waitForClose(child, 5_000);
      } catch (error) {
        if (!(error instanceof StrongCodeError)) throw error;
        launchError = error;
      }

      // When
      const outcome = await waitForClose(spawnRawHost(Buffer.from(JSON.stringify(specification), "utf8")), 5_000);

      // Then
      expect(launchError).toMatchObject({ code: "VALIDATION_ERROR" });
      expect(outcome.code).not.toBe(0);
      await expect(access(marker)).rejects.toThrow();
    }
  );

  it("nests the unmodified production host in an ordinary parent Job and launches the target", async () => {
    // Given
    const root = await fixtureRoot();
    const marker = path.join(root, "nested-production-target.marker");
    const target = path.join(root, "nested-production-target.cjs");
    await writeFile(target, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'launched');`, "utf8");
    const payload = Buffer.from(JSON.stringify({
      executable: process.execPath,
      args: [target],
      cwd: root,
      env: nodeEnvironment()
    }), "utf8");
    const startedAt = Date.now();

    // When
    const outcome = await waitForClose(
      await spawnHostInParentJob(root, payload, windowsJobHostAsset()),
      8_000
    );

    // Then
    expect(outcome.code).toBe(0);
    expect(outcome.stderr).toEqual(Buffer.alloc(0));
    expect(Date.now() - startedAt).toBeLessThan(8_000);
    await expect(readFile(marker, "utf8")).resolves.toBe("launched");
  }, 10_000);

  it("fails real variant assignment inside an ordinary parent Job before target launch", async () => {
    // Given
    const root = await fixtureRoot();
    const marker = path.join(root, "assignment-target.marker");
    const target = path.join(root, "assignment-target.cjs");
    await writeFile(target, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'launched');`, "utf8");
    const payload = Buffer.from(JSON.stringify({
      executable: process.execPath,
      args: [target],
      cwd: root,
      env: nodeEnvironment()
    }), "utf8");
    const variantHost = await writeAssignmentFailureHost(root);
    const startedAt = Date.now();

    // When
    const outcome = await waitForClose(await spawnHostInParentJob(root, payload, variantHost), 8_000);

    // Then
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr.toString("utf8")).toContain("AssignProcessToJobObject");
    expect(Date.now() - startedAt).toBeLessThan(8_000);
    await expect(access(marker)).rejects.toThrow();
  }, 10_000);

  it("preserves argv, cwd, replacement environment, byte streams, stdin EOF, and exit code", async () => {
    // Given
    const root = await fixtureRoot();
    const record = path.join(root, "record.json");
    const target = path.join(root, "target.cjs");
    const expectedArgs = ["", "two words", "say\"hello", "trailing\\", "雪", "&|<>^%!$"];
    await writeFile(target, [
      "const fs = require('node:fs');",
      "fs.writeFileSync('record.json', JSON.stringify({",
      "  argv: process.argv.slice(2), cwd: process.cwd(), env: process.env, stdinBytes: fs.readFileSync(0).length",
      "}));",
      "process.stdout.write(Buffer.from([0, 65, 255, 10]));",
      "process.stderr.write(Buffer.from([254, 66, 0, 10]));",
      "process.exit(23);"
    ].join("\n"), "utf8");

    // When
    const child = trackProcess(spawnWindowsJobProcess({
      executable: process.execPath,
      args: [target, ...expectedArgs],
      cwd: root,
      env: { ...nodeEnvironment(), JOB_HOST_SENTINEL: "replacement-only" }
    }));
    const outcome = await waitForClose(child);

    // Then
    const observed: unknown = JSON.parse(await readFile(record, "utf8"));
    expect(isManagedWindowsJobProcess(child)).toBe(true);
    expect(observed).toEqual({
      argv: expectedArgs,
      cwd: root,
      env: { ...nodeEnvironment(), JOB_HOST_SENTINEL: "replacement-only" },
      stdinBytes: 0
    });
    expect(outcome.stdout).toEqual(Buffer.from([0, 65, 255, 10]));
    expect(outcome.stderr).toEqual(Buffer.from([254, 66, 0, 10]));
    expect(outcome.code).toBe(23);
  });

  it("passes PowerShell metacharacters literally without creating a marker", async () => {
    // Given
    const root = await fixtureRoot();
    const marker = path.join(root, "injected.txt");
    const record = path.join(root, "argv.json");
    const target = path.join(root, "literal.cjs");
    const payload = `& { [IO.File]::WriteAllText('${marker}', 'injected') }; $env:PATH | Out-File '${marker}'`;
    await writeFile(target, "require('node:fs').writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));", "utf8");

    // When
    const child = trackProcess(spawnWindowsJobProcess({
      executable: process.execPath,
      args: [target, payload],
      cwd: root,
      env: nodeEnvironment()
    }));
    const outcome = await waitForClose(child);

    // Then
    expect(outcome.code).toBe(0);
    expect(JSON.parse(await readFile(record, "utf8"))).toEqual([payload]);
    await expect(access(marker)).rejects.toThrow();
  });

  it.each([
    ["trailing JSON", Buffer.from("{\"executable\":\"never\"} trailing", "utf8")],
    ["invalid UTF-8", Buffer.from([0xc3, 0x28])],
    ["oversized input", Buffer.alloc(HOST_INPUT_LIMIT_BYTES + 1, 0x61)]
  ])("fails bounded host setup for %s before target launch", async (_name, payload) => {
    // Given
    const startedAt = Date.now();

    // When
    const outcome = await waitForClose(spawnRawHost(payload), 5_000);

    // Then
    expect(outcome.code).not.toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("fails launch setup after containment without running target code", async () => {
    // Given
    const root = await fixtureRoot();
    const marker = path.join(root, "target-launched");
    const target = path.join(root, "target.cjs");
    await writeFile(target, "require('node:fs').writeFileSync('target-launched', 'launched');", "utf8");
    const child = trackProcess(spawnWindowsJobProcess({
      executable: process.execPath,
      args: [target],
      cwd: path.join(root, "missing-directory"),
      env: nodeEnvironment()
    }));

    // When
    const outcome = await waitForClose(child);

    // Then
    expect(outcome.code).not.toBe(0);
    await expect(access(marker)).rejects.toThrow();
  });

  it("kills A to B to C on host death while an unrelated process survives", async () => {
    // Given
    const root = await fixtureRoot();
    const trigger = path.join(root, "trigger");
    const cMarker = path.join(root, "c-survived");
    const controlMarker = path.join(root, "control-survived");
    const watcher = path.join(root, "watcher.cjs");
    const childB = path.join(root, "b.cjs");
    const childA = path.join(root, "a.cjs");
    await writeFile(watcher, [
      "const fs = require('node:fs');",
      "const [ready, trigger, marker] = process.argv.slice(2);",
      "fs.writeFileSync(ready, 'ready');",
      "setInterval(() => { if (fs.existsSync(trigger)) fs.writeFileSync(marker, 'survived'); }, 10);"
    ].join("\n"), "utf8");
    await writeFile(childB, [
      "const { spawn } = require('node:child_process'); const fs = require('node:fs');",
      "spawn(process.execPath, process.argv.slice(2), { stdio: 'ignore' });",
      "fs.writeFileSync('b-finished', 'finished');"
    ].join("\n"), "utf8");
    await writeFile(childA, [
      "const { spawn } = require('node:child_process'); const fs = require('node:fs');",
      "spawn(process.execPath, process.argv.slice(2), { stdio: 'ignore' });",
      "fs.writeFileSync('a-finished', 'finished');"
    ].join("\n"), "utf8");
    const control = trackProcess(spawn(
      process.execPath,
      [watcher, path.join(root, "control-ready"), trigger, controlMarker],
      { cwd: root, env: nodeEnvironment(), shell: false, windowsHide: true, stdio: "ignore" }
    ));
    const host = trackProcess(spawnWindowsJobProcess({
      executable: process.execPath,
      args: [childA, childB, watcher, path.join(root, "c-ready"), trigger, cMarker],
      cwd: root,
      env: nodeEnvironment()
    }));
    await Promise.all([
      waitForFile(path.join(root, "a-finished")),
      waitForFile(path.join(root, "b-finished")),
      waitForFile(path.join(root, "c-ready")),
      waitForFile(path.join(root, "control-ready"))
    ]);
    await delay(100);

    // When
    host.kill("SIGKILL");
    await waitForClose(host, 5_000);
    await writeFile(trigger, "trigger", "utf8");
    await waitForFile(controlMarker);
    await delay(100);

    // Then
    await expect(access(cMarker)).rejects.toThrow();
    expect(control.exitCode).toBeNull();
  }, 20_000);
});
