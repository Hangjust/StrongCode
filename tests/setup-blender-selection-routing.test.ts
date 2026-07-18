import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setupBlenderIntegration } from "../src/setup/blender/setup";
import type { InstallBlenderIntegrationOptions } from "../src/setup/blender/install";
import type { BlenderProfileCandidate, BlenderSetupDiscovery } from "../src/setup/blender/types";
import type { SetupChoice, SetupPrompter, SetupState } from "../src/setup/types";

class RoutingPrompter implements SetupPrompter {
  readonly notes: string[] = [];

  intro(message: string): void { this.notes.push(message); }
  note(message: string): void { this.notes.push(message); }
  outro(message: string): void { this.notes.push(message); }
  close(): void {}
  async select(_message: string, choices: SetupChoice[]): Promise<string> { return choices[0]?.value ?? ""; }
  async multiselect(): Promise<string[]> { return []; }
  async text(): Promise<string> { return ""; }
  async secret(): Promise<string> { return ""; }
  async confirm(): Promise<boolean> { return true; }
}

const setupState: SetupState = {
  schemaVersion: 3,
  completed: true,
  selectedProviders: [],
  deepSeekConfigured: false,
  gemmaConfigured: false,
  mockOnlyConfirmed: true,
  voiceToText: "no"
};

function profile(version: string): BlenderProfileCandidate {
  const root = path.resolve("fixtures", `blender-${version}`);
  return {
    profileId: `blender-${version}`,
    executable: { canonicalPath: path.join(root, "blender.exe"), sha256: "a".repeat(64) },
    version,
    paths: {
      resources: { local: root, system: root, user: path.join(root, "user") },
      config: path.join(root, "config"),
      scripts: [path.join(root, "scripts")],
      extensions: path.join(root, "extensions")
    },
    sources: ["association"]
  };
}

function discovery(candidate: BlenderProfileCandidate): BlenderSetupDiscovery {
  return {
    profiles: [candidate],
    selection: { kind: "selected", profileId: candidate.profileId, profile: candidate },
    python: {
      executable: { canonicalPath: path.resolve("fixtures", "python.exe"), sha256: "b".repeat(64) },
      implementation: "cpython",
      version: { major: 3, minor: 11, patch: 9 },
      prefix: path.resolve("fixtures", "python"),
      pointerWidth: 64,
      sysconfigPlatform: "win_amd64"
    }
  };
}

describe("Blender integration version routing", () => {
  it.each([
    ["4.1.9", "prerequisite-missing", undefined],
    ["4.2.0", "installed", "legacy"],
    ["5.0.99", "installed", "legacy"],
    ["5.1.0", "installed", "official"],
    ["5.2.0", "installed", "official"],
    ["5.1.invalid", "prerequisite-missing", undefined]
  ] as const)("routes stable Blender %s deterministically", async (version, expectedStatus, expectedFlavor) => {
    // Given
    const candidate = profile(version);
    const prompter = new RoutingPrompter();
    let observedSelection: unknown;

    // When
    const result = await setupBlenderIntegration({
      homePath: path.resolve("home"),
      workspace: process.cwd(),
      state: setupState,
      prompter,
      mode: "automatic"
    }, {
      platform: "win32",
      architecture: "x64",
      discover: async () => discovery(candidate),
      install: async options => {
        observedSelection = Reflect.get(options, "selection");
        return {
          status: "installed",
          profileId: candidate.profileId,
          receiptPath: path.resolve("home", "mcps", "blender", "installation.json")
        };
      }
    });

    // Then
    expect(result.status).toBe(expectedStatus);
    if (expectedFlavor === undefined) {
      expect(observedSelection).toBeUndefined();
    } else {
      expect(observedSelection).toMatchObject({ flavor: expectedFlavor, profile: candidate });
      expect(result.state.blender?.flavor).toBe(expectedFlavor);
      expect(prompter.notes.join("\n")).toContain(expectedFlavor === "official"
        ? "official 5.1+ MCP flavor"
        : "Pinned blender-mcp 1.6.4");
    }
  });

  it.each([
    ["legacy", "5.0.0", ["provenance.json", "wheels.lock.json", "requirements.lock.txt"]],
    ["official", "5.1.0", ["official-catalog.json", "official-wheels.lock.json", "official-requirements.lock.txt"]]
  ] as const)("loads only %s pinned assets for its selected flavor", async (flavor, version, assetNames) => {
    // Given
    const temporaryAssets = await mkdtemp(path.join(os.tmpdir(), `strongcode-${flavor}-assets-`));
    const sourceAssets = path.join(process.cwd(), "assets", "blender-mcp");
    await mkdir(temporaryAssets, { recursive: true });
    await Promise.all(assetNames.map(async name => writeFile(
      path.join(temporaryAssets, name),
      await readFile(path.join(sourceAssets, name))
    )));
    const candidate = profile(version);
    const prompter = new RoutingPrompter();
    let observed: InstallBlenderIntegrationOptions | undefined;

    try {
      // When
      await setupBlenderIntegration({
        homePath: path.resolve("home"),
        workspace: process.cwd(),
        state: setupState,
        prompter,
        mode: "automatic"
      }, {
        platform: "win32",
        architecture: "x64",
        assetRootPath: temporaryAssets,
        discover: async () => discovery(candidate),
        install: async options => {
          observed = options;
          return { status: "installed", profileId: candidate.profileId,
            receiptPath: path.resolve("home", "mcps", "blender", "installation.json") };
        }
      });

      // Then
      expect(observed?.selection).toMatchObject({ flavor });
      expect(observed !== undefined && "catalog" in observed).toBe(flavor === "official");
      expect(observed !== undefined && "provenance" in observed).toBe(flavor === "legacy");
      if (flavor === "official") {
        const consent = prompter.notes.join("\n");
        expect(consent).toMatch(/v1\.0\.0.*addon SHA-256.*MCPB SHA-256/isu);
        expect(consent).toMatch(/StrongCode-maintained SHA-256 pins, not upstream signatures/iu);
        expect(consent).toMatch(/never PyPI.*uv is not installed or executed/isu);
        expect(consent).toMatch(/canonical JSON.*nonce.*HMAC-SHA256.*127\.0\.0\.1.*generated high port/isu);
        expect(consent).toMatch(/32-byte secret.*private profile config/isu);
        expect(consent).toMatch(/wildcard permission 'ask'.*denied noninteractively/isu);
        expect(consent).toMatch(/Generated Blender\/Python code.*modify/isu);
        expect(consent).toMatch(/extensions[\\/]user_default[\\/]mcp.*userpref\.blend.*rollback/isu);
      }
    } finally {
      await rm(temporaryAssets, { recursive: true, force: true });
    }
  });

  it.each([
    ["legacy", "official", "5.0.0"],
    ["official", "legacy", "5.1.0"]
  ] as const)("records %s state after a forced migration from %s", async (successor, predecessor, version) => {
    // Given
    const candidate = profile(version);
    const prompter = new RoutingPrompter();
    let observed: InstallBlenderIntegrationOptions | undefined;
    const state: SetupState = {
      ...setupState,
      blender: {
        flavor: predecessor,
        profileId: "previous-profile",
        version: predecessor === "legacy" ? "5.0.0" : "5.1.0",
        executablePath: path.resolve("previous", "blender.exe"),
        receiptPath: path.resolve("home", "mcps", "blender", "installation.json"),
        installedAt: "2026-07-17T12:00:00.000Z"
      }
    };

    // When
    const result = await setupBlenderIntegration({ homePath: path.resolve("home"), workspace: process.cwd(),
      state, prompter, mode: "explicit", force: true }, {
      platform: "win32",
      architecture: "x64",
      discover: async () => discovery(candidate),
      install: async options => {
        observed = options;
        return { status: "installed", profileId: candidate.profileId,
          receiptPath: path.resolve("home", "mcps", "blender", "installation.json") };
      }
    });

    // Then
    expect(observed?.selection.flavor).toBe(successor);
    expect(observed?.repair).toBe(true);
    expect(result.state.blender?.flavor).toBe(successor);
    expect(result.state.blender?.profileId).toBe(candidate.profileId);
  });
});
