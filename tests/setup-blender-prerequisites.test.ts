import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BLENDER_PROBE_SENTINEL,
  CPYTHON_PROBE_SENTINEL,
  discoverBlenderSetup
} from "../src/setup/blender/discovery";
import {
  createWindowsAssociationAdapter,
  type WindowsInstallEntry,
  type WindowsInstallEnumerator
} from "../src/setup/blender/discovery/windows";
import type {
  PlatformAssociationAdapter,
  ProbeProcessAdapter,
  ProbeProcessRequest,
  ProbeProcessResult
} from "../src/setup/blender/types";

class FixtureRunner implements ProbeProcessAdapter {
  readonly requests: ProbeProcessRequest[] = [];

  constructor(private readonly respond: (request: ProbeProcessRequest) => ProbeProcessResult) {}

  async run(request: ProbeProcessRequest): Promise<ProbeProcessResult> {
    this.requests.push(request);
    return this.respond(request);
  }
}

const noAssociations: PlatformAssociationAdapter = {
  async blenderExecutables(): Promise<readonly string[]> {
    return [];
  }
};

async function writeExecutable(directory: string, name: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const executable = path.join(directory, process.platform === "win32" ? `${name}.exe` : name);
  await writeFile(executable, `${name} fixture`, "utf8");
  if (process.platform !== "win32") await chmod(executable, 0o755);
  return executable;
}

function pythonProbe(
  executable: string,
  minor: number,
  pointerWidth = 64,
  sysconfigPlatform = "win_amd64"
): ProbeProcessResult {
  return {
    kind: "completed",
    exitCode: 0,
    stdout: `${CPYTHON_PROBE_SENTINEL}${JSON.stringify({
      implementation: "cpython",
      version: [3, minor, 7],
      executable,
      prefix: path.dirname(executable),
      pointerWidth,
      sysconfigPlatform
    })}\n`,
    stderr: ""
  };
}

describe("locked CPython discovery", () => {
  it("continues past newer CPython and selects exact 3.11", async () => {
    // Given
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-python-lock-"));
    const workspace = path.join(root, "workspace");
    const binaryDirectory = path.join(root, "bin");
    await mkdir(workspace, { recursive: true });
    const python312 = await writeExecutable(binaryDirectory, "python");
    const python311 = await writeExecutable(binaryDirectory, "python3.11");
    const runner = new FixtureRunner(request => {
      return request.executable === python312 ? pythonProbe(python312, 12) : pythonProbe(python311, 11);
    });

    // When
    const result = await discoverBlenderSetup({
      workspace,
      env: { PATH: binaryDirectory, PATHEXT: ".EXE" },
      process: runner,
      associations: noAssociations
    });

    // Then
    expect(result.python?.version).toEqual({ major: 3, minor: 11, patch: 7 });
    expect(result.python?.executable.canonicalPath).toBe(python311);
    expect(runner.requests.some(request => path.basename(request.executable).includes("3.11"))).toBe(true);
  });

  it("continues past 32-bit CPython 3.11 and selects 64-bit win_amd64", async () => {
    // Given
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-python-bitness-"));
    const workspace = path.join(root, "workspace");
    const binaryDirectory = path.join(root, "bin");
    await mkdir(workspace, { recursive: true });
    const python32 = await writeExecutable(binaryDirectory, "python");
    const python64 = await writeExecutable(binaryDirectory, "python3.11");
    const runner = new FixtureRunner(request => request.executable === python32
      ? pythonProbe(python32, 11, 32, "win32")
      : pythonProbe(python64, 11, 64, "win_amd64"));

    // When
    const result = await discoverBlenderSetup({
      workspace,
      platform: "win32",
      env: { PATH: binaryDirectory, PATHEXT: ".EXE" },
      process: runner,
      associations: noAssociations
    });

    // Then
    expect(runner.requests.map(request => path.basename(request.executable).toLowerCase()))
      .toEqual(expect.arrayContaining(["python.exe", "python3.11.exe"]));
    expect(result.python?.executable.canonicalPath).toBe(python64);
    expect(result.python).toMatchObject({ pointerWidth: 64, sysconfigPlatform: "win_amd64" });
  });

  it("reports Python missing when only 32-bit CPython 3.11 is available", async () => {
    // Given
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-python-32-only-"));
    const workspace = path.join(root, "workspace");
    const binaryDirectory = path.join(root, "bin");
    await mkdir(workspace, { recursive: true });
    const python32 = await writeExecutable(binaryDirectory, "python");

    // When
    const result = await discoverBlenderSetup({
      workspace,
      platform: "win32",
      env: { PATH: binaryDirectory, PATHEXT: ".EXE" },
      process: new FixtureRunner(() => pythonProbe(python32, 11, 32, "win32")),
      associations: noAssociations
    });

    // Then
    expect(result.python).toBeUndefined();
  });
});

describe("Windows standard Blender roots", () => {
  it("boundedly enumerates valid Program Files and LocalAppData installs", async () => {
    // Given
    const enumeratedRoots: string[] = [];
    const enumerator: WindowsInstallEnumerator = {
      async directories(root, maximum): Promise<readonly WindowsInstallEntry[]> {
        enumeratedRoots.push(root);
        const entries: readonly WindowsInstallEntry[] = [
          { name: "Blender 4.3", kind: "directory" },
          { name: "Blender latest", kind: "directory" },
          { name: "Blender 4.4", kind: "link" },
          { name: "..\\Blender 4.5", kind: "directory" }
        ];
        return entries.slice(0, maximum);
      }
    };
    const adapter = createWindowsAssociationAdapter({
      runner: new FixtureRunner(() => ({ kind: "timeout" })),
      cwd: "C:\\workspace",
      env: {
        ProgramFiles: "C:\\Program Files",
        ProgramW6432: "D:\\Program Files",
        LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local"
      },
      systemRoot: "C:\\Windows",
      installEnumerator: enumerator,
      timeoutMs: 500,
      maxOutputBytes: 4096,
      maxCandidates: 4
    });

    // When
    const candidates = await adapter.blenderExecutables("C:\\workspace\\scene.blend");

    // Then
    expect(candidates).toEqual([
      "C:\\Program Files\\Blender Foundation\\Blender 4.3\\blender.exe",
      "D:\\Program Files\\Blender Foundation\\Blender 4.3\\blender.exe",
      "C:\\Users\\test\\AppData\\Local\\Programs\\Blender Foundation\\Blender 4.3\\blender.exe"
    ]);
    expect(enumeratedRoots).toEqual([
      "C:\\Program Files\\Blender Foundation",
      "D:\\Program Files\\Blender Foundation",
      "C:\\Users\\test\\AppData\\Local\\Programs\\Blender Foundation"
    ]);
  });

  it.runIf(process.platform === "win32")("recommends a standard install for a .blend workspace without PATH or association", async () => {
    // Given
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-standard-blender-"));
    const workspace = path.join(root, "workspace");
    const programFiles = path.join(root, "Program Files");
    const install = path.join(programFiles, "Blender Foundation", "Blender 4.3");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "scene.blend"), "BLENDER", "utf8");
    await writeExecutable(install, "blender");
    const probeRunner = new FixtureRunner(() => ({
      kind: "completed",
      exitCode: 0,
      stdout: `${BLENDER_PROBE_SENTINEL}${JSON.stringify({
        version: "4.3.2",
        resourcePaths: { local: root, system: root, user: root },
        configPath: root,
        scriptsPaths: [root]
      })}\n`,
      stderr: ""
    }));

    // When
    const result = await discoverBlenderSetup({
      workspace,
      platform: "win32",
      env: {
        PATH: "",
        PATHEXT: ".EXE",
        ProgramFiles: programFiles,
        LOCALAPPDATA: path.join(root, "Local")
      },
      process: probeRunner,
      associationCommands: new FixtureRunner(() => ({ kind: "timeout" }))
    });

    // Then
    expect(result.workspaceBlendFile).toBe(path.join(workspace, "scene.blend"));
    expect(result.profiles).toHaveLength(1);
    expect(result.selection.kind).toBe("selected");
  });
});
