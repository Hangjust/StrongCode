import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ArtifactProvenance, WheelLock } from "../src/setup/blender/artifact-manifest";
import { BLENDER_ADDON_PROBE_SENTINEL } from "../src/setup/blender/blender-preferences";
import {
  BLENDER_INTEGRATION_LOCK_ID,
  installBlenderIntegration,
  type InstallBlenderIntegrationOptions
} from "../src/setup/blender/install";
import { nodeBlenderInstallerFileSystem } from "../src/setup/blender/install-files";
import type {
  EnvironmentProcessAdapter,
  EnvironmentProcessRequest
} from "../src/setup/blender/python-env";
import type { ProbeProcessAdapter, ProbeProcessRequest } from "../src/setup/blender/types";
import {
  createBlenderInstallJournal,
  readBlenderInstallJournal,
  rollbackBlenderInstall
} from "../src/setup/blender/journal";

const MODULE = "strongcode_blender_mcp";
const ACTIVATION_PHASES = [
  "credential_active",
  "addon_active",
  "preferences_active",
  "permissions_active",
  "mcp_active",
  "state_active"
] as const;

const hash = (content: string | Buffer): string => createHash("sha256").update(content).digest("hex");
const pypiUrl = (filename: string): string =>
  `https://files.pythonhosted.org/packages/aa/bb/${"c".repeat(60)}/${filename}`;

const mcpSource = `${JSON.stringify({
  version: 1,
  defaults: {
    autoStart: false,
    timeout: { startupMs: 15000, requestMs: 60000 },
    environment: { inherit: false, allowlist: ["PATH"] }
  },
  mcpServers: {},
  webSearch: { providers: [] },
  templates: {}
}, null, 2)}\n`;

const yamlSource = `version: 1
workspace: .
dataDir: .strongcode
defaultAgent: tesla
agents:
  tesla:
    model: mock
    tools: [read_file]
models:
  mock:
    provider: mock
permissions:
  tools:
    read_file: allow
`;

function manifests(): {
  readonly lock: WheelLock;
  readonly provenance: ArtifactProvenance;
  readonly artifacts: ReadonlyMap<string, string>;
  readonly requirements: string;
} {
  const wheelContent = "wheel fixture";
  const addonContent = "upstream addon fixture";
  const filename = "example-1.0.0-py3-none-any.whl";
  const wheel = {
    name: "example",
    version: "1.0.0",
    filename,
    url: pypiUrl(filename),
    size: Buffer.byteLength(wheelContent),
    sha256: hash(wheelContent),
    requiresPython: ">=3.11",
    license: "MIT"
  };
  const commit = "a".repeat(40);
  return {
    lock: {
      schemaVersion: 1,
      target: { implementation: "cp", python: "3.11", abi: "cp311", platform: "win_amd64" },
      roots: ["example==1.0.0"],
      wheels: [wheel]
    },
    provenance: {
      schemaVersion: 1,
      upstream: { repository: "https://github.com/ahujasid/blender-mcp", commit },
      artifacts: [
        { kind: "wheel", ...wheel, metadataUrl: "https://pypi.org/pypi/example/1.0.0/json" },
        {
          kind: "addon",
          filename: "addon.py",
          commit,
          url: `https://raw.githubusercontent.com/owner/repo/${commit}/addon.py`,
          size: Buffer.byteLength(addonContent),
          sha256: hash(addonContent)
        }
      ],
      license: {
        path: "LICENSE",
        spdx: "MIT",
        sourceUrl: `https://raw.githubusercontent.com/owner/repo/${commit}/LICENSE`,
        sha256: "b".repeat(64),
        sourceSha256: "c".repeat(64),
        appliesTo: [filename, "addon.py"]
      },
      derivatives: []
    },
    artifacts: new Map([[filename, wheelContent], ["addon.py", addonContent]]),
    requirements: `example==1.0.0 --hash=sha256:${wheel.sha256}\n`
  };
}

class PythonProcess implements EnvironmentProcessAdapter {
  readonly requests: EnvironmentProcessRequest[] = [];
  afterDistributionProbe: ((request: EnvironmentProcessRequest) => Promise<void>) | undefined;

  async run(request: EnvironmentProcessRequest) {
    this.requests.push(request);
    if (request.args.some(argument => argument.includes("importlib.metadata"))) {
      await this.afterDistributionProbe?.(request);
      return { kind: "completed" as const, exitCode: 0, stdout: "__STRONGCODE_BLENDER_DISTRIBUTIONS_V1__[\"example==1.0.0\"]\n", stderr: "" };
    }
    if (request.args.includes("--self-test")) {
      return { kind: "completed" as const, exitCode: 0,
        stdout: "__STRONGCODE_BLENDER_TOOLS_V1__[\"get_scene_info\",\"get_object_info\",\"get_viewport_screenshot\",\"execute_blender_code\"]\n", stderr: "" };
    }
    return { kind: "completed" as const, exitCode: 0, stdout: "", stderr: "" };
  }
}

class BlenderProcess implements ProbeProcessAdapter {
  readonly requests: ProbeProcessRequest[] = [];
  addonEnabled = true;
  rendezvousExists = false;
  preserveExistingPreferences = false;
  afterEnable: (() => Promise<void>) | undefined;
  afterProbe: (() => Promise<void>) | undefined;

  async run(request: ProbeProcessRequest) {
    this.requests.push(request);
    if (request.args.some(argument => argument.includes("addon_enable"))) {
      const config = request.env.BLENDER_USER_CONFIG;
      if (config && !this.preserveExistingPreferences) {
        await writeFile(path.join(config, "userpref.blend"), "managed preferences\n", "utf8");
      }
      this.addonEnabled = true;
      await this.afterEnable?.();
      return { kind: "completed" as const, exitCode: 0, stdout: "", stderr: "" };
    }
    await this.afterProbe?.();
    return {
      kind: "completed" as const,
      exitCode: 0,
      stdout: `${BLENDER_ADDON_PROBE_SENTINEL}${JSON.stringify({
        addonEnabled: this.addonEnabled,
        background: true,
        rendezvousExists: this.rendezvousExists
      })}\n`,
      stderr: ""
    };
  }
}

type Fixture = {
  readonly root: string;
  readonly homePath: string;
  readonly profileConfig: string;
  readonly userResource: string;
  readonly profile: InstallBlenderIntegrationOptions["profile"];
  readonly options: InstallBlenderIntegrationOptions;
  readonly blender: BlenderProcess;
  readonly python: PythonProcess;
  readonly downloads: string[][];
};

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "strongcode-blender-install-"));
  const homePath = path.join(root, "home");
  const profileConfig = path.join(root, "blender-profile", "config");
  const userResource = path.join(root, "blender-profile", "user");
  const blenderPath = path.join(root, "Blender", "blender.exe");
  const pythonPath = path.join(root, "Python311", "python.exe");
  const wrapperAssetsPath = path.join(root, "wrapper-assets");
  const addonAssetsPath = path.join(root, "addon-assets", MODULE);
  await Promise.all([
    mkdir(path.join(homePath, "mcps"), { recursive: true }),
    mkdir(profileConfig, { recursive: true }),
    mkdir(path.join(userResource, "scripts", "addons"), { recursive: true }),
    mkdir(path.dirname(blenderPath), { recursive: true }),
    mkdir(path.dirname(pythonPath), { recursive: true }),
    mkdir(path.join(wrapperAssetsPath, "wrapper"), { recursive: true }),
    mkdir(addonAssetsPath, { recursive: true })
  ]);
  await Promise.all([
    writeFile(path.join(homePath, "mcp.json"), mcpSource, "utf8"),
    writeFile(path.join(homePath, "strongcode.config.yaml"), yamlSource, "utf8"),
    writeFile(path.join(profileConfig, "userpref.blend"), "user preferences\n", "utf8"),
    writeFile(blenderPath, "blender executable", "utf8"),
    writeFile(pythonPath, "python executable", "utf8"),
    writeFile(path.join(wrapperAssetsPath, "strongcode-blender-wrapper.py"), "# derivative wrapper\n", "utf8"),
    writeFile(path.join(wrapperAssetsPath, "wrapper", "__init__.py"), "", "utf8"),
    writeFile(path.join(addonAssetsPath, "__init__.py"), "# derivative addon\n", "utf8")
  ]);
  const artifactFixture = manifests();
  const addonDerivative = "addon/strongcode_blender_mcp/__init__.py";
  const provenance: ArtifactProvenance = {
    ...artifactFixture.provenance,
    derivatives: [
      { path: addonDerivative, sha256: hash("# derivative addon\n"), licensePath: "LICENSE" },
      { path: "runtime-wrapper/strongcode-blender-wrapper.py", sha256: hash("# derivative wrapper\n"), licensePath: "LICENSE" },
      { path: "runtime-wrapper/wrapper/__init__.py", sha256: hash(""), licensePath: "LICENSE" }
    ]
  };
  const blender = new BlenderProcess();
  const python = new PythonProcess();
  const downloads: string[][] = [];
  const profile = {
    profileId: "blender-test-profile",
    executable: { canonicalPath: blenderPath, sha256: hash("blender executable") },
    version: "4.3.2",
    paths: {
      resources: { local: root, system: root, user: userResource },
      config: profileConfig,
      scripts: [path.join(userResource, "scripts")]
    },
    sources: ["association" as const]
  };
  const options: InstallBlenderIntegrationOptions = {
    homePath,
    profile,
    python: {
      executable: { canonicalPath: pythonPath, sha256: hash("python executable") },
      implementation: "cpython",
      version: { major: 3, minor: 11, patch: 9 },
      prefix: path.dirname(pythonPath),
      pointerWidth: 64,
      sysconfigPlatform: "win_amd64"
    },
    platform: "win32",
    architecture: "x64",
    lock: artifactFixture.lock,
    provenance,
    requirements: artifactFixture.requirements,
    wrapperAssetsPath,
    addonAssetsPath,
    downloader: {
      async download(artifacts, destination) {
        downloads.push(artifacts.map(artifact => artifact.filename));
        await mkdir(destination, { recursive: true });
        await Promise.all(artifacts.map(artifact => writeFile(
          path.join(destination, artifact.filename),
          artifactFixture.artifacts.get(artifact.filename) ?? "",
          "utf8"
        )));
      }
    },
    environmentProcess: python,
    blenderProcess: blender,
    env: { SystemRoot: process.env.SystemRoot, TEMP: root, TMP: root, OPENAI_API_KEY: "must-not-reach-blender" }
  };
  return { root, homePath, profileConfig, userResource, profile, options, blender, python, downloads };
}

function targets(value: Fixture) {
  return {
    addon: path.join(value.userResource, "scripts", "addons", MODULE),
    privateConfig: path.join(value.profileConfig, MODULE, "config.json"),
    preferences: path.join(value.profileConfig, "userpref.blend"),
    runtime: path.join(value.homePath, "mcps", "blender", "runtime"),
    receipt: path.join(value.homePath, "mcps", "blender", "installation.json"),
    mcp: path.join(value.homePath, "mcp.json"),
    permissions: path.join(value.homePath, "strongcode.config.yaml")
  };
}

type RawTreeEntry =
  | { readonly relativePath: string; readonly kind: "directory" }
  | { readonly relativePath: string; readonly kind: "file"; readonly content: Buffer };

async function rawTreeSnapshot(root: string): Promise<readonly RawTreeEntry[]> {
  const entries: RawTreeEntry[] = [];
  const visit = async (current: string, relativePath: string): Promise<void> => {
    const stats = await lstat(current);
    if (stats.isDirectory()) {
      entries.push({ relativePath, kind: "directory" });
      for (const name of (await readdir(current)).sort()) {
        await visit(path.join(current, name), relativePath ? `${relativePath}/${name}` : name);
      }
      return;
    }
    entries.push({ relativePath, kind: "file", content: await readFile(current) });
  };
  await visit(root, "");
  return entries;
}

function installLockPath(homePath: string, profileId: string): string {
  const lockName = createHash("sha256").update(profileId).digest("hex").slice(0, 24);
  return path.join(homePath, "locks", `blender-install-${lockName}.lock`);
}

async function installedFixture(): Promise<Fixture> {
  const value = await fixture();
  await installBlenderIntegration(value.options);
  value.downloads.length = 0;
  value.python.requests.length = 0;
  value.blender.requests.length = 0;
  return value;
}

async function installationJournalPath(value: Fixture): Promise<string> {
  const root = path.join(value.homePath, "transactions", "blender", BLENDER_INTEGRATION_LOCK_ID);
  const transactionId = (await readdir(root))[0];
  if (!transactionId) throw new Error("installed transaction journal is required");
  return path.join(root, transactionId, "journal.json");
}

describe("profile-scoped Blender integration installer", () => {
  it("rejects contradictory verification and repair intent before mutation", async () => {
    // Given
    const value = await fixture();

    // When / Then
    await expect(installBlenderIntegration({
      ...value.options,
      verifyOnly: true,
      repair: true
    })).rejects.toThrow(/verification-only.*repair/i);
    expect(value.downloads).toEqual([]);
    expect(value.python.requests).toEqual([]);
    expect(value.blender.requests).toEqual([]);
  });

  it("fails verification-only setup closed when the ownership receipt is absent", async () => {
    // Given
    const value = await fixture();
    const managed = targets(value);

    // When / Then
    await expect(installBlenderIntegration({
      ...value.options,
      verifyOnly: true
    })).rejects.toThrow(/--force|repair required/i);
    expect(value.downloads).toEqual([]);
    expect(value.python.requests).toEqual([]);
    expect(value.blender.requests).toEqual([]);
    await expect(lstat(managed.runtime)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(managed.mcp, "utf8")).toBe(mcpSource);
    expect(await readFile(managed.permissions, "utf8")).toBe(yamlSource);
  });

  it("rejects an invalid verification receipt before download or managed-target mutation", async () => {
    // Given
    const value = await fixture();
    const managed = targets(value);
    await mkdir(path.dirname(managed.receipt), { recursive: true });
    await writeFile(managed.receipt, "not valid JSON", "utf8");

    // When / Then
    await expect(installBlenderIntegration({
      ...value.options,
      verifyOnly: true
    })).rejects.toThrow(/--force/i);
    expect(value.downloads).toEqual([]);
    expect(value.python.requests).toEqual([]);
    expect(value.blender.requests).toEqual([]);
    await expect(lstat(managed.runtime)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(managed.mcp, "utf8")).toBe(mcpSource);
  });

  it.each([
    ["unsupported Blender", (value: Fixture) => ({ ...value.options, profile: { ...value.profile, version: "4.1.9" } })],
    ["unsupported Python", (value: Fixture) => ({ ...value.options, python: { ...value.options.python, version: { major: 3, minor: 12, patch: 1 } } })]
  ])("rejects %s before downloading or mutating managed targets", async (_label, change) => {
    // Given
    const value = await fixture();
    const managed = targets(value);

    // When / Then
    await expect(installBlenderIntegration(change(value))).rejects.toThrow(/4\.2|CPython 3\.11|win_amd64/i);
    expect(value.downloads).toEqual([]);
    await expect(lstat(managed.runtime)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(managed.mcp, "utf8")).toBe(mcpSource);
  });

  it("revalidates the selected Blender executable immediately before staging", async () => {
    // Given
    const value = await fixture();
    await writeFile(value.profile.executable.canonicalPath, "changed executable", "utf8");

    // When / Then
    await expect(installBlenderIntegration(value.options)).rejects.toThrow(/changed after selection/i);
    expect(value.downloads).toEqual([]);
  });

  it("rejects an unowned existing addon before staging", async () => {
    // Given
    const value = await fixture();
    const addon = targets(value).addon;
    await mkdir(addon);
    await writeFile(path.join(addon, "foreign.py"), "foreign", "utf8");

    // When / Then
    await expect(installBlenderIntegration({ ...value.options, repair: true })).rejects.toThrow(/unowned|conflict/i);
    expect(value.downloads).toEqual([]);
    expect(await readFile(path.join(addon, "foreign.py"), "utf8")).toBe("foreign");
  });

  it("rejects a tampered derivative wrapper before download or execution", async () => {
    // Given
    const value = await fixture();
    await writeFile(path.join(value.options.wrapperAssetsPath, "strongcode-blender-wrapper.py"), "# tampered\n", "utf8");

    // When / Then
    await expect(installBlenderIntegration(value.options)).rejects.toThrow(/wrapper hash mismatch/i);
    expect(value.downloads).toEqual([]);
    expect(value.python.requests).toEqual([]);
  });

  it("reverifies the copied wrapper before executing its staged self-test", async () => {
    // Given
    const value = await fixture();
    const downloader = value.options.downloader;
    if (!downloader) throw new Error("fixture downloader is required");

    // When / Then
    await expect(installBlenderIntegration({
      ...value.options,
      downloader: {
        async download(artifacts, destination) {
          await downloader.download(artifacts, destination);
          await writeFile(path.join(value.options.wrapperAssetsPath, "strongcode-blender-wrapper.py"), "# swapped\n", "utf8");
        }
      }
    })).rejects.toThrow(/wrapper hash mismatch/i);
    expect(value.python.requests).toEqual([]);
  });

  it("reverifies the staged wrapper immediately after environment setup and before self-test", async () => {
    // Given
    const value = await fixture();
    value.python.afterDistributionProbe = request => writeFile(
      path.join(request.cwd, "wrapper", "strongcode-blender-wrapper.py"),
      "# swapped after setup\n",
      "utf8"
    );

    // When / Then
    await expect(installBlenderIntegration(value.options)).rejects.toThrow(/wrapper hash mismatch/i);
    expect(value.python.requests.some(request => request.args.includes("--self-test"))).toBe(false);
  });

  it("installs verified artifacts, background-safe preferences, configs, and ownership in phase order", async () => {
    // Given
    const value = await fixture();
    const phases: string[] = [];
    const managed = targets(value);

    // When
    const result = await installBlenderIntegration({
      ...value.options,
      phaseHook: phase => { phases.push(phase); }
    });

    // Then
    expect(result).toMatchObject({ status: "installed", profileId: value.profile.profileId });
    expect(phases).toEqual(ACTIVATION_PHASES);
    expect(value.downloads[0]).toEqual(["example-1.0.0-py3-none-any.whl", "addon.py"]);
    expect(await readFile(path.join(managed.addon, "__init__.py"), "utf8")).toBe("# derivative addon\n");
    expect(await readFile(managed.preferences, "utf8")).toBe("managed preferences\n");
    expect((await lstat(managed.runtime)).isDirectory()).toBe(true);
    const privateConfig = JSON.parse(await readFile(managed.privateConfig, "utf8"));
    expect(Buffer.from(privateConfig.secret, "base64url")).toHaveLength(32);
    const receipt = JSON.parse(await readFile(managed.receipt, "utf8"));
    expect(receipt).toMatchObject({ schemaVersion: 2, profileId: value.profile.profileId, telemetry: "off" });
    expect(receipt.immutableTargets.map((target: { readonly path: string }) => target.path).sort()).toEqual([
      managed.addon,
      managed.privateConfig,
      managed.runtime
    ].sort());
    const publicState = [managed.mcp, managed.permissions, managed.receipt];
    for (const filePath of publicState) expect(await readFile(filePath, "utf8")).not.toContain(privateConfig.secret);
    const transactionRoot = path.join(value.homePath, "transactions", "blender", BLENDER_INTEGRATION_LOCK_ID);
    for (const transaction of await readdir(transactionRoot)) {
      expect(await readFile(path.join(transactionRoot, transaction, "journal.json"), "utf8")).not.toContain(privateConfig.secret);
    }
    expect(value.blender.requests).toHaveLength(2);
    expect(value.blender.requests.every(request => request.shell === false && request.args[0] === "--background")).toBe(true);
    expect(value.blender.requests.flatMap(request => request.args)).not.toContain(privateConfig.secret);
    expect(value.blender.requests.every(request => request.env.OPENAI_API_KEY === undefined)).toBe(true);
    expect(value.python.requests.every(request => request.env.DO_NOT_TRACK === "1")).toBe(true);
  });

  it("activates runtime before public config targets and keeps the receipt last", async () => {
    // Given
    const value = await fixture();
    const managed = targets(value);
    const observations: Array<{
      readonly phase: string;
      readonly runtimeActive: boolean;
      readonly permissionsActive: boolean;
      readonly mcpActive: boolean;
      readonly receiptActive: boolean;
    }> = [];

    // When
    await installBlenderIntegration({
      ...value.options,
      phaseHook: async phase => {
        observations.push({
          phase,
          runtimeActive: (await nodeBlenderInstallerFileSystem.state(managed.runtime)).kind === "directory",
          permissionsActive: (await readFile(managed.permissions, "utf8")) !== yamlSource,
          mcpActive: (await readFile(managed.mcp, "utf8")) !== mcpSource,
          receiptActive: (await nodeBlenderInstallerFileSystem.state(managed.receipt)).kind === "file"
        });
      }
    });
    const transactionRoot = path.join(value.homePath, "transactions", "blender", BLENDER_INTEGRATION_LOCK_ID);
    const transactionIds = await readdir(transactionRoot);
    const transactionId = transactionIds[0];
    if (!transactionId) throw new Error("installer transaction journal is required");
    const journal = JSON.parse(await readFile(path.join(transactionRoot, transactionId, "journal.json"), "utf8"));
    const rollbackOrder = journal.targets
      .map((target: { readonly canonicalPath: string }) => target.canonicalPath)
      .filter((targetPath: string) => [managed.runtime, managed.permissions, managed.mcp, managed.receipt].includes(targetPath));

    // Then
    expect(observations).toEqual([
      { phase: "credential_active", runtimeActive: true, permissionsActive: false, mcpActive: false, receiptActive: false },
      { phase: "addon_active", runtimeActive: true, permissionsActive: false, mcpActive: false, receiptActive: false },
      { phase: "preferences_active", runtimeActive: true, permissionsActive: false, mcpActive: false, receiptActive: false },
      { phase: "permissions_active", runtimeActive: true, permissionsActive: true, mcpActive: false, receiptActive: false },
      { phase: "mcp_active", runtimeActive: true, permissionsActive: true, mcpActive: true, receiptActive: false },
      { phase: "state_active", runtimeActive: true, permissionsActive: true, mcpActive: true, receiptActive: true }
    ]);
    expect(rollbackOrder).toEqual([managed.runtime, managed.permissions, managed.mcp, managed.receipt]);
  });

  it("rejects preference generation when the bounded background probe observes a listener", async () => {
    // Given
    const value = await fixture();
    value.blender.rendezvousExists = true;

    // When / Then
    await expect(installBlenderIntegration(value.options)).rejects.toThrow(/rendezvous|listener|background/i);
    await expect(lstat(targets(value).runtime)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(targets(value).preferences, "utf8")).toBe("user preferences\n");
  });

  it("preserves a concurrent global config edit made after merge planning", async () => {
    // Given
    const value = await fixture();
    const managed = targets(value);
    value.blender.afterEnable = () => writeFile(managed.mcp, `${mcpSource.trim()}\n `, "utf8");

    // When / Then
    await expect(installBlenderIntegration(value.options)).rejects.toThrow(/changed after selection/i);
    expect(await readFile(managed.mcp, "utf8")).toBe(`${mcpSource.trim()}\n `);
    await expect(lstat(managed.runtime)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves an absent managed target created concurrently during staging", async () => {
    // Given
    const value = await fixture();
    const managed = targets(value);
    value.python.afterDistributionProbe = async () => {
      await mkdir(managed.runtime, { recursive: true });
      await writeFile(path.join(managed.runtime, "foreign.txt"), "concurrent target\n", "utf8");
    };

    // When / Then
    await expect(installBlenderIntegration(value.options)).rejects.toThrow(/changed after planning/i);
    expect(await readFile(path.join(managed.runtime, "foreign.txt"), "utf8")).toBe("concurrent target\n");
  });

  it.each([
    ["edited", false],
    ["created", true]
  ] as const)("preserves preferences %s concurrently during staging", async (_scenario, initiallyAbsent) => {
    // Given
    const value = await fixture();
    const managed = targets(value);
    if (initiallyAbsent) await rm(managed.preferences);
    value.python.afterDistributionProbe = () => writeFile(managed.preferences, "concurrent preferences\n", "utf8");

    // When / Then
    await expect(installBlenderIntegration(value.options)).rejects.toThrow(/changed after planning/i);
    expect(await readFile(managed.preferences, "utf8")).toBe("concurrent preferences\n");
    await expect(lstat(managed.runtime)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a target changed after activation and refuses the final commit", async () => {
    // Given
    const value = await fixture();
    const managed = targets(value);

    // When / Then
    await expect(installBlenderIntegration({
      ...value.options,
      phaseHook: phase => phase === "state_active"
        ? writeFile(managed.mcp, "concurrent post-activation edit\n", "utf8")
        : undefined
    })).rejects.toThrow(/rollback encountered live-state conflicts|conflict/i);
    expect(await readFile(managed.mcp, "utf8")).toBe("concurrent post-activation edit\n");
    expect(await readFile(managed.preferences, "utf8")).toBe("user preferences\n");
    for (const filePath of [managed.addon, managed.privateConfig, managed.runtime, managed.receipt]) {
      await expect(lstat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("returns already-installed only after hashes, config ownership, and enabled-state verification match", async () => {
    // Given
    const value = await fixture();
    await installBlenderIntegration(value.options);
    const downloadCount = value.downloads.length;

    // When
    const result = await installBlenderIntegration({ ...value.options, verifyOnly: true });

    // Then
    expect(result.status).toBe("already-installed");
    expect(value.downloads).toHaveLength(downloadCount);
    expect(value.blender.requests).toHaveLength(3);

    value.blender.addonEnabled = false;
    await expect(installBlenderIntegration(value.options)).rejects.toThrow(/--force|repair required/i);
  });

  it.each([
    ["live", JSON.stringify({ token: "00000000-0000-4000-8000-000000000010", profileId: BLENDER_INTEGRATION_LOCK_ID,
      pid: process.pid, createdAt: new Date().toISOString() })],
    ["stale", JSON.stringify({ token: "00000000-0000-4000-8000-000000000011", profileId: BLENDER_INTEGRATION_LOCK_ID,
      pid: process.pid, createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() })],
    ["malformed", "not-json"],
    ["future-dated", JSON.stringify({ token: "00000000-0000-4000-8000-000000000012", profileId: BLENDER_INTEGRATION_LOCK_ID,
      pid: process.pid, createdAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString() })]
  ])("blocks verification on a %s global lock without changing any byte", async (_label, source) => {
    // Given
    const value = await installedFixture();
    const lockPath = installLockPath(value.homePath, BLENDER_INTEGRATION_LOCK_ID);
    await writeFile(lockPath, `${source}\n`, "utf8");
    const before = await rawTreeSnapshot(value.root);

    // When / Then
    await expect(installBlenderIntegration({ ...value.options, verifyOnly: true }))
      .rejects.toThrow(/wait|recovery|--force/i);
    expect(await rawTreeSnapshot(value.root)).toEqual(before);
    expect(value.downloads).toEqual([]);
    expect(value.python.requests).toEqual([]);
    expect(value.blender.requests).toEqual([]);
  });

  it("inspects the selected legacy profile lock as well as the deduplicated global lock", async () => {
    // Given
    const value = await installedFixture();
    const lockPath = installLockPath(value.homePath, value.profile.profileId);
    const source = "legacy-profile-lock-bytes\n";
    await writeFile(lockPath, source, "utf8");

    // When / Then
    await expect(installBlenderIntegration({ ...value.options, verifyOnly: true }))
      .rejects.toThrow(/wait|recovery|--force/i);
    expect(await readFile(lockPath, "utf8")).toBe(source);
    expect(value.blender.requests).toEqual([]);
  });

  it.each(["active", "recovery_conflict"] as const)("blocks a %s journal without recovery or mutation", async status => {
    // Given
    const value = await installedFixture();
    const journalPath = await installationJournalPath(value);
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    await writeFile(journalPath, `${JSON.stringify({ ...journal, status }, null, 2)}\n`, "utf8");
    const before = await rawTreeSnapshot(value.root);

    // When / Then
    await expect(installBlenderIntegration({ ...value.options, verifyOnly: true }))
      .rejects.toThrow(/wait|recovery|--force/i);
    expect(await rawTreeSnapshot(value.root)).toEqual(before);
    expect(value.blender.requests).toEqual([]);
  });

  it("blocks an invalid journal without changing its raw bytes", async () => {
    // Given
    const value = await installedFixture();
    const journalPath = await installationJournalPath(value);
    await writeFile(journalPath, "invalid journal bytes\n", "utf8");
    const before = await rawTreeSnapshot(value.root);

    // When / Then
    await expect(installBlenderIntegration({ ...value.options, verifyOnly: true }))
      .rejects.toThrow(/wait|recovery|--force/i);
    expect(await rawTreeSnapshot(value.root)).toEqual(before);
    expect(value.blender.requests).toEqual([]);
  });

  it("blocks a semantically invalid terminal journal without changing its raw bytes", async () => {
    // Given
    const value = await installedFixture();
    const journalPath = await installationJournalPath(value);
    const journal = await readBlenderInstallJournal(journalPath);
    await writeFile(journalPath, `${JSON.stringify({ ...journal, phase: "created" }, null, 2)}\n`, "utf8");
    const before = await rawTreeSnapshot(value.root);

    // When / Then
    await expect(installBlenderIntegration({ ...value.options, verifyOnly: true }))
      .rejects.toThrow(/wait|recovery|--force/i);
    expect(await rawTreeSnapshot(value.root)).toEqual(before);
    expect(value.blender.requests).toEqual([]);
  });

  it("blocks an active selected-profile legacy journal without recovery", async () => {
    // Given
    const value = await installedFixture();
    const sourceJournal = JSON.parse(await readFile(await installationJournalPath(value), "utf8"));
    const transactionRoot = path.join(value.homePath, "transactions", "blender", value.profile.profileId,
      sourceJournal.transactionId);
    const journalPath = path.join(transactionRoot, "journal.json");
    await mkdir(transactionRoot, { recursive: true });
    await writeFile(journalPath, `${JSON.stringify({ ...sourceJournal, profileId: value.profile.profileId,
      phase: "created", status: "active", targets: [] }, null, 2)}\n`, "utf8");
    const before = await rawTreeSnapshot(value.root);

    // When / Then
    await expect(installBlenderIntegration({ ...value.options, verifyOnly: true }))
      .rejects.toThrow(/wait|recovery|--force/i);
    expect(await rawTreeSnapshot(value.root)).toEqual(before);
    expect(value.blender.requests).toEqual([]);
  });

  it("allows healthy verification with production committed and rolled-back journals", async () => {
    // Given
    const value = await installedFixture();
    const rolledBack = await createBlenderInstallJournal({
      homePath: value.homePath,
      profileId: BLENDER_INTEGRATION_LOCK_ID,
      targets: []
    });
    const receipt = await rollbackBlenderInstall(rolledBack.journalPath);
    const before = await rawTreeSnapshot(value.root);

    // When
    const result = await installBlenderIntegration({ ...value.options, verifyOnly: true });

    // Then
    expect(receipt.status).toBe("rolled_back");
    expect(result.status).toBe("already-installed");
    expect(await rawTreeSnapshot(value.root)).toEqual(before);
    expect(value.blender.requests).toHaveLength(1);
  });

  it.each(["lock", "journal"] as const)("invalidates verification when a %s appears during the live probe", async drift => {
    // Given
    const value = await installedFixture();
    const journalPath = await installationJournalPath(value);
    value.blender.afterProbe = async () => {
      if (drift === "lock") {
        await writeFile(installLockPath(value.homePath, BLENDER_INTEGRATION_LOCK_ID), "probe-time-lock\n", "utf8");
        return;
      }
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      await writeFile(journalPath, `${JSON.stringify({ ...journal, status: "active" }, null, 2)}\n`, "utf8");
    };

    // When / Then
    await expect(installBlenderIntegration({ ...value.options, verifyOnly: true }))
      .rejects.toThrow(/wait|recovery|--force|changed during verification/i);
    expect(value.blender.requests).toHaveLength(1);
  });

  it("invalidates verification when receipt-owned bytes drift during the live probe", async () => {
    // Given
    const value = await installedFixture();
    const addonFile = path.join(targets(value).addon, "__init__.py");
    value.blender.afterProbe = () => writeFile(addonFile, "probe-time drift\n", "utf8");

    // When / Then
    await expect(installBlenderIntegration({ ...value.options, verifyOnly: true }))
      .rejects.toThrow(/--force|changed during verification/i);
    expect(value.blender.requests).toHaveLength(1);
  });

  it("keeps the complete install and profile tree byte-for-byte unchanged during healthy verification", async () => {
    // Given
    const value = await installedFixture();
    const before = await rawTreeSnapshot(value.root);
    const phases: string[] = [];

    // When
    const result = await installBlenderIntegration({ ...value.options, verifyOnly: true,
      phaseHook: phase => { phases.push(phase); } });

    // Then
    expect(result.status).toBe("already-installed");
    expect(await rawTreeSnapshot(value.root)).toEqual(before);
    expect(value.downloads).toEqual([]);
    expect(value.python.requests).toEqual([]);
    expect(value.blender.requests).toHaveLength(1);
    expect(phases).toEqual([]);
  });

  it("stays healthy after unrelated public config and preference edits", async () => {
    // Given
    const value = await fixture();
    const managed = targets(value);
    await installBlenderIntegration(value.options);
    const mcp = JSON.parse(await readFile(managed.mcp, "utf8"));
    mcp.templates.user_template = { preserved: true };
    mcp.mcpServers.blender = Object.fromEntries(Object.entries(mcp.mcpServers.blender).reverse());
    await writeFile(managed.mcp, `${JSON.stringify(mcp, null, 2)}\n`, "utf8");
    await writeFile(managed.permissions, `${await readFile(managed.permissions, "utf8")}# unrelated user comment\n`, "utf8");
    await writeFile(managed.preferences, "user-adjusted preferences\n", "utf8");
    const downloadCount = value.downloads.length;

    // When
    const result = await installBlenderIntegration(value.options);

    // Then
    expect(result.status).toBe("already-installed");
    expect(value.downloads).toHaveLength(downloadCount);
    expect(await readFile(managed.preferences, "utf8")).toBe("user-adjusted preferences\n");
  });

  it("requires explicit repair for a disabled addon and preserves unrelated preferences during repair", async () => {
    // Given
    const value = await fixture();
    const managed = targets(value);
    await installBlenderIntegration(value.options);
    await writeFile(managed.preferences, "user-adjusted preferences\n", "utf8");
    value.blender.addonEnabled = false;
    value.blender.preserveExistingPreferences = true;

    // When / Then
    await expect(installBlenderIntegration(value.options)).rejects.toThrow(/--force|repair required/i);
    const repaired = await installBlenderIntegration({ ...value.options, repair: true });
    expect(repaired.status).toBe("installed");
    expect(await readFile(managed.preferences, "utf8")).toBe("user-adjusted preferences\n");
    expect(value.blender.addonEnabled).toBe(true);
  }, 90_000);

  it("requires explicit repair for a tampered runtime and replaces it when forced", async () => {
    // Given
    const value = await fixture();
    const managed = targets(value);
    await installBlenderIntegration(value.options);
    const tamperedPath = path.join(managed.runtime, "tampered.txt");
    await writeFile(tamperedPath, "tampered runtime\n", "utf8");

    // When / Then
    await expect(installBlenderIntegration(value.options)).rejects.toThrow(/--force|repair required/i);
    await expect(installBlenderIntegration({ ...value.options, repair: true })).resolves.toMatchObject({ status: "installed" });
    await expect(lstat(tamperedPath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 90_000);

  it("repairs an owned MCP fragment while preserving unrelated JSON content", async () => {
    // Given
    const value = await fixture();
    const managed = targets(value);
    await installBlenderIntegration(value.options);
    const mcp = JSON.parse(await readFile(managed.mcp, "utf8"));
    mcp.mcpServers.blender.enabled = false;
    mcp.templates.user_template = { preserved: true };
    await writeFile(managed.mcp, `${JSON.stringify(mcp, null, 2)}\n`, "utf8");

    // When / Then
    await expect(installBlenderIntegration(value.options)).rejects.toThrow(/--force|repair required/i);
    await installBlenderIntegration({ ...value.options, repair: true });
    const repaired = JSON.parse(await readFile(managed.mcp, "utf8"));
    expect(repaired.mcpServers.blender.enabled).toBe(true);
    expect(repaired.templates.user_template).toEqual({ preserved: true });
  }, 60_000);

  it("does not adopt an unowned MCP key during forced repair", async () => {
    // Given
    const value = await fixture();
    const managed = targets(value);
    await installBlenderIntegration(value.options);
    const mcp = JSON.parse(await readFile(managed.mcp, "utf8"));
    mcp.mcpServers.blender.description = "user-owned";
    await writeFile(managed.mcp, `${JSON.stringify(mcp, null, 2)}\n`, "utf8");

    // When / Then
    await expect(installBlenderIntegration({ ...value.options, repair: true })).rejects.toThrow(/unowned|conflict/i);
    expect(JSON.parse(await readFile(managed.mcp, "utf8")).mcpServers.blender.description).toBe("user-owned");
  });

  it("treats a v1 receipt as ownership evidence and migrates it only with explicit repair", async () => {
    // Given
    const value = await fixture();
    const managed = targets(value);
    await installBlenderIntegration(value.options);
    const current = JSON.parse(await readFile(managed.receipt, "utf8"));
    const targetPaths = [managed.privateConfig, managed.addon, managed.preferences, managed.permissions, managed.mcp, managed.runtime];
    const legacyTargets = await Promise.all(targetPaths.map(async targetPath => ({
      path: targetPath,
      state: await nodeBlenderInstallerFileSystem.state(targetPath)
    })));
    await writeFile(managed.receipt, `${JSON.stringify({
      schemaVersion: 1,
      profileId: current.profileId,
      blender: current.blender,
      artifacts: current.artifacts,
      addonModule: current.addonModule,
      telemetry: current.telemetry,
      installedAt: current.installedAt,
      targets: legacyTargets
    }, null, 2)}\n`, "utf8");

    // When / Then
    await expect(installBlenderIntegration(value.options)).rejects.toThrow(/--force|repair required/i);
    await installBlenderIntegration({ ...value.options, repair: true });
    expect(JSON.parse(await readFile(managed.receipt, "utf8"))).toMatchObject({ schemaVersion: 2 });
  });

  it("rejects receipt-owned paths outside the exact managed set even with repair", async () => {
    // Given
    const value = await fixture();
    const managed = targets(value);
    await installBlenderIntegration(value.options);
    const receipt = JSON.parse(await readFile(managed.receipt, "utf8"));
    receipt.immutableTargets[0].path = path.join(value.root, "outside-owned-path");
    await writeFile(managed.receipt, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

    // When / Then
    await expect(installBlenderIntegration({ ...value.options, repair: true })).rejects.toThrow(/ownership|target paths|expected paths/i);
  });

  it.each([
    ["wheel lock", (value: Fixture) => ({
      ...value.options,
      lock: { ...value.options.lock, roots: [...value.options.lock.roots, "other==1.0.0"] }
    })],
    ["requirements", (value: Fixture) => ({ ...value.options, requirements: `${value.options.requirements}other==1.0.0 --hash=sha256:${"d".repeat(64)}\n` })]
  ])("does not return already-installed for a changed full %s", async (_label, change) => {
    // Given
    const value = await fixture();
    await installBlenderIntegration(value.options);

    // When / Then
    await expect(installBlenderIntegration(change(value))).rejects.toThrow(/--force|repair required/i);
    expect(value.downloads).toHaveLength(1);
  });

  it("rejects an ownership receipt that omits a required managed target", async () => {
    // Given
    const value = await fixture();
    await installBlenderIntegration(value.options);
    const managed = targets(value);
    const receipt = JSON.parse(await readFile(managed.receipt, "utf8"));
    receipt.immutableTargets = receipt.immutableTargets.filter((target: { path: string }) => target.path !== managed.runtime);
    await writeFile(managed.receipt, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

    // When / Then
    await expect(installBlenderIntegration(value.options)).rejects.toThrow(/receipt.*invalid|target paths/i);
  });

  it("rejects a different selected profile when a managed profile already owns the integration", async () => {
    // Given
    const value = await fixture();
    await installBlenderIntegration(value.options);
    const otherProfile = { ...value.profile, profileId: "blender-other-profile" };

    // When / Then
    await expect(installBlenderIntegration({ ...value.options, profile: otherProfile, repair: true }))
      .rejects.toThrow(/different managed profile|owned/i);
  });

  it.each(["same", "different"])("serializes %s-profile installers with one home-global lock", async profileKind => {
    // Given
    const value = await fixture();
    let continueFirst: (() => void) | undefined;
    let firstActivated: (() => void) | undefined;
    const activated = new Promise<void>(resolve => { firstActivated = resolve; });
    const hold = new Promise<void>(resolve => { continueFirst = resolve; });
    const first = installBlenderIntegration({
      ...value.options,
      phaseHook: async phase => {
        if (phase !== "credential_active") return;
        firstActivated?.();
        await hold;
      }
    });
    await activated;
    const profile = profileKind === "same"
      ? value.profile
      : { ...value.profile, profileId: "blender-concurrent-profile" };

    // When / Then
    await expect(installBlenderIntegration({ ...value.options, profile })).rejects.toThrow(/already running|lock/i);
    continueFirst?.();
    await expect(first).resolves.toMatchObject({ status: "installed" });
  });

  it.each(ACTIVATION_PHASES)("rolls back every target when %s fails", async failedPhase => {
    // Given
    const value = await fixture();
    const managed = targets(value);

    // When
    await expect(installBlenderIntegration({
      ...value.options,
      phaseHook: phase => {
        if (phase === failedPhase) throw new Error(`fail ${failedPhase}`);
      }
    })).rejects.toThrow(`fail ${failedPhase}`);

    // Then
    expect(await readFile(managed.mcp, "utf8")).toBe(mcpSource);
    expect(await readFile(managed.permissions, "utf8")).toBe(yamlSource);
    expect(await readFile(managed.preferences, "utf8")).toBe("user preferences\n");
    for (const filePath of [managed.addon, managed.privateConfig, managed.runtime, managed.receipt]) {
      await expect(lstat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});
