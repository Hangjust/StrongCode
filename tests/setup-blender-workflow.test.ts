import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setupBlenderIntegration, type BlenderSetupDependencies } from "../src/setup/blender/setup";
import type { InstallBlenderIntegrationOptions } from "../src/setup/blender/install";
import type { BlenderProfileCandidate, BlenderSetupDiscovery } from "../src/setup/blender/types";
import type { ProbeProcessAdapter } from "../src/setup/blender/types";
import { createWindowsAssociationAdapter } from "../src/setup/blender/discovery/windows";
import { SetupCancelledError, type InstalledBlenderIntegration, type SetupChoice, type SetupPrompter, type SetupState } from "../src/setup/types";

class WorkflowPrompter implements SetupPrompter {
  readonly output: string[] = [];
  readonly confirmations: boolean[] = [];
  readonly selections: string[] = [];
  readonly confirmDefaults: Array<boolean | undefined> = [];
  readonly selectCalls: Array<{ readonly message: string; readonly choices: SetupChoice[] }> = [];

  intro(message: string): void { this.output.push(message); }
  note(message: string): void { this.output.push(message); }
  outro(message: string): void { this.output.push(message); }
  close(): void {}
  async select(message: string, choices: SetupChoice[]): Promise<string> {
    this.selectCalls.push({ message, choices });
    return this.selections.shift() ?? "";
  }
  async multiselect(): Promise<string[]> { return []; }
  async text(): Promise<string> { return ""; }
  async secret(): Promise<string> { return ""; }
  async confirm(_message: string, initialValue?: boolean): Promise<boolean> {
    this.confirmDefaults.push(initialValue);
    return this.confirmations.shift() ?? false;
  }
}

const coreState: SetupState = {
  schemaVersion: 3,
  completed: true,
  completedAt: "2026-07-09T12:00:00.000Z",
  selectedProviders: [],
  deepSeekConfigured: false,
  gemmaConfigured: false,
  mockOnlyConfirmed: true,
  voiceToText: "no"
};

function profile(id = "blender-profile", version = "4.3.2"): BlenderProfileCandidate {
  return {
    profileId: id,
    executable: { canonicalPath: path.resolve("fixtures", id, "blender.exe"), sha256: "a".repeat(64) },
    version,
    paths: {
      resources: {
        local: path.resolve("fixtures", id, "local"),
        system: path.resolve("fixtures", id, "system"),
        user: path.resolve("fixtures", id, "user")
      },
      config: path.resolve("fixtures", id, "config"),
      scripts: [path.resolve("fixtures", id, "scripts")]
    },
    sources: ["association"]
  };
}

function discovery(profiles: readonly BlenderProfileCandidate[], python = true): BlenderSetupDiscovery {
  const selected = profiles.length === 1 ? profiles[0] : undefined;
  return {
    profiles,
    selection: selected
      ? { kind: "selected", profileId: selected.profileId, profile: selected }
      : profiles.length === 0 ? { kind: "none" } : { kind: "required", profileIds: profiles.map(candidate => candidate.profileId) },
    python: python ? {
      executable: { canonicalPath: path.resolve("fixtures", "python.exe"), sha256: "b".repeat(64) },
      implementation: "cpython",
      version: { major: 3, minor: 11, patch: 9 },
      prefix: path.resolve("fixtures", "python"),
      pointerWidth: 64,
      sysconfigPlatform: "win_amd64"
    } : undefined
  };
}

function dependencies(
  result: BlenderSetupDiscovery,
  installs: InstallBlenderIntegrationOptions[]
): BlenderSetupDependencies {
  return {
    platform: "win32",
    architecture: "x64",
    now: () => new Date("2026-07-10T10:00:00.000Z"),
    discover: async () => result,
    install: async options => {
      installs.push(options);
      return {
        status: "installed",
        profileId: options.selection.profile.profileId,
        receiptPath: path.resolve("home", "mcps", "blender", "installation.json")
      };
    }
  };
}

describe("Blender setup workflow", () => {
  it("installs after one explicit default-false consent and records installed metadata", async () => {
    const prompter = new WorkflowPrompter();
    prompter.confirmations.push(true);
    const installs: InstallBlenderIntegrationOptions[] = [];
    const candidate = profile();

    const result = await setupBlenderIntegration({
      homePath: path.resolve("home"),
      workspace: process.cwd(),
      state: coreState,
      prompter,
      mode: "automatic"
    }, dependencies(discovery([candidate]), installs));

    expect(installs).toHaveLength(1);
    expect(installs[0]).toMatchObject({
      selection: { flavor: "legacy", profile: candidate },
      platform: "win32",
      architecture: "x64"
    });
    expect(prompter.confirmDefaults).toEqual([false]);
    expect(prompter.output.join("\n")).toContain("blender-mcp 1.6.4");
    expect(prompter.output.join("\n")).toContain("authenticated ephemeral loopback listener");
    expect(prompter.output.join("\n")).toContain("execute_blender_code remains ask and is denied noninteractively");
    expect(prompter.output.join("\n")).toContain("does not install Python or uv, create OS autostart, or modify project configuration");
    expect(prompter.output.join("\n")).toContain("rollback");
    expect(result.state.blender).toMatchObject({
      flavor: "legacy",
      profileId: candidate.profileId,
      version: candidate.version,
      executablePath: candidate.executable.canonicalPath,
      installedAt: "2026-07-10T10:00:00.000Z"
    });
  });

  it("repairs installed metadata only after explicit default-false force consent", async () => {
    // Given
    const prompter = new WorkflowPrompter();
    prompter.confirmations.push(true);
    const installs: InstallBlenderIntegrationOptions[] = [];
    const candidate = profile();
    const installedState = {
      ...coreState,
      blender: {
        flavor: "legacy",
        profileId: candidate.profileId,
        version: candidate.version,
        executablePath: candidate.executable.canonicalPath,
        receiptPath: path.resolve("installation.json"),
        installedAt: "2026-07-09T09:00:00.000Z"
      }
    } satisfies SetupState;

    // When
    await setupBlenderIntegration({
      homePath: path.resolve("home"),
      workspace: process.cwd(),
      state: installedState,
      prompter,
      mode: "explicit",
      force: true
    }, dependencies(discovery([candidate]), installs));

    // Then
    expect(installs[0]).toMatchObject({ repair: true });
    expect(prompter.confirmDefaults).toEqual([false]);
  });

  it("normalizes mixed-case Windows discovery env and removes credentials", async () => {
      const prompter = new WorkflowPrompter();
      const discoveryEnvironments: NodeJS.ProcessEnv[] = [];
      const enumeratedRoots: string[] = [];
      const commandRunner: ProbeProcessAdapter = {
        async run() { return { kind: "timeout" }; }
      };

      await setupBlenderIntegration({
        homePath: path.resolve("home"),
        workspace: process.cwd(),
        state: coreState,
        prompter,
        mode: "automatic"
      }, {
        platform: "win32",
        architecture: "x64",
        env: {
          PaTh: "C:\\safe-bin",
          PATHEXT: ".EXE",
          sYsTeMrOoT: "C:\\Windows",
          PROGRAMFILES: "C:\\Program Files",
          pRoGrAmW6432: "C:\\Program Files",
          OPENAI_API_KEY: "must-not-reach-probes",
          STRONGCODE_AUTH_CONTENT: "must-not-reach-probes",
          PyThOnPaTh: "must-not-reach-probes"
        },
        discover: async options => {
          discoveryEnvironments.push(options.env ?? {});
          await createWindowsAssociationAdapter({
            runner: commandRunner,
            cwd: process.cwd(),
            env: options.env ?? {},
            systemRoot: "C:\\Windows",
            installEnumerator: {
              async directories(root) {
                enumeratedRoots.push(root);
                return [];
              }
            },
            timeoutMs: 500,
            maxOutputBytes: 4096,
            maxCandidates: 4
          }).blenderExecutables(undefined);
          return discovery([]);
        }
      });

      expect(discoveryEnvironments).toEqual([{
        PATH: "C:\\safe-bin",
        PATHEXT: ".EXE",
        SystemRoot: "C:\\Windows",
        ProgramFiles: "C:\\Program Files",
        ProgramW6432: "C:\\Program Files"
      }]);
      expect(enumeratedRoots).toEqual(["C:\\Program Files\\Blender Foundation"]);
    });

  it("deduplicates mixed-case aliases with equal values before discovery", async () => {
    const prompter = new WorkflowPrompter();
    const seen: NodeJS.ProcessEnv[] = [];

    await setupBlenderIntegration({
      homePath: path.resolve("home"),
      workspace: process.cwd(),
      state: coreState,
      prompter,
      mode: "automatic"
    }, {
      platform: "win32",
      architecture: "x64",
      env: {
        Path: "C:\\bin",
        PaTh: "C:\\bin",
        ProgramFiles: "C:\\Program Files",
        PROGRAMFILES: "C:\\Program Files"
      },
      discover: async options => {
        seen.push(options.env ?? {});
        return discovery([]);
      }
    });

    expect(seen).toEqual([{
      PATH: "C:\\bin",
      ProgramFiles: "C:\\Program Files"
    }]);
  });

  it("fails with config error when mixed-case aliases diverge", async () => {
    const prompter = new WorkflowPrompter();

    await expect(setupBlenderIntegration({
      homePath: path.resolve("home"),
      workspace: process.cwd(),
      state: coreState,
      prompter,
      mode: "automatic"
    }, {
      platform: "win32",
      architecture: "x64",
      env: {
        Path: "C:\\bin-one",
        PaTh: "C:\\bin-two",
        SystemRoot: "C:\\Windows"
      },
      discover: async () => {
        return discovery([]);
      }
    })).rejects.toThrow("Conflicting environment aliases for PATH");
  });

  it("does not install or record metadata when consent is declined", async () => {
    const prompter = new WorkflowPrompter();
    prompter.confirmations.push(false);
    const installs: InstallBlenderIntegrationOptions[] = [];

    const result = await setupBlenderIntegration({
      homePath: path.resolve("home"),
      workspace: process.cwd(),
      state: coreState,
      prompter,
      mode: "automatic"
    }, dependencies(discovery([profile()]), installs));

    expect(result.status).toBe("declined");
    expect(result.state).toBe(coreState);
    expect(installs).toEqual([]);
  });

  it("requires explicit selection when multiple compatible profiles exist", async () => {
    const prompter = new WorkflowPrompter();
    const first = profile("blender-first");
    const second = profile("blender-second", "4.4.0");
    prompter.selections.push(second.profileId);
    prompter.confirmations.push(true);
    const installs: InstallBlenderIntegrationOptions[] = [];

    await setupBlenderIntegration({
      homePath: path.resolve("home"),
      workspace: process.cwd(),
      state: coreState,
      prompter,
      mode: "automatic"
    }, dependencies(discovery([first, second]), installs));

    expect(prompter.selectCalls).toHaveLength(1);
    expect(installs[0]?.selection.profile.profileId).toBe(second.profileId);
  });

  it("shows the actionable Python prerequisite and does not prompt or install", async () => {
    const prompter = new WorkflowPrompter();
    const installs: InstallBlenderIntegrationOptions[] = [];

    const result = await setupBlenderIntegration({
      homePath: path.resolve("home"),
      workspace: process.cwd(),
      state: coreState,
      prompter,
      mode: "automatic"
    }, dependencies(discovery([profile()], false), installs));

    expect(result.status).toBe("prerequisite-missing");
    expect(prompter.output.join("\n")).toContain("CPython 3.11 win_amd64");
    expect(prompter.confirmDefaults).toEqual([]);
    expect(installs).toEqual([]);
  });

  it("does not prompt when Blender is absent", async () => {
    const prompter = new WorkflowPrompter();
    const installs: InstallBlenderIntegrationOptions[] = [];
    const absent = await setupBlenderIntegration({
      homePath: path.resolve("home"),
      workspace: process.cwd(),
      state: coreState,
      prompter,
      mode: "automatic"
    }, dependencies(discovery([]), installs));

    expect(absent.status).toBe("not-found");
    expect(prompter.confirmDefaults).toEqual([]);
    expect(installs).toEqual([]);
  });

  it("cheaply skips installed metadata in automatic mode", async () => {
    const prompter = new WorkflowPrompter();
    const installs: InstallBlenderIntegrationOptions[] = [];
    let discoveries = 0;
    const installedState = {
      ...coreState,
      blender: {
        flavor: "legacy",
        profileId: "installed",
        version: "4.3.2",
        executablePath: path.resolve("blender.exe"),
        receiptPath: path.resolve("installation.json"),
        installedAt: "2026-07-10T10:00:00.000Z"
      }
    } satisfies SetupState;
    const result = await setupBlenderIntegration({
      homePath: path.resolve("home"),
      workspace: process.cwd(),
      state: installedState,
      prompter,
      mode: "automatic"
    }, {
      ...dependencies(discovery([profile()]), installs),
      discover: async () => {
        discoveries += 1;
        return discovery([profile()]);
      }
    });

    expect(result.status).toBe("already-installed");
    expect(discoveries).toBe(0);
    expect(prompter.confirmDefaults).toEqual([]);
    expect(installs).toEqual([]);
  });

  it("verifies a healthy installed integration explicitly without prompting or repairing", async () => {
    const prompter = new WorkflowPrompter();
    const installs: InstallBlenderIntegrationOptions[] = [];
    const candidate = profile("installed");
    const installedState = {
      ...coreState,
      blender: {
        flavor: "legacy",
        profileId: candidate.profileId,
        version: candidate.version,
        executablePath: candidate.executable.canonicalPath,
        receiptPath: path.resolve("installation.json"),
        installedAt: "2026-07-10T10:00:00.000Z"
      }
    } satisfies SetupState;

    const result = await setupBlenderIntegration({
      homePath: path.resolve("home"),
      workspace: process.cwd(),
      state: installedState,
      prompter,
      mode: "explicit"
    }, {
      ...dependencies(discovery([candidate]), installs),
      install: async options => {
        installs.push(options);
        return { status: "already-installed", profileId: candidate.profileId, receiptPath: installedState.blender.receiptPath };
      }
    });

    expect(result.status).toBe("already-installed");
    expect(result.state.blender).toEqual(installedState.blender);
    expect(installs).toHaveLength(1);
    expect(installs[0]?.repair).toBe(false);
    expect(prompter.confirmDefaults).toEqual([]);
  });

  it("automatically restores missing metadata only after verifying the committed receipt", async () => {
    // Given
    const homePath = await mkdtemp(path.join(tmpdir(), "strongcode-workflow-missing-metadata-"));
    const receiptPath = path.join(homePath, "mcps", "blender", "installation.json");
    await mkdir(path.dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, "owned receipt fixture", "utf8");
    const prompter = new WorkflowPrompter();
    const candidate = profile("verified-profile", "4.4.0");
    const verificationIntents: boolean[] = [];

    // When
    const result = await setupBlenderIntegration({
      homePath,
      workspace: process.cwd(),
      state: coreState,
      prompter,
      mode: "automatic"
    }, {
      ...dependencies(discovery([candidate]), []),
      install: async options => {
        verificationIntents.push(options.verifyOnly ?? false);
        return { status: "already-installed", profileId: candidate.profileId, receiptPath };
      }
    });

    // Then
    expect(result.state.blender).toEqual({
      flavor: "legacy",
      profileId: candidate.profileId,
      version: candidate.version,
      executablePath: candidate.executable.canonicalPath,
      receiptPath,
      installedAt: "2026-07-10T10:00:00.000Z"
    });
    expect(verificationIntents).toEqual([true]);
    expect(prompter.confirmDefaults).toEqual([]);
  });

  it.each(["profileId", "version", "executablePath", "receiptPath"] as const)(
    "replaces a stale %s with verified metadata and the injected clock",
    async identityField => {
      // Given
      const prompter = new WorkflowPrompter();
      const candidate = profile("verified-profile", "4.4.0");
      const receiptPath = path.resolve("verified-installation.json");
      const verifiedIdentity = {
        flavor: "legacy" as const,
        profileId: candidate.profileId,
        version: candidate.version,
        executablePath: candidate.executable.canonicalPath,
        receiptPath
      };
      const mismatches = {
        flavor: "official" as const,
        profileId: "stale-profile",
        version: "4.3.2",
        executablePath: path.resolve("stale-blender.exe"),
        receiptPath: path.resolve("stale-installation.json")
      } satisfies Omit<InstalledBlenderIntegration, "installedAt">;
      const installedState = {
        ...coreState,
        blender: {
          ...verifiedIdentity,
          [identityField]: mismatches[identityField],
          installedAt: "2026-07-09T09:00:00.000Z"
        }
      } satisfies SetupState;

      // When
      const result = await setupBlenderIntegration({
        homePath: path.resolve("home"),
        workspace: process.cwd(),
        state: installedState,
        prompter,
        mode: "explicit"
      }, {
        ...dependencies(discovery([candidate]), []),
        install: async () => ({ status: "already-installed", profileId: candidate.profileId, receiptPath })
      });

      // Then
      expect(result.state.blender).toEqual({
        ...verifiedIdentity,
        installedAt: "2026-07-10T10:00:00.000Z"
      });
    }
  );

  it("surfaces installer drift during explicit verification without prompting or auto-repairing", async () => {
    const prompter = new WorkflowPrompter();
    const candidate = profile("installed");
    const installedState = {
      ...coreState,
      blender: {
        flavor: "legacy",
        profileId: candidate.profileId,
        version: candidate.version,
        executablePath: candidate.executable.canonicalPath,
        receiptPath: path.resolve("installation.json"),
        installedAt: "2026-07-10T10:00:00.000Z"
      }
    } satisfies SetupState;
    const repairs: boolean[] = [];

    await expect(setupBlenderIntegration({
      homePath: path.resolve("home"),
      workspace: process.cwd(),
      state: installedState,
      prompter,
      mode: "explicit"
    }, {
      ...dependencies(discovery([candidate]), []),
      install: async options => {
        repairs.push(options.repair ?? false);
        throw new Error("Blender integration repair required; rerun strongcode setup --blender --force");
      }
    })).rejects.toThrow("rerun strongcode setup --blender --force");

    expect(repairs).toEqual([false]);
    expect(prompter.confirmDefaults).toEqual([]);
  });

  it("fails closed when stale setup metadata has no ownership receipt", async () => {
    const prompter = new WorkflowPrompter();
    const candidate = profile("stale-installed");
    const installedState = {
      ...coreState,
      blender: {
        flavor: "legacy",
        profileId: candidate.profileId,
        version: candidate.version,
        executablePath: candidate.executable.canonicalPath,
        receiptPath: path.resolve("missing-installation.json"),
        installedAt: "2026-07-10T10:00:00.000Z"
      }
    } satisfies SetupState;

    await expect(setupBlenderIntegration({
      homePath: path.resolve("missing-home"),
      workspace: process.cwd(),
      state: installedState,
      prompter,
      mode: "explicit"
    }, {
      ...dependencies(discovery([candidate]), []),
      install: async options => {
        if (options.verifyOnly) {
          throw new Error("Blender integration repair required; rerun strongcode setup --blender --force");
        }
        return { status: "installed", profileId: candidate.profileId, receiptPath: installedState.blender.receiptPath };
      }
    })).rejects.toThrow("rerun strongcode setup --blender --force");

    expect(prompter.confirmDefaults).toEqual([]);
  });

  it("keeps verification-only intent when the receipt disappears before installer entry", async () => {
    const homePath = await mkdtemp(path.join(tmpdir(), "strongcode-workflow-receipt-race-"));
    const receiptPath = path.join(homePath, "mcps", "blender", "installation.json");
    await mkdir(path.dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, "owned receipt fixture", "utf8");
    const prompter = new WorkflowPrompter();
    const candidate = profile("receipt-race");

    await expect(setupBlenderIntegration({
      homePath,
      workspace: process.cwd(),
      state: coreState,
      prompter,
      mode: "explicit"
    }, {
      ...dependencies(discovery([candidate]), []),
      install: async options => {
        await rm(receiptPath);
        if (options.verifyOnly) {
          throw new Error("Blender integration repair required; rerun strongcode setup --blender --force");
        }
        return { status: "installed", profileId: candidate.profileId, receiptPath };
      }
    })).rejects.toThrow("rerun strongcode setup --blender --force");

    expect(prompter.confirmDefaults).toEqual([]);
  });

  it("treats prompt cancellation as no mutation", async () => {
    const prompter = new WorkflowPrompter();
    prompter.select = async () => { throw new SetupCancelledError(); };
    const installs: InstallBlenderIntegrationOptions[] = [];

    const result = await setupBlenderIntegration({
      homePath: path.resolve("home"),
      workspace: process.cwd(),
      state: coreState,
      prompter,
      mode: "automatic"
    }, dependencies(discovery([profile("one"), profile("two")]), installs));

    expect(result.status).toBe("cancelled");
    expect(result.state).toBe(coreState);
    expect(installs).toEqual([]);
  });

  it("leaves completed core state unchanged when installation fails", async () => {
    const prompter = new WorkflowPrompter();
    prompter.confirmations.push(true);
    const failed: BlenderSetupDependencies = {
      ...dependencies(discovery([profile()]), []),
      install: async () => { throw new Error("installer fixture failed"); }
    };

    await expect(setupBlenderIntegration({
      homePath: path.resolve("home"),
      workspace: process.cwd(),
      state: coreState,
      prompter,
      mode: "automatic"
    }, failed)).rejects.toThrow("installer fixture failed");

    expect(coreState.completed).toBe(true);
    expect(coreState.blender).toBeUndefined();
  });
});
