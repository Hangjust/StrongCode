import { chmod, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexCliModelProvider } from "../src/models/codex-cli-provider";
import { listCodexModels, runCodexLogin } from "../src/models/codex-delegated";
import { prepareDelegatedSpawn, resolveDelegatedExecutable } from "../src/models/delegated-executable";
import { getGoogleAdcAccessToken, runGoogleAdcLogin } from "../src/models/gcloud-delegated";

function executableName(name: string): string {
  return process.platform === "win32" ? `${name}.EXE` : name;
}

async function writeExecutable(directory: string, name: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, executableName(name));
  await writeFile(filePath, "test executable", "utf8");
  if (process.platform !== "win32") await chmod(filePath, 0o755);
  return filePath;
}

async function writeCodexCaptureExecutable(directory: string): Promise<{
  readonly capturePath: string;
  readonly commandPath: string;
}> {
  await mkdir(directory, { recursive: true });
  const capturePath = path.join(directory, "captured-stdin.txt");
  const fixturePath = path.join(directory, "capture-codex.cjs");
  await writeFile(fixturePath, [
    'const fs = require("node:fs");',
    `const capturePath = ${JSON.stringify(capturePath)};`,
    'let input = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", chunk => { input += chunk; });',
    'process.stdin.on("end", () => {',
    '  fs.writeFileSync(capturePath, input, "utf8");',
    '  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "captured" } }) + "\\n");',
    '});'
  ].join("\n"), "utf8");

  const commandPath = path.join(directory, process.platform === "win32" ? "codex.cmd" : "codex");
  const source = process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${fixturePath}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${fixturePath}" "$@"\n`;
  await writeFile(commandPath, source, "utf8");
  if (process.platform !== "win32") await chmod(commandPath, 0o755);
  return { capturePath, commandPath };
}

describe("delegated executable resolution", () => {
  it("skips empty, relative, workspace, and workspace-alias PATH entries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-delegated-resolution-"));
    const workspace = path.join(root, "workspace");
    const workspaceBin = path.join(workspace, "bin");
    const alias = path.join(root, "workspace-bin-alias");
    const safeBin = path.join(root, "safe-bin");
    await writeExecutable(workspaceBin, "codex");
    const safeExecutable = await writeExecutable(safeBin, "codex");
    await mkdir(workspace, { recursive: true });
    try {
      await symlink(workspaceBin, alias, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && (error.code === "EPERM" || error.code === "ENOTSUP"))) throw error;
    }

    const originalEntries = ["", ".", "relative-bin", process.cwd(), workspace, workspaceBin, alias, safeBin];
    const resolved = await resolveDelegatedExecutable("codex", {
      cwd: workspace,
      env: {
        PATH: originalEntries.join(path.delimiter),
        PATHEXT: ".EXE;.CMD"
      }
    });

    expect(resolved.executable).toBe(await realpath(safeExecutable));
    expect(resolved.env.PATH?.split(path.delimiter)).toEqual([await realpath(safeBin)]);
    if (process.platform === "win32") expect(resolved.env.NoDefaultCurrentDirectoryInExePath).toBe("1");
  });

  it("fails closed when PATH contains only relative or workspace-controlled entries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-delegated-unsafe-path-"));
    const workspace = path.join(root, "workspace");
    const workspaceBin = path.join(workspace, "bin");
    await writeExecutable(workspaceBin, "gcloud");

    await expect(resolveDelegatedExecutable("gcloud", {
      cwd: workspace,
      env: { PATH: ["", ".", "relative-bin", workspaceBin].join(path.delimiter), PATHEXT: ".EXE" }
    })).rejects.toThrow("outside the current workspace");
  });

  it("supports explicit project boundaries without rejecting a user runtime under a broad shell cwd", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-delegated-boundaries-"));
    const project = path.join(root, "project");
    const bootstrap = path.join(root, ".config", "strongcode", "runtime", "bun-bootstrap");
    const userBin = path.join(root, ".bun", "bin");
    const projectBin = path.join(project, "bin");
    const safeBun = await writeExecutable(userBin, "bun");
    await writeExecutable(projectBin, "bun");

    const resolved = await resolveDelegatedExecutable("bun", {
      cwd: bootstrap,
      excludedRoots: [root, bootstrap],
      allowedExecutableRoots: [userBin],
      env: {
        PATH: [projectBin, userBin].join(path.delimiter),
        PATHEXT: ".EXE"
      }
    });

    expect(resolved.executable).toBe(await realpath(safeBun));
    expect(resolved.env.PATH).toBe(await realpath(userBin));
  });

  it("honors an explicit absolute executable but rejects relative overrides", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-delegated-explicit-"));
    const workspace = path.join(root, "workspace");
    const explicit = await writeExecutable(workspace, "test-command");

    const resolved = await resolveDelegatedExecutable("codex", {
      command: explicit,
      cwd: workspace,
      env: { PATH: ["", ".", workspace].join(path.delimiter), PATHEXT: ".EXE" }
    });
    expect(resolved.executable).toBe(await realpath(explicit));
    expect(resolved.env.PATH).toBe("");

    await expect(resolveDelegatedExecutable("codex", { command: "relative-codex" }))
      .rejects.toThrow("must be an absolute path");
  });

  it.runIf(process.platform === "win32")("wraps trusted CMD shims with the pinned system command processor", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-delegated-cmd-"));
    const shim = path.join(root, "codex.cmd");
    await writeFile(shim, "@echo off\r\necho test\r\n", "utf8");
    const comspec = process.env.ComSpec ?? process.env.COMSPEC;
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (!comspec) throw new TypeError("COMSPEC is required for this Windows test");
    if (!systemRoot) throw new TypeError("SystemRoot is required for this Windows test");

    const resolved = await resolveDelegatedExecutable("codex", {
      cwd: path.join(root, "workspace"),
      env: {
        PATH: root,
        PATHEXT: ".CMD",
        // A hostile COMSPEC must not replace the operating-system cmd.exe.
        COMSPEC: process.execPath,
        SYSTEMROOT: systemRoot
      }
    });
    const launch = prepareDelegatedSpawn(resolved, ["login", "--device-auth"]);

    expect(resolved.executable).toBe(await realpath(comspec));
    expect(resolved.windowsCommandShim).toBe(await realpath(shim));
    expect(resolved.env.COMSPEC).toBe(await realpath(comspec));
    expect(launch.args.slice(0, 4)).toEqual(["/d", "/s", "/v:off", "/c"]);
    expect(launch.args[4]).toBe('""%STRONGCODE_DELEGATED_CMD_SHIM%" login --device-auth"');
    expect(launch.env.STRONGCODE_DELEGATED_CMD_SHIM).toBe(await realpath(shim));
    expect(launch.windowsVerbatimArguments).toBe(true);
  });

  it.runIf(process.platform === "win32")("executes real CMD shims from metacharacter paths without shell injection", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-delegated-cmd-integration-"));
    const workspace = path.join(root, "workspace");
    const shimDirectory = path.join(root, "shim space &()!%STRONGCODE_REEXPAND%");
    const gcloudShim = path.join(shimDirectory, "gcloud.cmd");
    const codexShim = path.join(shimDirectory, "codex.cmd");
    await mkdir(workspace, { recursive: true });
    await mkdir(shimDirectory, { recursive: true });
    await writeFile(gcloudShim, "@echo off\r\necho delegated-wrapper-token\r\n", "utf8");
    await writeFile(codexShim, "@echo off\r\nexit /b 0\r\n", "utf8");

    await expect(getGoogleAdcAccessToken({
      command: gcloudShim,
      cwd: workspace,
      env: { COMSPEC: process.execPath }
    })).resolves.toBe("delegated-wrapper-token");
    await expect(runCodexLogin("browser", {
      command: codexShim,
      cwd: workspace,
      env: { COMSPEC: process.execPath },
      stdio: "pipe"
    })).resolves.toBeUndefined();
  });

  it.runIf(process.platform === "win32")("rejects command syntax in Windows shim arguments", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-delegated-cmd-arguments-"));
    const shim = path.join(root, "codex.cmd");
    await writeFile(shim, "@echo off\r\nexit /b 0\r\n", "utf8");
    const resolved = await resolveDelegatedExecutable("codex", {
      command: shim,
      cwd: path.join(root, "workspace"),
      env: {
        PATH: root,
        PATHEXT: ".CMD",
        COMSPEC: process.execPath,
        SYSTEMROOT: process.env.SystemRoot ?? process.env.SYSTEMROOT
      }
    });

    for (const argument of ["two words", "x&whoami", "x|whoami", "x>file", "x<input", "x^y", "x%PATH%", "x!PATH!", 'x"y', "x\rwhoami", "x\nwhoami"]) {
      expect(() => prepareDelegatedSpawn(resolved, [argument])).toThrow("cannot be passed safely");
    }
  });

  it("routes every Codex and gcloud launch path through absolute override validation", async () => {
    const relativeCommand = "repo-controlled-command";
    const request = { prompt: "hello", sessionId: "test", messages: [], tools: [] };
    const codexProvider = new CodexCliModelProvider({
      providerId: "chatgpt",
      modelId: "default",
      modelConfig: {},
      command: relativeCommand
    });

    await expect(codexProvider.complete(request)).rejects.toThrow("Explicit codex command must be an absolute path");
    await expect(runCodexLogin("browser", { command: relativeCommand })).rejects.toThrow("Explicit codex command must be an absolute path");
    await expect(listCodexModels({ command: relativeCommand })).rejects.toThrow("Explicit codex command must be an absolute path");
    await expect(runGoogleAdcLogin("headless", { command: relativeCommand })).rejects.toThrow("Explicit gcloud command must be an absolute path");
    await expect(getGoogleAdcAccessToken({ command: relativeCommand })).rejects.toThrow("Explicit gcloud command must be an absolute path");
  });

  it("forwards a distinct prompt after existing transcript messages to the Codex CLI", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-codex-prompt-"));
    const fixture = await writeCodexCaptureExecutable(root);
    const provider = new CodexCliModelProvider({
      providerId: "codex-cli",
      modelId: "default",
      modelConfig: {},
      command: fixture.commandPath,
      cwd: path.join(root, "workspace")
    });

    await expect(provider.complete({
      prompt: "Create the context checkpoint summary.",
      systemPrompt: "Trusted system instructions.",
      sessionId: "compaction-contract",
      messages: [
        { role: "user", content: "Existing request" },
        { role: "assistant", content: "Prior response" }
      ],
      tools: []
    })).resolves.toMatchObject({ message: "captured", toolCalls: [] });
    const captured = await readFile(fixture.capturePath, "utf8");

    expect(captured).toContain("user: Existing request");
    expect(captured).toContain("assistant: Prior response");
    expect(captured).toContain("user: Create the context checkpoint summary.");
  });
});
