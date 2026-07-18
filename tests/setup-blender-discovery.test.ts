import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BLENDER_PROBE_SENTINEL,
  CPYTHON_PROBE_SENTINEL,
  discoverBlenderSetup
} from "../src/setup/blender/discovery";
import type {
  PlatformAssociationAdapter,
  ProbeProcessAdapter,
  ProbeProcessRequest,
  ProbeProcessResult
} from "../src/setup/blender/types";

function executableName(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}

async function executable(directory: string, name: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, executableName(name));
  await writeFile(filePath, `${name} fixture`, "utf8");
  if (process.platform !== "win32") await chmod(filePath, 0o755);
  return filePath;
}

function blenderOutput(version: string, root: string): string {
  return `${BLENDER_PROBE_SENTINEL}${JSON.stringify({
    version,
    resourcePaths: {
      local: path.join(root, "local"),
      system: path.join(root, "system"),
      user: path.join(root, "user")
    },
    configPath: path.join(root, "config"),
    scriptsPaths: [path.join(root, "scripts")],
    extensionsPath: path.join(root, "extensions")
  })}\n`;
}

function pythonOutput(executablePath: string): string {
  return `${CPYTHON_PROBE_SENTINEL}${JSON.stringify({
    implementation: "cpython",
    version: [3, 11, 4],
    executable: executablePath,
    prefix: path.dirname(executablePath),
    pointerWidth: 64,
    sysconfigPlatform: "win_amd64"
  })}\n`;
}

class FixtureProcess implements ProbeProcessAdapter {
  readonly requests: ProbeProcessRequest[] = [];

  constructor(private readonly response: (request: ProbeProcessRequest) => ProbeProcessResult) {}

  async run(request: ProbeProcessRequest): Promise<ProbeProcessResult> {
    this.requests.push(request);
    return this.response(request);
  }
}

class FixtureAssociations implements PlatformAssociationAdapter {
  readonly calls: string[] = [];

  constructor(private readonly candidates: readonly string[]) {}

  async blenderExecutables(blendFile: string | undefined): Promise<readonly string[]> {
    this.calls.push(blendFile ?? "none");
    return this.candidates;
  }
}

describe("read-only Blender setup discovery", () => {
  it("discovers bounded workspace signal, secure PATH Blender, and compatible CPython", async () => {
    // Given
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-blender-discovery-"));
    const workspace = path.join(root, "workspace");
    const safeBin = path.join(root, "safe-bin");
    await mkdir(path.join(workspace, "scene"), { recursive: true });
    await writeFile(path.join(workspace, "scene", "hero.blend"), "BLENDER", "utf8");
    const blender = await executable(safeBin, "blender");
    const python = await executable(safeBin, "python3");
    const runner = new FixtureProcess(request => ({
      kind: "completed",
      exitCode: 0,
      stdout: path.basename(request.executable).toLowerCase().startsWith("blender")
        ? blenderOutput("4.3.2", path.join(root, "profile"))
        : pythonOutput(python),
      stderr: ""
    }));

    // When
    const result = await discoverBlenderSetup({
      workspace,
      env: { PATH: safeBin, PATHEXT: ".EXE" },
      platform: process.platform,
      process: runner,
      associations: new FixtureAssociations([])
    });

    // Then
    expect(result.workspaceBlendFile).toBe(await realpath(path.join(workspace, "scene", "hero.blend")));
    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0]).toMatchObject({
      executable: { canonicalPath: await realpath(blender), sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      version: "4.3.2",
      sources: ["path"]
    });
    expect(result.selection.kind).toBe("selected");
    expect(result.python).toMatchObject({
      executable: { canonicalPath: await realpath(python), sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      implementation: "cpython",
      version: { major: 3, minor: 11, patch: 4 }
    });
    expect(runner.requests.find(request => request.args.includes("--python-expr"))?.args.slice(0, 2))
      .toEqual(["--background", "--factory-startup"]);
    expect(runner.requests.every(request => request.shell === false)).toBe(true);
  });

  it("deduplicates canonical association paths and requires explicit profile selection", async () => {
    // Given
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-blender-profiles-"));
    const workspace = path.join(root, "workspace");
    const installs = path.join(root, "installs");
    const first = await executable(path.join(installs, "one"), "blender");
    const second = await executable(path.join(installs, "two"), "blender");
    await mkdir(workspace, { recursive: true });
    const associations = new FixtureAssociations([first, path.join(installs, "one", ".", executableName("blender")), second]);
    const runner = new FixtureProcess(request => ({
      kind: "completed",
      exitCode: 0,
      stdout: blenderOutput(request.executable === awaitableCanonical(first) ? "4.2.0" : "4.3.0", `${request.executable}-profile`),
      stderr: ""
    }));

    // When
    const result = await discoverBlenderSetup({
      workspace,
      env: { PATH: "" },
      platform: process.platform,
      process: runner,
      associations
    });

    // Then
    expect(result.profiles).toHaveLength(2);
    expect(result.selection).toMatchObject({ kind: "required", profileIds: expect.any(Array) });
    expect(runner.requests.filter(request => request.args.includes("--python-expr"))).toHaveLength(2);
  });

  it("rejects workspace executables, traversal, shell shims, and malformed associations", async () => {
    // Given
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-blender-hostile-"));
    const workspace = path.join(root, "workspace");
    const workspaceBin = path.join(workspace, "bin");
    const safeBin = path.join(root, "safe-bin");
    const shadowed = await executable(workspaceBin, "blender");
    const traversal = path.join(safeBin, "..", "workspace", "bin", executableName("blender"));
    const shim = path.join(safeBin, "blender.cmd");
    await mkdir(safeBin, { recursive: true });
    await writeFile(shim, "@echo off", "utf8");
    const associations = new FixtureAssociations([shadowed, traversal, shim, "blender --background", "../blender"]);
    const runner = new FixtureProcess(() => ({ kind: "completed", exitCode: 0, stdout: "", stderr: "" }));

    // When
    const result = await discoverBlenderSetup({
      workspace,
      env: { PATH: [workspaceBin, "."].join(path.delimiter), PATHEXT: ".EXE;.CMD" },
      platform: process.platform,
      process: runner,
      associations
    });

    // Then
    expect(result.profiles).toEqual([]);
    expect(runner.requests).toEqual([]);
  });

  it.each([
    [{ kind: "completed", exitCode: 1, stdout: "", stderr: "failed" }, "nonzero"],
    [{ kind: "completed", exitCode: 0, stdout: "{}", stderr: "" }, "non-sentinel"],
    [{
      kind: "completed",
      exitCode: 0,
      stdout: `${BLENDER_PROBE_SENTINEL}${JSON.stringify({
        version: "4.3.0",
        resourcePaths: { local: process.cwd(), system: process.cwd(), user: process.cwd() },
        configPath: `${path.parse(process.cwd()).root}safe${path.sep}..${path.sep}escape`,
        scriptsPaths: [process.cwd()]
      })}\n`,
      stderr: ""
    }, "path-traversing"],
    [{ kind: "overflow" }, "oversized"],
    [{ kind: "timeout" }, "timeout"]
  ] satisfies ReadonlyArray<readonly [ProbeProcessResult, string]>)
  ("rejects %s Blender probes", async (probeResult, _label) => {
    // Given
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-blender-probe-reject-"));
    const workspace = path.join(root, "workspace");
    const safeBin = path.join(root, "safe-bin");
    await mkdir(workspace, { recursive: true });
    await executable(safeBin, "blender");

    // When
    const result = await discoverBlenderSetup({
      workspace,
      env: { PATH: safeBin, PATHEXT: ".EXE" },
      platform: process.platform,
      process: new FixtureProcess(() => probeResult),
      associations: new FixtureAssociations([])
    });

    // Then
    expect(result.profiles).toEqual([]);
  });

  it("rejects non-CPython and Python older than 3.11", async () => {
    // Given
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-python-incompatible-"));
    const workspace = path.join(root, "workspace");
    const safeBin = path.join(root, "safe-bin");
    const python = await executable(safeBin, "python3");
    await mkdir(workspace, { recursive: true });
    const incompatible = `${CPYTHON_PROBE_SENTINEL}${JSON.stringify({
      implementation: "pypy",
      version: [3, 10, 14],
      executable: python,
      prefix: safeBin,
      pointerWidth: 64,
      sysconfigPlatform: "win_amd64"
    })}\n`;

    // When
    const result = await discoverBlenderSetup({
      workspace,
      env: { PATH: safeBin, PATHEXT: ".EXE" },
      platform: process.platform,
      process: new FixtureProcess(() => ({ kind: "completed", exitCode: 0, stdout: incompatible, stderr: "" })),
      associations: new FixtureAssociations([])
    });

    // Then
    expect(result.python).toBeUndefined();
  });
});

function awaitableCanonical(value: string): string {
  return path.resolve(value);
}
