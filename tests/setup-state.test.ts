import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSetupState, saveSetupState, updateSetupState } from "../src/setup/state";
import { mergeBlenderSetupResult } from "../src/setup/blender/state";
import type { InstalledBlenderIntegration, SetupState } from "../src/setup/types";

const initialState: SetupState = {
  schemaVersion: 2,
  completed: false,
  selectedProviders: [],
  deepSeekConfigured: false,
  gemmaConfigured: false,
  mockOnlyConfirmed: false,
  voiceToText: "no",
  blenderOfferVersion: 0
};

const installedBlender: InstalledBlenderIntegration = {
  profileId: "blender-concurrent",
  version: "4.3.2",
  executablePath: path.resolve("fixtures", "blender.exe"),
  receiptPath: path.resolve("home", "mcps", "blender", "installation.json"),
  installedAt: "2026-07-15T10:00:00.000Z"
};

async function tempHome(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

describe("setup state revisions", () => {
  it("defaults an existing schema-v2 state without an offer version to zero", async () => {
    const homePath = await tempHome("strongcode-state-v2-default-");
    await writeFile(path.join(homePath, "setup.json"), `${JSON.stringify({
      ...initialState,
      blenderOfferVersion: undefined
    })}\n`, "utf8");

    const state = await loadSetupState(homePath);

    expect(state.blenderOfferVersion).toBe(0);
  });

  it("preserves concurrent core and Blender field updates after a stale-write retry", async () => {
    const homePath = await tempHome("strongcode-state-concurrent-");
    await saveSetupState(homePath, initialState);
    let releaseBlender: (() => void) | undefined;
    let blenderRead: (() => void) | undefined;
    const read = new Promise<void>(resolve => { blenderRead = resolve; });
    const release = new Promise<void>(resolve => { releaseBlender = resolve; });
    let blenderAttempts = 0;
    const blenderWrite = updateSetupState(homePath, async () => {
      blenderAttempts += 1;
      if (blenderAttempts === 1) {
        blenderRead?.();
        await release;
      }
      return { blender: installedBlender, blenderOfferVersion: 1 };
    });
    await read;

    await updateSetupState(homePath, () => ({
      completed: true,
      completedAt: "2026-07-15T09:00:00.000Z",
      selectedProviders: ["openai"],
      mockOnlyConfirmed: false
    }));
    releaseBlender?.();
    await blenderWrite;

    expect(await loadSetupState(homePath)).toMatchObject({
      completed: true,
      selectedProviders: ["openai"],
      blender: installedBlender,
      blenderOfferVersion: 1
    });
    expect(blenderAttempts).toBe(2);
  });

  it("stops after three stale-write retries", async () => {
    const homePath = await tempHome("strongcode-state-stale-");
    await saveSetupState(homePath, initialState);
    let attempts = 0;

    await expect(updateSetupState(homePath, async latest => {
      attempts += 1;
      await saveSetupState(homePath, { ...latest, selectedProviders: [`writer-${attempts}`] });
      return { voiceToText: "yes" };
    })).rejects.toThrow("changed after planning");

    expect(attempts).toBe(3);
    expect((await loadSetupState(homePath)).voiceToText).toBe("no");
  });

  it("does not let a delayed unavailable result downgrade concurrent decline suppression", async () => {
    const homePath = await tempHome("strongcode-state-offer-monotonic-");
    await saveSetupState(homePath, initialState);
    await mergeBlenderSetupResult(homePath, { status: "declined", state: initialState });

    await mergeBlenderSetupResult(homePath, { status: "not-found", state: initialState });

    expect((await loadSetupState(homePath)).blenderOfferVersion).toBe(1);
  });

  it("does not let a delayed install result overwrite newer Blender metadata", async () => {
    // Given
    const homePath = await tempHome("strongcode-state-blender-monotonic-");
    const verifiedBlender: InstalledBlenderIntegration = {
      ...installedBlender,
      profileId: "blender-verified",
      installedAt: "2026-07-15T11:00:00.000Z"
    };
    const concurrentBlender: InstalledBlenderIntegration = {
      ...installedBlender,
      profileId: "blender-concurrent-winner",
      installedAt: "2026-07-15T08:00:00.000Z"
    };
    await saveSetupState(homePath, {
      ...initialState,
      completed: true,
      selectedProviders: ["openai"],
      blender: concurrentBlender
    });

    // When
    await mergeBlenderSetupResult(homePath, {
      status: "installed",
      originalBlender: installedBlender,
      state: { ...initialState, blender: verifiedBlender }
    });

    // Then
    expect(await loadSetupState(homePath)).toMatchObject({
      completed: true,
      selectedProviders: ["openai"],
      blender: concurrentBlender
    });
  });

  it("preserves a concurrent installedAt-only change even when its timestamp is earlier", async () => {
    // Given
    const homePath = await tempHome("strongcode-state-blender-timestamp-");
    const verifiedBlender: InstalledBlenderIntegration = {
      ...installedBlender,
      installedAt: "2026-07-15T11:00:00.000Z"
    };
    const concurrentBlender: InstalledBlenderIntegration = {
      ...installedBlender,
      installedAt: "2026-07-15T08:00:00.000Z"
    };
    await saveSetupState(homePath, { ...initialState, blender: concurrentBlender });

    // When
    await mergeBlenderSetupResult(homePath, {
      status: "installed",
      originalBlender: installedBlender,
      state: { ...initialState, blender: verifiedBlender }
    });

    // Then
    expect((await loadSetupState(homePath)).blender).toEqual(concurrentBlender);
  });

  it("preserves concurrent Blender metadata deletion after setup starts", async () => {
    // Given
    const homePath = await tempHome("strongcode-state-blender-deletion-");
    const verifiedBlender: InstalledBlenderIntegration = {
      ...installedBlender,
      profileId: "blender-verified"
    };
    await saveSetupState(homePath, initialState);

    // When
    await mergeBlenderSetupResult(homePath, {
      status: "already-installed",
      originalBlender: installedBlender,
      state: { ...initialState, blender: verifiedBlender }
    });

    // Then
    expect((await loadSetupState(homePath)).blender).toBeUndefined();
  });

  it("restores verified Blender metadata when the original baseline is missing", async () => {
    // Given
    const homePath = await tempHome("strongcode-state-blender-missing-");
    await saveSetupState(homePath, initialState);

    // When
    await mergeBlenderSetupResult(homePath, {
      status: "already-installed",
      originalBlender: undefined,
      state: { ...initialState, blender: installedBlender }
    });

    // Then
    expect((await loadSetupState(homePath)).blender).toEqual(installedBlender);
  });
});
