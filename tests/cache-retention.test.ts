import { access, link, mkdir, mkdtemp, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { enforceHomeCacheRetention } from "../src/config/cache-retention";
import { ensureStrongCodeHome } from "../src/config/home";

const DAY_MS = 24 * 60 * 60 * 1_000;

async function expectMissing(targetPath: string): Promise<void> {
  await expect(access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("StrongCode home cache retention", () => {
  it("removes expired files and now-empty directories while preserving fresh entries", async () => {
    const homePath = await mkdtemp(path.join(os.tmpdir(), "strongcode-cache-retention-"));
    await ensureStrongCodeHome({ homePath });
    const nowMs = Date.UTC(2026, 6, 25);
    const expiredPath = path.join(homePath, "cache", "http", "expired", "old.json");
    const freshPath = path.join(homePath, "cache", "http", "fresh.json");
    await mkdir(path.dirname(expiredPath), { recursive: true });
    await writeFile(expiredPath, "old", "utf8");
    await writeFile(freshPath, "fresh", "utf8");
    await utimes(expiredPath, new Date(nowMs - 31 * DAY_MS), new Date(nowMs - 31 * DAY_MS));
    await utimes(freshPath, new Date(nowMs - 29 * DAY_MS), new Date(nowMs - 29 * DAY_MS));

    const result = await enforceHomeCacheRetention(homePath, nowMs);

    expect(result.removedFiles).toEqual(["cache/http/expired/old.json"]);
    expect(result.removedDirectories).toEqual(["cache/http/expired"]);
    await expectMissing(expiredPath);
    await expect(readFile(freshPath, "utf8")).resolves.toBe("fresh");
  });

  it("does not follow linked cache entries or delete hardlinked files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "strongcode-cache-retention-links-"));
    const homePath = path.join(root, "home");
    const externalPath = path.join(root, "external");
    await mkdir(homePath);
    await mkdir(externalPath);
    await ensureStrongCodeHome({ homePath });
    const sentinelPath = path.join(externalPath, "sentinel.txt");
    const hardlinkPath = path.join(homePath, "cache", "http", "hardlink.txt");
    const linkedDirectory = path.join(homePath, "cache", "http", "linked");
    await mkdir(path.dirname(hardlinkPath), { recursive: true });
    await writeFile(sentinelPath, "external", "utf8");
    await link(sentinelPath, hardlinkPath);
    await symlink(externalPath, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
    const nowMs = Date.UTC(2026, 6, 25);
    await utimes(sentinelPath, new Date(nowMs - 31 * DAY_MS), new Date(nowMs - 31 * DAY_MS));

    const result = await enforceHomeCacheRetention(homePath, nowMs);

    expect(result.skippedPaths).toEqual(["cache/http/hardlink.txt", "cache/http/linked"]);
    await expect(readFile(sentinelPath, "utf8")).resolves.toBe("external");
    await expect(readFile(hardlinkPath, "utf8")).resolves.toBe("external");
  });

  it("preserves cache contents when retention configuration is disabled or invalid", async () => {
    const homePath = await mkdtemp(path.join(os.tmpdir(), "strongcode-cache-retention-policy-"));
    await ensureStrongCodeHome({ homePath });
    const cachedPath = path.join(homePath, "cache", "http", "preserved.json");
    const policyPath = path.join(homePath, "config", "retention.json");
    const nowMs = Date.UTC(2026, 6, 25);
    await mkdir(path.dirname(cachedPath), { recursive: true });
    await mkdir(path.dirname(policyPath), { recursive: true });
    await writeFile(cachedPath, "preserved", "utf8");
    await utimes(cachedPath, new Date(nowMs - 365 * DAY_MS), new Date(nowMs - 365 * DAY_MS));

    await writeFile(policyPath, JSON.stringify({ version: 1, cacheDays: null }), "utf8");
    expect((await enforceHomeCacheRetention(homePath, nowMs)).removedFiles).toEqual([]);
    await writeFile(policyPath, JSON.stringify({ version: 1, cacheDays: "30" }), "utf8");
    const invalid = await enforceHomeCacheRetention(homePath, nowMs);

    expect(invalid.removedFiles).toEqual([]);
    expect(invalid.skippedPaths).toEqual(["config/retention.json"]);
    await expect(readFile(cachedPath, "utf8")).resolves.toBe("preserved");
  });
});
