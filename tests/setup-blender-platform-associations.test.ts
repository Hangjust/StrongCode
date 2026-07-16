import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BLENDER_PROBE_SENTINEL, discoverBlenderSetup } from "../src/setup/blender/discovery";
import {
  createLinuxAssociationAdapter,
  parseLinuxDesktopExec,
  parseLinuxDesktopId
} from "../src/setup/blender/discovery/linux";
import {
  createMacosAssociationAdapter,
  parseMacosMetadataApplications
} from "../src/setup/blender/discovery/macos";
import {
  createWindowsAssociationAdapter,
  parseWindowsOpenCommand,
  parseWindowsProgId
} from "../src/setup/blender/discovery/windows";
import type {
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

function completed(stdout: string): ProbeProcessResult {
  return { kind: "completed", exitCode: 0, stdout, stderr: "" };
}

describe("Windows Blender associations", () => {
  it("parses UserChoice and a direct quoted Blender open command", () => {
    // Given
    const userChoice = "    ProgId    REG_SZ    BlenderFile\r\n";
    const openCommand = '    (Default)    REG_SZ    "C:\\Program Files\\Blender Foundation\\Blender 4.3\\blender.exe" "%1"\r\n';

    // When
    const progId = parseWindowsProgId(userChoice);
    const executable = parseWindowsOpenCommand(openCommand);

    // Then
    expect(progId).toBe("BlenderFile");
    expect(executable).toBe("C:\\Program Files\\Blender Foundation\\Blender 4.3\\blender.exe");
  });

  it.each([
    '"C:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps\\blender.exe" "%1"',
    '"C:\\Blender\\blender.exe" "%1" & calc.exe',
    '"C:\\Blender\\blender.exe" "%1" | powershell',
    '"C:\\Blender\\blender.cmd" "%1"',
    'C:\\Program Files\\Blender\\blender.exe "%1"'
  ])("rejects unsafe registered command %s", command => {
    expect(parseWindowsOpenCommand(`    (Default)    REG_SZ    ${command}\r\n`)).toBeUndefined();
  });

  it("uses absolute System32 reg.exe and never executes the registered command", async () => {
    // Given
    const runner = new FixtureRunner(request => request.args.some(argument => argument.includes("UserChoice"))
      ? completed("    ProgId    REG_SZ    BlenderFile\r\n")
      : completed('    (Default)    REG_SZ    "C:\\Blender\\blender.exe" "%1"\r\n'));
    const adapter = createWindowsAssociationAdapter({
      runner,
      cwd: "C:\\workspace",
      env: {},
      systemRoot: "C:\\Windows",
      timeoutMs: 500,
      maxOutputBytes: 4096,
      maxCandidates: 4
    });

    // When
    const candidates = await adapter.blenderExecutables("C:\\workspace\\scene.blend");

    // Then
    expect(candidates).toEqual(["C:\\Blender\\blender.exe"]);
    expect(runner.requests.map(request => request.executable))
      .toEqual(["C:\\Windows\\System32\\reg.exe", "C:\\Windows\\System32\\reg.exe"]);
    expect(runner.requests.every(request => request.shell === false)).toBe(true);
  });
});

describe("macOS Blender associations", () => {
  it("parses bounded Blender.app metadata and resolves bundle executables", () => {
    // Given
    const metadata = "/Applications/Blender.app\n/Users/test/Apps/Blender Beta.app\nnot-an-app\n";

    // When
    const candidates = parseMacosMetadataApplications(metadata, 4);

    // Then
    expect(candidates).toEqual([
      "/Applications/Blender.app/Contents/MacOS/Blender",
      "/Users/test/Apps/Blender Beta.app/Contents/MacOS/Blender"
    ]);
  });

  it("uses fixed Spotlight metadata tooling with bounded shell-free requests", async () => {
    // Given
    const runner = new FixtureRunner(() => completed("/Applications/Blender.app\n"));
    const adapter = createMacosAssociationAdapter({
      runner,
      cwd: "/workspace",
      env: {},
      timeoutMs: 500,
      maxOutputBytes: 4096,
      maxCandidates: 4
    });

    // When
    const candidates = await adapter.blenderExecutables("/workspace/scene.blend");

    // Then
    expect(candidates).toEqual(["/Applications/Blender.app/Contents/MacOS/Blender"]);
    expect(runner.requests[0]).toMatchObject({ executable: "/usr/bin/mdfind", shell: false });
  });
});

describe("Linux Blender associations", () => {
  it("parses desktop IDs and direct Exec entries without shell syntax", () => {
    expect(parseLinuxDesktopId("org.blender.Blender.desktop\n")).toBe("org.blender.Blender.desktop");
    expect(parseLinuxDesktopExec('"/opt/Blender Foundation/blender" %f')).toBe("/opt/Blender Foundation/blender");
    expect(parseLinuxDesktopExec("/opt/blender/blender %U")).toBe("/opt/blender/blender");
  });

  it.each([
    "../../evil.desktop",
    "/absolute.desktop",
    "blender.desktop;touch-pwned"
  ])("rejects malformed desktop ID %s", desktopId => {
    expect(parseLinuxDesktopId(desktopId)).toBeUndefined();
  });

  it.each([
    "blender %f",
    "/opt/blender/blender --factory-startup %f",
    "/opt/blender/blender %f;touch /tmp/pwned",
    "/opt/blender/blender $(id)",
    "/opt/blender/blender `id`"
  ])("rejects unsafe desktop Exec %s", command => {
    expect(parseLinuxDesktopExec(command)).toBeUndefined();
  });

  it("queries xdg-mime and reads only a bounded desktop file under fixed roots", async () => {
    // Given
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-linux-association-"));
    const workspace = path.join(root, "workspace");
    const applications = path.join(root, "applications");
    await mkdir(workspace, { recursive: true });
    await mkdir(applications, { recursive: true });
    await writeFile(path.join(applications, "org.blender.Blender.desktop"), [
      "[Desktop Entry]",
      "Name=Blender",
      "Exec=/opt/blender/blender %f"
    ].join("\n"), "utf8");
    const runner = new FixtureRunner(() => completed("org.blender.Blender.desktop\n"));
    const adapter = createLinuxAssociationAdapter({
      runner,
      cwd: workspace,
      env: {},
      applicationRoots: [applications],
      timeoutMs: 500,
      maxOutputBytes: 4096,
      maxCandidates: 4
    });

    // When
    const candidates = await adapter.blenderExecutables(path.join(root, "scene.blend"));

    // Then
    expect(candidates).toEqual(["/opt/blender/blender"]);
    expect(runner.requests[0]).toMatchObject({
      executable: "/usr/bin/xdg-mime",
      args: ["query", "default", "application/x-blender"],
      shell: false
    });
  });

  it("rejects a desktop association root controlled by the workspace", async () => {
    // Given
    const workspace = await mkdtemp(path.join(tmpdir(), "strongcode-linux-workspace-association-"));
    const applications = path.join(workspace, "applications");
    await mkdir(applications, { recursive: true });
    await writeFile(path.join(applications, "blender.desktop"), "[Desktop Entry]\nExec=/opt/blender/blender %f\n", "utf8");
    const adapter = createLinuxAssociationAdapter({
      runner: new FixtureRunner(() => completed("blender.desktop\n")),
      cwd: workspace,
      env: {},
      applicationRoots: [applications],
      timeoutMs: 500,
      maxOutputBytes: 4096,
      maxCandidates: 4
    });

    // When
    const candidates = await adapter.blenderExecutables(path.join(workspace, "scene.blend"));

    // Then
    expect(candidates).toEqual([]);
  });
});

describe("default platform association wiring", () => {
  it("uses the host production adapter when no association adapter is supplied", async () => {
    // Given
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-default-association-"));
    const workspace = path.join(root, "workspace");
    const blenderDirectory = path.join(root, "Blender.app", "Contents", "MacOS");
    await mkdir(workspace, { recursive: true });
    await mkdir(blenderDirectory, { recursive: true });
    const blender = path.join(blenderDirectory, process.platform === "win32" ? "blender.exe" : "Blender");
    await writeFile(blender, "blender fixture", "utf8");
    if (process.platform !== "win32") await chmod(blender, 0o755);
    const applications = path.join(root, "share", "applications");
    await mkdir(applications, { recursive: true });
    await writeFile(path.join(applications, "blender.desktop"), `[Desktop Entry]\nExec=${blender} %f\n`, "utf8");
    const commandRunner = new FixtureRunner(request => {
      if (request.executable.endsWith("reg.exe")) {
        return request.args.some(argument => argument.includes("UserChoice"))
          ? completed("    ProgId    REG_SZ    BlenderFile\r\n")
          : completed(`    (Default)    REG_SZ    "${blender}" "%1"\r\n`);
      }
      if (request.executable === "/usr/bin/mdfind") return completed(`${path.join(root, "Blender.app")}\n`);
      return completed("blender.desktop\n");
    });
    const probeRunner = new FixtureRunner(() => completed(`${BLENDER_PROBE_SENTINEL}${JSON.stringify({
      version: "4.3.2",
      resourcePaths: { local: root, system: root, user: root },
      configPath: root,
      scriptsPaths: [root]
    })}\n`));

    // When
    const result = await discoverBlenderSetup({
      workspace,
      platform: process.platform,
      env: {
        PATH: "",
        SystemRoot: "C:\\Windows",
        HOME: root,
        XDG_DATA_HOME: path.join(root, "share")
      },
      process: probeRunner,
      associationCommands: commandRunner
    });

    // Then
    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0]?.sources).toEqual(["association"]);
    expect(commandRunner.requests.length).toBeGreaterThan(0);
  });

  it("keeps secure PATH discovery when the production association command fails", async () => {
    // Given
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-association-path-fallback-"));
    const workspace = path.join(root, "workspace");
    const binaryDirectory = path.join(root, "bin");
    await mkdir(workspace, { recursive: true });
    await mkdir(binaryDirectory, { recursive: true });
    const blender = path.join(binaryDirectory, process.platform === "win32" ? "blender.exe" : "blender");
    await writeFile(blender, "blender fixture", "utf8");
    if (process.platform !== "win32") await chmod(blender, 0o755);
    const probeRunner = new FixtureRunner(() => completed(`${BLENDER_PROBE_SENTINEL}${JSON.stringify({
      version: "4.3.2",
      resourcePaths: { local: root, system: root, user: root },
      configPath: root,
      scriptsPaths: [root]
    })}\n`));

    // When
    const result = await discoverBlenderSetup({
      workspace,
      env: {
        PATH: binaryDirectory,
        PATHEXT: ".EXE",
        ProgramFiles: path.join(root, "missing-program-files"),
        LOCALAPPDATA: path.join(root, "missing-local-app-data")
      },
      process: probeRunner,
      associationCommands: new FixtureRunner(() => ({ kind: "timeout" }))
    });

    // Then
    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0]?.sources).toEqual(["path"]);
  });
});
