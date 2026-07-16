import { lstat, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { main, type CliDependencies } from "../src/cli";
import { loadSetupState, saveSetupState } from "../src/setup/state";
import { SetupCancelledError, type SetupChoice, type SetupPrompter, type SetupState } from "../src/setup/types";

class OfferPrompter implements SetupPrompter {
  readonly output: string[] = [];
  readonly confirmations: boolean[] = [];
  closes = 0;
  intro(message: string): void { this.output.push(message); }
  note(message: string): void { this.output.push(message); }
  outro(message: string): void { this.output.push(message); }
  close(): void { this.closes += 1; }
  async select(_message: string, choices: SetupChoice[]): Promise<string> { return choices[0]?.value ?? ""; }
  async multiselect(): Promise<string[]> { return []; }
  async text(): Promise<string> { return ""; }
  async secret(): Promise<string> { return ""; }
  async confirm(): Promise<boolean> { return this.confirmations.shift() ?? false; }
}

const completedState: SetupState = {
  schemaVersion: 2,
  completed: true,
  completedAt: "2026-07-15T09:00:00.000Z",
  selectedProviders: ["openai"],
  deepSeekConfigured: false,
  gemmaConfigured: false,
  mockOnlyConfirmed: false,
  voiceToText: "no",
  blenderOfferVersion: 0
};

const blenderProfile = {
  profileId: "blender-launch-profile",
  executable: { canonicalPath: path.resolve("fixtures", "blender.exe"), sha256: "a".repeat(64) },
  version: "4.3.2",
  paths: {
    resources: {
      local: path.resolve("fixtures", "blender", "local"),
      system: path.resolve("fixtures", "blender", "system"),
      user: path.resolve("fixtures", "blender", "user")
    },
    config: path.resolve("fixtures", "blender", "config"),
    scripts: [path.resolve("fixtures", "blender", "scripts")]
  },
  sources: ["association" as const]
};

function availableBlender() {
  return {
    profiles: [blenderProfile],
    selection: { kind: "selected" as const, profileId: blenderProfile.profileId, profile: blenderProfile },
    python: {
      executable: { canonicalPath: path.resolve("fixtures", "python.exe"), sha256: "b".repeat(64) },
      implementation: "cpython" as const,
      version: { major: 3, minor: 11, patch: 9 },
      prefix: path.resolve("fixtures", "python"),
      pointerWidth: 64 as const,
      sysconfigPlatform: "win_amd64" as const
    }
  };
}

async function tempHome(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

function launchDependencies(homePath: string, prompter: OfferPrompter): CliDependencies {
  return {
    homePath,
    setupPrompter: prompter,
    isInteractive: () => true,
    shouldRunFirstSetup: async () => false,
    runTui: async () => undefined
  };
}

describe("automatic Blender launch offer", () => {
  it("offers a schema-v1 existing user without rerunning provider setup and persists decline suppression", async () => {
    const homePath = await tempHome("strongcode-launch-v1-");
    await writeFile(path.join(homePath, "setup.json"), `${JSON.stringify({
      schemaVersion: 1,
      completed: true,
      completedAt: "2026-07-15T09:00:00.000Z",
      selectedProviders: ["openai"],
      deepSeekConfigured: false,
      gemmaConfigured: false,
      mockOnlyConfirmed: false,
      voiceToText: "no"
    })}\n`, "utf8");
    const prompter = new OfferPrompter();
    prompter.confirmations.push(false);
    let providerSetups = 0;
    let discoveries = 0;

    await main(["node", "strongcode"], {
      ...launchDependencies(homePath, prompter),
      runSetup: async () => {
        providerSetups += 1;
        throw new Error("provider setup must not run");
      },
      blender: {
        platform: "win32",
        architecture: "x64",
        discover: async () => {
          discoveries += 1;
          return availableBlender();
        }
      }
    });

    expect(providerSetups).toBe(0);
    expect(discoveries).toBe(1);
    const state = await loadSetupState(homePath);
    expect(state.blenderOfferVersion).toBe(1);
    expect(state.blender).toBeUndefined();
    expect(prompter.closes).toBe(1);
  });

  it("suppresses repeat offers after decline", async () => {
    const homePath = await tempHome("strongcode-launch-declined-");
    await saveSetupState(homePath, { ...completedState, blenderOfferVersion: 1 });
    const prompter = new OfferPrompter();
    let discoveries = 0;

    await main(["node", "strongcode"], {
      ...launchDependencies(homePath, prompter),
      blender: {
        discover: async () => {
          discoveries += 1;
          return { profiles: [], selection: { kind: "none" } };
        }
      }
    });

    expect(discoveries).toBe(0);
    expect(prompter.closes).toBe(0);
  });

  it("retries detection on a later launch after Blender was not found", async () => {
    const homePath = await tempHome("strongcode-launch-retry-");
    await saveSetupState(homePath, completedState);
    let discoveries = 0;
    const firstPrompter = new OfferPrompter();
    await main(["node", "strongcode"], {
      ...launchDependencies(homePath, firstPrompter),
      blender: {
        discover: async () => {
          discoveries += 1;
          return { profiles: [], selection: { kind: "none" } };
        }
      }
    });
    expect((await loadSetupState(homePath)).blenderOfferVersion).toBe(0);
    expect(firstPrompter.output).toEqual([]);
    expect(firstPrompter.closes).toBe(1);

    const secondPrompter = new OfferPrompter();
    secondPrompter.confirmations.push(false);
    await main(["node", "strongcode"], {
      ...launchDependencies(homePath, secondPrompter),
      blender: {
        platform: "win32",
        architecture: "x64",
        discover: async () => {
          discoveries += 1;
          return availableBlender();
        }
      }
    });

    expect(discoveries).toBe(2);
    expect((await loadSetupState(homePath)).blenderOfferVersion).toBe(1);
  });

  it("keeps missing prerequisites eligible for a future launch", async () => {
    const homePath = await tempHome("strongcode-launch-prerequisite-");
    await saveSetupState(homePath, completedState);
    const firstPrompter = new OfferPrompter();

    await main(["node", "strongcode"], {
      ...launchDependencies(homePath, firstPrompter),
      blender: {
        platform: "win32",
        architecture: "x64",
        discover: async () => ({ ...availableBlender(), python: undefined })
      }
    });

    expect((await loadSetupState(homePath)).blenderOfferVersion).toBe(0);
    expect(firstPrompter.output.join("\n")).toContain("CPython 3.11 win_amd64");

    const secondPrompter = new OfferPrompter();
    secondPrompter.confirmations.push(false);
    await main(["node", "strongcode"], {
      ...launchDependencies(homePath, secondPrompter),
      blender: {
        platform: "win32",
        architecture: "x64",
        discover: async () => availableBlender()
      }
    });

    expect((await loadSetupState(homePath)).blenderOfferVersion).toBe(1);
  });

  it("merges successful Blender metadata without changing completed provider fields", async () => {
    const homePath = await tempHome("strongcode-launch-install-");
    await saveSetupState(homePath, completedState);
    const prompter = new OfferPrompter();
    prompter.confirmations.push(true);

    await main(["node", "strongcode"], {
      ...launchDependencies(homePath, prompter),
      blender: {
        platform: "win32",
        architecture: "x64",
        now: () => new Date("2026-07-15T10:00:00.000Z"),
        discover: async () => availableBlender(),
        install: async options => ({
          status: "installed",
          profileId: options.profile.profileId,
          receiptPath: path.join(homePath, "mcps", "blender", "installation.json")
        })
      }
    });

    expect(await loadSetupState(homePath)).toMatchObject({
      completed: true,
      selectedProviders: ["openai"],
      blenderOfferVersion: 1,
      blender: { profileId: blenderProfile.profileId }
    });
  });

  it("keeps the offer eligible after consent cancellation", async () => {
    const homePath = await tempHome("strongcode-launch-cancel-");
    await saveSetupState(homePath, completedState);
    const prompter = new OfferPrompter();
    prompter.confirm = async () => { throw new SetupCancelledError(); };

    await main(["node", "strongcode"], {
      ...launchDependencies(homePath, prompter),
      blender: {
        platform: "win32",
        architecture: "x64",
        discover: async () => availableBlender()
      }
    });

    expect((await loadSetupState(homePath)).blenderOfferVersion).toBe(0);
    expect(prompter.closes).toBe(1);
  });

  it("does not scan twice when first-run setup already attempted Blender", async () => {
    const homePath = await tempHome("strongcode-launch-first-run-");
    let setupRuns = 0;
    let automaticDiscoveries = 0;

    await main(["node", "strongcode"], {
      ...launchDependencies(homePath, new OfferPrompter()),
      shouldRunFirstSetup: async () => true,
      runSetup: async () => {
        setupRuns += 1;
        await saveSetupState(homePath, completedState);
        return { status: "completed", state: completedState, warnings: [] };
      },
      blender: {
        discover: async () => {
          automaticDiscoveries += 1;
          return { profiles: [], selection: { kind: "none" } };
        }
      }
    });

    expect(setupRuns).toBe(1);
    expect(automaticDiscoveries).toBe(0);
  });

  it.each([
    ["setup --blender", ["setup", "--blender"]],
    ["install --blender", ["install", "--blender"]],
    ["setup --force --blender", ["setup", "--force", "--blender"]],
    ["setup --blender --force", ["setup", "--blender", "--force"]]
  ])("blocks non-interactive %s before home bootstrap", async (_label, args) => {
    const parent = await mkdtemp(path.join(tmpdir(), "strongcode-blender-noninteractive-"));
    const homePath = path.join(parent, "strongcode-home");
    const previousExitCode = process.exitCode;
    process.exitCode = 0;

    let providerSetups = 0;
    let discoveries = 0;
    let installs = 0;

    await main(["node", "strongcode", ...args], {
      homePath,
      isInteractive: () => false,
      runSetup: async () => {
        providerSetups += 1;
        throw new Error("provider setup should not run");
      },
      blender: {
        discover: async () => {
          discoveries += 1;
          return { profiles: [], selection: { kind: "none" } };
        },
        install: async () => {
          installs += 1;
          return { status: "installed", profileId: blenderProfile.profileId, receiptPath: path.join(homePath, "blender.json") };
        }
      }
    });

    try {
      expect(process.exitCode).toBe(1);
      expect(providerSetups).toBe(0);
      expect(discoveries).toBe(0);
      expect(installs).toBe(0);
      await expect(lstat(homePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("does not apply pre-bootstrap guard for duplicate command invocation", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "strongcode-blender-duplicate-command-"));
    const homePath = path.join(parent, "strongcode-home");
    const previousExitCode = process.exitCode;
    process.exitCode = 0;

    let providerSetups = 0;

    await main(["node", "strongcode", "setup", "install", "--blender"], {
      homePath,
      isInteractive: () => false,
      runSetup: async () => {
        providerSetups += 1;
        throw new Error("provider setup should not run");
      },
      blender: {
        discover: async () => {
          return { profiles: [], selection: { kind: "none" } };
        }
      }
    });

    try {
      expect(process.exitCode).toBe(1);
      expect(providerSetups).toBe(0);
      await expect(lstat(homePath)).resolves.toBeDefined();
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("does not block non-interactive setup --blender --help", async () => {
    const homePath = await tempHome("strongcode-blender-help-");
    const previousExitCode = process.exitCode;
    process.exitCode = 0;

    await main(["node", "strongcode", "setup", "--blender", "--help"], {
      homePath,
      isInteractive: () => false
    });

    try {
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("continues into the TUI when the automatic optional offer fails", async () => {
    const homePath = await tempHome("strongcode-launch-fail-soft-");
    await saveSetupState(homePath, completedState);
    const prompter = new OfferPrompter();
    const reports: string[] = [];
    let tuiRuns = 0;

    await main(["node", "strongcode"], {
      ...launchDependencies(homePath, prompter),
      runTui: async () => { tuiRuns += 1; },
      reportBlenderOfferError: message => { reports.push(message); },
      blender: {
        discover: async () => { throw new Error("discovery fixture failed"); }
      }
    });

    expect(tuiRuns).toBe(1);
    expect(reports.join("\n")).toContain("strongcode setup --blender");
    expect((await loadSetupState(homePath)).blenderOfferVersion).toBe(0);
    expect(prompter.closes).toBe(1);
  });
});
