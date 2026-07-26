import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CacheRetentionResult } from "../src/config/cache-retention";
import { main } from "../src/cli";

const EMPTY_RESULT: CacheRetentionResult = {
  removedFiles: [],
  removedDirectories: [],
  skippedPaths: []
};

describe("CLI cache retention lifecycle", () => {
  it("runs retention for an agent runtime launch but not informational commands", async () => {
    const homePath = await mkdtemp(path.join(tmpdir(), "strongcode-cli-retention-gating-"));
    let cleanups = 0;
    const dependencies = {
      homePath,
      isInteractive: () => true,
      shouldRunFirstSetup: async () => false,
      runTui: async () => undefined,
      enforceCacheRetention: async () => {
        cleanups += 1;
        return EMPTY_RESULT;
      }
    };

    await main(["node", "strongcode"], dependencies);
    await main(["node", "strongcode", "--help"], dependencies);

    expect(cleanups).toBe(1);
  });

  it("reports retention failures without blocking the agent runtime", async () => {
    const homePath = await mkdtemp(path.join(tmpdir(), "strongcode-cli-retention-failure-"));
    const warnings: string[] = [];
    let tuiRuns = 0;

    await main(["node", "strongcode"], {
      homePath,
      isInteractive: () => true,
      shouldRunFirstSetup: async () => false,
      runTui: async () => { tuiRuns += 1; },
      enforceCacheRetention: async () => { throw Object.assign(new Error("locked cache"), { code: "EBUSY" }); },
      reportCacheRetentionError: message => { warnings.push(message); }
    });

    expect(tuiRuns).toBe(1);
    expect(warnings).toEqual(["Cache retention skipped: locked cache"]);
  });

  it("surfaces an invalid retention policy without blocking startup", async () => {
    const homePath = await mkdtemp(path.join(tmpdir(), "strongcode-cli-retention-policy-"));
    const warnings: string[] = [];

    await main(["node", "strongcode"], {
      homePath,
      isInteractive: () => true,
      shouldRunFirstSetup: async () => false,
      runTui: async () => undefined,
      enforceCacheRetention: async () => ({ ...EMPTY_RESULT, skippedPaths: ["config/retention.json"] }),
      reportCacheRetentionError: message => { warnings.push(message); }
    });

    expect(warnings).toEqual(["Cache retention policy is invalid or unsafe; cleanup skipped."]);
  });
});
