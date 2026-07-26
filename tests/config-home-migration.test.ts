import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureStrongCodeHome } from "../src/config/home";
import { STRONGCODE_HOME_LAYOUT_VERSION, STRONGCODE_HOME_LEGACY_HASHES, STRONGCODE_HOME_STARTER_FILES } from "../src/config/home-layout";

type GeneratedFixture = {
  readonly name: "mcp.json" | "strongcode.config.yaml" | "strongcode.json";
  readonly fixtureName: string;
  readonly hash: string;
};

const fixturesByVersion = {
  7: [
    { name: "mcp.json", fixtureName: "mcp.json", hash: "d7fb203472edf219daf70c1e3be7cf109adbca6becd8980362c3be2af32461dc" },
    { name: "strongcode.config.yaml", fixtureName: "strongcode.config.yaml.fixture", hash: "35d034f0269623f5465414cba15ea9d2c50ea37810843561292406e23f4c3bcd" },
    { name: "strongcode.json", fixtureName: "strongcode.json", hash: "f8572f1364acf862e7b9801ad736139df2798af790d966660d20b495fc661256" }
  ],
  8: [
    { name: "mcp.json", fixtureName: "mcp.json.fixture", hash: "711bbf5ed3e93f42c4f8cd2317bbadf88b66f12a74634eeaf57d020f0f9c0c5e" },
    { name: "strongcode.config.yaml", fixtureName: "strongcode.config.yaml.fixture", hash: "2f0c5f99420b8cea0eae385b71ac295990f04f469fed2f96d785e3a5e5d695c6" },
    { name: "strongcode.json", fixtureName: "strongcode.json.fixture", hash: "0571815cce8fa3f1e06758bd5847d2bc4a845b5f3abf862ad4a626c7878c443d" }
  ]
} as const satisfies Record<number, readonly GeneratedFixture[]>;

const temporaryHomes = new Set<string>();

afterEach(async () => {
  await Promise.all([...temporaryHomes].map(homePath => rm(homePath, { recursive: true, force: true })));
  temporaryHomes.clear();
});

async function createTemporaryHome(prefix: string): Promise<string> {
  const homePath = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryHomes.add(homePath);
  return homePath;
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function fixtureBytes(version: keyof typeof fixturesByVersion, fixture: GeneratedFixture): Promise<Buffer> {
  const content = await readFile(path.join(process.cwd(), "tests", "fixtures", `strongcode-home-v${version}`, fixture.fixtureName));
  const actual = sha256(content);
  if (actual !== fixture.hash) {
    throw new Error(`Fixture SHA mismatch for v${version}/${fixture.fixtureName}: expected ${fixture.hash}, got ${actual}`);
  }
  return content;
}

async function seedGeneratedHome(homePath: string, version: keyof typeof fixturesByVersion): Promise<Map<string, Buffer>> {
  const seeded = new Map<string, Buffer>();
  for (const fixture of fixturesByVersion[version]) {
    const content = await fixtureBytes(version, fixture);
    await writeFile(path.join(homePath, fixture.name), content);
    seeded.set(fixture.name, content);
  }
  return seeded;
}

async function expectCurrentStarters(homePath: string): Promise<void> {
  for (const fixture of fixturesByVersion[8]) {
    const starter = STRONGCODE_HOME_STARTER_FILES[fixture.name];
    if (!starter) throw new Error(`Missing current starter file: ${fixture.name}`);
    await expect(readFile(path.join(homePath, fixture.name), "utf8")).resolves.toBe(starter.content);
  }
}

describe("StrongCode home migration", () => {
  it("authenticates every declared migration fixture", async () => {
    // Given / When / Then
    for (const version of [7, 8] as const) {
      for (const fixture of fixturesByVersion[version]) {
        expect(sha256(await fixtureBytes(version, fixture))).toBe(fixture.hash);
      }
    }
  });

  it("rejects a migration fixture whose declared SHA is wrong", async () => {
    // Given
    const fixture = fixturesByVersion[7][0];
    const expected = "0".repeat(64);

    // When / Then
    await expect(fixtureBytes(7, { ...fixture, hash: expected })).rejects.toThrow(
      `Fixture SHA mismatch for v7/${fixture.fixtureName}: expected ${expected}, got ${fixture.hash}`
    );
  });

  it("retains old hashes and appends exact version-9 generated file hashes", () => {
    // Given
    const expected = {
      "mcp.json": [
        "d4f41040dd1622f1b5f936d9b6705372ec2eaf85625535dddbd903112954e4ad",
        "d7fb203472edf219daf70c1e3be7cf109adbca6becd8980362c3be2af32461dc",
        "711bbf5ed3e93f42c4f8cd2317bbadf88b66f12a74634eeaf57d020f0f9c0c5e"
      ],
      "strongcode.config.yaml": [
        "17091f5d52c5f0ef41a0d1a149a41c446b133e2c7eefef02e8de8104f7aa9dac",
        "35d034f0269623f5465414cba15ea9d2c50ea37810843561292406e23f4c3bcd",
        "2f0c5f99420b8cea0eae385b71ac295990f04f469fed2f96d785e3a5e5d695c6"
      ],
      "strongcode.json": [
        "957744f1fd1bec68d0218cd358bc95a84940c7557acf8b6a76c411702d5f7d31",
        "733bffba3e4633a4aeeacfbeee07cfee1a38979026edb0c31ec16fd2152b65b8",
        "4410f3f81cd2e96628be1cfe2c1f5bb33a4a275c7ef5b60b8ac56eb99d08a38c",
        "f8572f1364acf862e7b9801ad736139df2798af790d966660d20b495fc661256",
        "0571815cce8fa3f1e06758bd5847d2bc4a845b5f3abf862ad4a626c7878c443d",
        "1ebf9a41e9fad0aba15b5cb7c9dabd68190b1aa276ead2c6f1c604ba2b2d0213"
      ]
    } as const;

    // When
    const mcpHashes = STRONGCODE_HOME_LEGACY_HASHES["mcp.json"];
    const configHashes = STRONGCODE_HOME_LEGACY_HASHES["strongcode.config.yaml"];
    const homeHashes = STRONGCODE_HOME_LEGACY_HASHES["strongcode.json"];

    // Then
    expect(mcpHashes).toEqual(expected["mcp.json"]);
    expect(configHashes).toEqual(expected["strongcode.config.yaml"]);
    expect(homeHashes).toEqual(expected["strongcode.json"]);
  });

  it("upgrades untouched version-8 bytes only during explicit expansion", async () => {
    // Given
    const homePath = await createTemporaryHome("strongcode-home-v8-expand-");
    await seedGeneratedHome(homePath, 8);

    // When
    const expanded = await ensureStrongCodeHome({ homePath, expand: true });

    // Then
    expect(STRONGCODE_HOME_LAYOUT_VERSION).toBe(10);
    expect(expanded.upgradedFiles).toEqual(fixturesByVersion[8].map(fixture => fixture.name).sort());
    await expectCurrentStarters(homePath);
  });

  it("leaves version-8 bytes unchanged without explicit expansion", async () => {
    // Given
    const homePath = await createTemporaryHome("strongcode-home-v8-no-expand-");
    const original = await seedGeneratedHome(homePath, 8);

    // When
    const result = await ensureStrongCodeHome({ homePath });

    // Then
    expect(result.upgradedFiles).toEqual([]);
    for (const [fileName, content] of original) {
      await expect(readFile(path.join(homePath, fileName))).resolves.toEqual(content);
    }
  });

  it("preserves customized version-8 siblings byte-for-byte", async () => {
    // Given
    const homePath = await createTemporaryHome("strongcode-home-v8-custom-");
    const customized = new Map<string, Buffer>();
    for (const fixture of fixturesByVersion[8]) {
      const content = Buffer.concat([await fixtureBytes(8, fixture), Buffer.from(`# customized ${fixture.name}\n`)]);
      await writeFile(path.join(homePath, fixture.name), content);
      customized.set(fixture.name, content);
    }

    // When
    const expanded = await ensureStrongCodeHome({ homePath, expand: true });

    // Then
    expect(expanded.preservedFiles).toEqual(fixturesByVersion[8].map(fixture => fixture.name).sort());
    for (const [fileName, content] of customized) {
      await expect(readFile(path.join(homePath, fileName))).resolves.toEqual(content);
    }
  });

  it("upgrades only untouched files in a mixed version-8 home", async () => {
    // Given
    const homePath = await createTemporaryHome("strongcode-home-v8-mixed-");
    await seedGeneratedHome(homePath, 8);
    const customPath = path.join(homePath, "strongcode.config.yaml");
    const customized = Buffer.concat([await readFile(customPath), Buffer.from("# keep me\n")]);
    await writeFile(customPath, customized);

    // When
    const expanded = await ensureStrongCodeHome({ homePath, expand: true });

    // Then
    expect(expanded.upgradedFiles).toEqual(["mcp.json", "strongcode.json"]);
    expect(expanded.preservedFiles).toContain("strongcode.config.yaml");
    await expect(readFile(customPath)).resolves.toEqual(customized);
  });

  it("upgrades authentic version-7 files directly to version 10", async () => {
    // Given
    const homePath = await createTemporaryHome("strongcode-home-v7-direct-");
    await seedGeneratedHome(homePath, 7);

    // When
    const expanded = await ensureStrongCodeHome({ homePath, expand: true });

    // Then
    expect(expanded.upgradedFiles).toEqual(fixturesByVersion[7].map(fixture => fixture.name).sort());
    await expectCurrentStarters(homePath);
  });

  it("preserves a customized version-7 strongcode.config.yaml byte-for-byte", async () => {
    // Given
    const homePath = await createTemporaryHome("strongcode-home-v7-custom-config-");
    await seedGeneratedHome(homePath, 7);
    const configPath = path.join(homePath, "strongcode.config.yaml");
    const customized = Buffer.concat([await readFile(configPath), Buffer.from("# keep version 7 customization\n")]);
    await writeFile(configPath, customized);

    // When
    const expanded = await ensureStrongCodeHome({ homePath, expand: true });

    // Then
    expect(expanded.upgradedFiles).toEqual(["mcp.json", "strongcode.json"]);
    expect(expanded.preservedFiles).toContain("strongcode.config.yaml");
    await expect(readFile(configPath)).resolves.toEqual(customized);
  });

  it("is idempotent after a version-8 expansion", async () => {
    // Given
    const homePath = await createTemporaryHome("strongcode-home-v8-repeat-");
    await seedGeneratedHome(homePath, 8);
    const first = await ensureStrongCodeHome({ homePath, expand: true });

    // When
    const second = await ensureStrongCodeHome({ homePath, expand: true });

    // Then
    expect(first.upgradedFiles).toEqual(fixturesByVersion[8].map(fixture => fixture.name).sort());
    expect(second.upgradedFiles).toEqual([]);
    expect(second.preservedFiles).toEqual([]);
    await expectCurrentStarters(homePath);
  });
});
