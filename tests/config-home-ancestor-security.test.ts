import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureStrongCodeHome, type StrongCodeHomeResult } from "../src/config/home";

const legacyConfigPath = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "strongcode-home-v7",
  "strongcode.config.yaml.fixture"
);

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function listing(directory: string): Promise<readonly string[]> {
  return (await readdir(directory, { recursive: true })).sort();
}

async function createDirectoryLink(target: string, linkedPath: string): Promise<void> {
  await symlink(target, linkedPath, process.platform === "win32" ? "junction" : "dir");
}

function expectNoPublication(result: StrongCodeHomeResult): void {
  expect(result.conflicts.length).toBeGreaterThan(0);
  expect(result.createdDirectories).toEqual([]);
  expect(result.createdFiles).toEqual([]);
  expect(result.upgradedFiles).toEqual([]);
}

describe("StrongCode home ancestor security", () => {
  it("creates no external files through a junction or symlink ancestor", async () => {
    // Given
    const root = await mkdtemp(path.join(os.tmpdir(), "strongcode-home-ancestor-"));
    const externalPath = path.join(root, "external");
    const linkedPath = path.join(root, "linked");
    const homePath = path.join(linkedPath, "strongcode");
    const sentinelPath = path.join(externalPath, "sentinel.bin");
    const sentinel = Buffer.from([0x00, 0x53, 0x74, 0x72, 0x6f, 0x6e, 0x67, 0xff]);
    await mkdir(externalPath);
    await writeFile(sentinelPath, sentinel);
    await createDirectoryLink(externalPath, linkedPath);
    const beforeListing = await listing(externalPath);
    const beforeHash = sha256(await readFile(sentinelPath));

    // When
    const result = await ensureStrongCodeHome({ homePath, expand: true });

    // Then
    expectNoPublication(result);
    expect(await listing(externalPath)).toEqual(beforeListing);
    expect(sha256(await readFile(sentinelPath))).toBe(beforeHash);
  });

  it("creates no external files through a linked home root", async () => {
    // Given
    const root = await mkdtemp(path.join(os.tmpdir(), "strongcode-home-root-link-"));
    const externalPath = path.join(root, "external");
    const homePath = path.join(root, "home");
    const sentinelPath = path.join(externalPath, "sentinel.bin");
    const sentinel = Buffer.from([0xff, 0x00, 0x7f, 0x53, 0x43]);
    await mkdir(externalPath);
    await writeFile(sentinelPath, sentinel);
    await createDirectoryLink(externalPath, homePath);
    const beforeListing = await listing(externalPath);
    const beforeHash = sha256(await readFile(sentinelPath));

    // When
    const result = await ensureStrongCodeHome({ homePath, expand: true });

    // Then
    expectNoPublication(result);
    expect(await listing(externalPath)).toEqual(beforeListing);
    expect(sha256(await readFile(sentinelPath))).toBe(beforeHash);
  });

  it("refuses to expand a hardlinked generated starter file", async () => {
    // Given
    const root = await mkdtemp(path.join(os.tmpdir(), "strongcode-home-hardlink-"));
    const homePath = path.join(root, "home");
    const externalPath = path.join(root, "external");
    const externalConfig = path.join(externalPath, "strongcode.config.yaml");
    const homeConfig = path.join(homePath, "strongcode.config.yaml");
    const legacyBytes = await readFile(legacyConfigPath);
    await mkdir(homePath);
    await mkdir(externalPath);
    await writeFile(externalConfig, legacyBytes);
    await link(externalConfig, homeConfig);
    expect((await lstat(homeConfig, { bigint: true })).nlink).toBe(2n);
    const beforeListing = await listing(externalPath);
    const beforeHash = sha256(await readFile(externalConfig));

    // When
    const result = await ensureStrongCodeHome({ homePath, expand: true });

    // Then
    expect(result.conflicts).toContainEqual(expect.objectContaining({ path: "strongcode.config.yaml" }));
    expect(result.upgradedFiles).not.toContain("strongcode.config.yaml");
    expect((await lstat(homeConfig, { bigint: true })).nlink).toBe(2n);
    expect(await listing(externalPath)).toEqual(beforeListing);
    expect(sha256(await readFile(externalConfig))).toBe(beforeHash);
    expect(await readFile(homeConfig)).toEqual(legacyBytes);
  });
});
