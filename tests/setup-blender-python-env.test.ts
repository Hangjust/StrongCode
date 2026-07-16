import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  downloadVerifiedArtifacts,
  type ArtifactHttpClient,
  type LockedArtifact
} from "../src/setup/blender/artifacts";
import type { ArtifactProvenance, WheelLock } from "../src/setup/blender/artifact-manifest";
import {
  BLENDER_WRAPPER_TOOLS,
  DISTRIBUTIONS_SENTINEL,
  TOOLS_SENTINEL,
  stageBlenderPythonEnvironment,
  type EnvironmentProcessAdapter,
  type EnvironmentProcessRequest
} from "../src/setup/blender/python-env";

const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex");
const pypiUrl = (filename: string): string =>
  `https://files.pythonhosted.org/packages/aa/bb/${"c".repeat(60)}/${filename}`;

function artifact(filename: string, content: string, url = pypiUrl(filename)): LockedArtifact {
  return { filename, url, size: Buffer.byteLength(content), sha256: sha256(content) };
}

function fixtureManifests(): {
  readonly lock: WheelLock;
  readonly provenance: ArtifactProvenance;
  readonly contents: ReadonlyMap<string, string>;
} {
  const wheelContent = "wheel fixture";
  const addonContent = "addon fixture";
  const filename = "example-1.0.0-py3-none-any.whl";
  const wheel = {
    name: "example",
    version: "1.0.0",
    filename,
    url: pypiUrl(filename),
    size: Buffer.byteLength(wheelContent),
    sha256: sha256(wheelContent),
    requiresPython: ">=3.11",
    license: "MIT"
  };
  const commit = "a".repeat(40);
  const addon = {
    kind: "addon" as const,
    filename: "addon.py" as const,
    commit,
    url: `https://raw.githubusercontent.com/owner/repo/${commit}/addon.py`,
    size: Buffer.byteLength(addonContent),
    sha256: sha256(addonContent)
  };
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
      artifacts: [{ kind: "wheel", ...wheel, metadataUrl: "https://pypi.org/pypi/example/1.0.0/json" }, addon],
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
    contents: new Map([[filename, wheelContent], ["addon.py", addonContent]])
  };
}

class FixtureProcess implements EnvironmentProcessAdapter {
  readonly requests: EnvironmentProcessRequest[] = [];
  constructor(private readonly tools: readonly string[]) {}

  async run(request: EnvironmentProcessRequest) {
    this.requests.push(request);
    if (request.args.includes("venv")) {
      const venvPath = request.args.at(-1);
      if (venvPath) await mkdir(path.join(venvPath, "Scripts"), { recursive: true });
      return { kind: "completed" as const, exitCode: 0, stdout: "", stderr: "" };
    }
    if (request.args.some(argument => argument.includes("importlib.metadata"))) {
      return { kind: "completed" as const, exitCode: 0, stdout: `${DISTRIBUTIONS_SENTINEL}["example==1.0.0"]\n`, stderr: "" };
    }
    if (request.args.includes("--self-test")) {
      return { kind: "completed" as const, exitCode: 0, stdout: `${TOOLS_SENTINEL}${JSON.stringify(this.tools)}\n`, stderr: "" };
    }
    return { kind: "completed" as const, exitCode: 0, stdout: "", stderr: "" };
  }
}

describe("verified Blender artifacts", () => {
  it("streams no more than two downloads concurrently and atomically publishes exact bytes", async () => {
    // Given
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-artifacts-"));
    const contents = new Map([
      ["one.whl", "one"],
      ["two.whl", "two"],
      ["addon.py", "three"]
    ]);
    const artifacts = [...contents].map(([filename, content]) => artifact(filename, content));
    let active = 0;
    let maximum = 0;
    let releaseFirstPair: (() => void) | undefined;
    const firstPair = new Promise<void>(resolve => { releaseFirstPair = resolve; });
    const http: ArtifactHttpClient = {
      async open(url) {
        const filename = path.basename(new URL(url).pathname);
        const content = contents.get(filename) ?? "";
        active += 1;
        maximum = Math.max(maximum, active);
        if (active === 2) releaseFirstPair?.();
        if (maximum < 2) await firstPair;
        return {
          statusCode: 200,
          headers: { "content-length": String(Buffer.byteLength(content)) },
          body: (async function* () {
            try {
              await new Promise<void>(resolve => setImmediate(resolve));
              yield Buffer.from(content);
            } finally {
              active -= 1;
            }
          })(),
          cancel() {}
        };
      }
    };

    // When
    await downloadVerifiedArtifacts({ artifacts, destination: root, http });

    // Then
    expect(maximum).toBe(2);
    for (const [filename, content] of contents) expect(await readFile(path.join(root, filename), "utf8")).toBe(content);
    expect((await readdir(root)).some(filename => filename.endsWith(".part"))).toBe(false);
  });

  it.each([
    ["redirect", 302, "https://files.pythonhosted.org/other", "payload", /redirect/i, undefined],
    ["wrong digest", 200, undefined, "tampered", /sha-?256|digest/i, undefined],
    ["non-HTTPS URL", 200, undefined, "expected", /allowlisted/i, "http://files.pythonhosted.org/example.whl"],
    ["unknown host", 200, undefined, "expected", /allowlisted/i, "https://example.com/example.whl"]
  ])("rejects %s without leaving a published or partial artifact", async (_label, statusCode, location, body, expected, url) => {
    // Given
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-artifact-reject-"));
    const expectedArtifact = artifact("example.whl", "expected", url);
    const http: ArtifactHttpClient = {
      async open() {
        return {
          statusCode,
          headers: { location, "content-length": String(Buffer.byteLength(body)) },
          body: (async function* () { yield Buffer.from(body); })(),
          cancel() {}
        };
      }
    };

    // When / Then
    await expect(downloadVerifiedArtifacts({ artifacts: [expectedArtifact], destination: root, http })).rejects.toThrow(expected);
    expect(await readdir(root)).toEqual([]);
  });
});

describe("offline Blender Python environment", () => {
  it("installs the exact lock offline, verifies it, self-tests four tools, and publishes atomically", async () => {
    // Given
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-python-env-"));
    const wrapperAssetsPath = path.join(root, "wrapper-fixture");
    const destination = path.join(root, "runtime");
    const selectedPython = path.join(root, "Python311", "python.exe");
    const fixture = fixtureManifests();
    const processAdapter = new FixtureProcess(BLENDER_WRAPPER_TOOLS);
    await mkdir(wrapperAssetsPath);
    await mkdir(path.dirname(selectedPython));
    await writeFile(selectedPython, "python fixture", "utf8");
    await writeFile(path.join(wrapperAssetsPath, "strongcode-blender-wrapper.py"), "# fixture\n", "utf8");

    // When
    const result = await stageBlenderPythonEnvironment({
      python: {
        executable: { canonicalPath: selectedPython, sha256: sha256("python fixture") },
        implementation: "cpython",
        version: { major: 3, minor: 11, patch: 9 },
        prefix: path.dirname(selectedPython),
        pointerWidth: 64,
        sysconfigPlatform: "win_amd64"
      },
      platform: "win32",
      architecture: "x64",
      lock: fixture.lock,
      provenance: fixture.provenance,
      requirements: `example==1.0.0 --hash=sha256:${fixture.lock.wheels[0]?.sha256}\n`,
      wrapperAssetsPath,
      destination,
      downloader: {
        async download(artifacts, directory) {
          await mkdir(directory, { recursive: true });
          await Promise.all(artifacts.map(item => writeFile(path.join(directory, item.filename), fixture.contents.get(item.filename) ?? "")));
        }
      },
      process: processAdapter
    });

    // Then
    expect(result.pythonPath).toBe(path.join(destination, "venv", "Scripts", "python.exe"));
    expect((await stat(destination)).isDirectory()).toBe(true);
    expect(await readFile(path.join(destination, "wrapper", "strongcode-blender-wrapper.py"), "utf8")).toBe("# fixture\n");
    const pip = processAdapter.requests.find(request => request.args.includes("pip"));
    expect(pip?.args).toEqual(expect.arrayContaining([
      "--isolated", "--no-index", "--only-binary=:all:", "--require-hashes", "--no-deps", "--find-links"
    ]));
    expect(pip?.env.PIP_NO_INDEX).toBe("1");
  });

  it("rejects the wrong Python target and never publishes a failed self-test", async () => {
    // Given
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-python-env-fail-"));
    const wrapperAssetsPath = path.join(root, "wrapper-fixture");
    const selectedPython = path.join(root, "Python311", "python.exe");
    const fixture = fixtureManifests();
    await mkdir(wrapperAssetsPath);
    await mkdir(path.dirname(selectedPython));
    await writeFile(selectedPython, "python fixture", "utf8");
    await writeFile(path.join(wrapperAssetsPath, "strongcode-blender-wrapper.py"), "# fixture\n", "utf8");
    const base = {
      executable: { canonicalPath: selectedPython, sha256: sha256("python fixture") },
      implementation: "cpython" as const,
      version: { major: 3, minor: 11, patch: 9 },
      prefix: path.dirname(selectedPython),
      pointerWidth: 64 as const,
      sysconfigPlatform: "win_amd64"
    };

    // When / Then
    await expect(stageBlenderPythonEnvironment({
      python: { ...base, version: { major: 3, minor: 12, patch: 1 } },
      platform: "win32", architecture: "x64", lock: fixture.lock, provenance: fixture.provenance,
      requirements: `example==1.0.0 --hash=sha256:${fixture.lock.wheels[0]?.sha256}\n`, wrapperAssetsPath,
      destination: path.join(root, "wrong-target"), process: new FixtureProcess(BLENDER_WRAPPER_TOOLS)
    })).rejects.toThrow(/CPython 3\.11.*win_amd64/i);

    await expect(stageBlenderPythonEnvironment({
      python: { ...base, pointerWidth: 32, sysconfigPlatform: "win32" },
      platform: "win32", architecture: "x64", lock: fixture.lock, provenance: fixture.provenance,
      requirements: `example==1.0.0 --hash=sha256:${fixture.lock.wheels[0]?.sha256}\n`, wrapperAssetsPath,
      destination: path.join(root, "wrong-bitness"), process: new FixtureProcess(BLENDER_WRAPPER_TOOLS),
      downloader: { async download() { throw new Error("32-bit guard missing"); } }
    })).rejects.toThrow(/CPython 3\.11.*win_amd64/i);

    await writeFile(selectedPython, "replaced", "utf8");
    await expect(stageBlenderPythonEnvironment({
      python: base, platform: "win32", architecture: "x64", lock: fixture.lock, provenance: fixture.provenance,
      requirements: `example==1.0.0 --hash=sha256:${fixture.lock.wheels[0]?.sha256}\n`, wrapperAssetsPath,
      destination: path.join(root, "replaced-python"), process: new FixtureProcess(BLENDER_WRAPPER_TOOLS)
    })).rejects.toThrow(/changed after selection/i);
    await writeFile(selectedPython, "python fixture", "utf8");

    const destination = path.join(root, "failed-runtime");
    await expect(stageBlenderPythonEnvironment({
      python: base, platform: "win32", architecture: "x64", lock: fixture.lock, provenance: fixture.provenance,
      requirements: `example==1.0.0 --hash=sha256:${fixture.lock.wheels[0]?.sha256}\n`, wrapperAssetsPath, destination,
      downloader: { async download(artifacts, directory) {
        await mkdir(directory, { recursive: true });
        await Promise.all(artifacts.map(item => writeFile(path.join(directory, item.filename), fixture.contents.get(item.filename) ?? "")));
      } },
      process: new FixtureProcess(BLENDER_WRAPPER_TOOLS.slice(0, 3))
    })).rejects.toThrow(/exactly four|tool/i);
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
