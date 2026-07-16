import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureStrongCodeHome } from "../src/config/home";
import { STRONGCODE_HOME_LAYOUT_VERSION, STRONGCODE_HOME_STARTER_FILES } from "../src/config/home-layout";

const fixtureDirectory = path.join(process.cwd(), "tests", "fixtures", "strongcode-home-v7");
const generatedFiles = [
  { name: "mcp.json", hash: "d7fb203472edf219daf70c1e3be7cf109adbca6becd8980362c3be2af32461dc" },
  { name: "strongcode.config.yaml", hash: "35d034f0269623f5465414cba15ea9d2c50ea37810843561292406e23f4c3bcd" },
  { name: "strongcode.json", hash: "f8572f1364acf862e7b9801ad736139df2798af790d966660d20b495fc661256" }
] as const;

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("StrongCode home migration", () => {
  it("expands authentic version-7 generated files to version 8", async () => {
    // Given
    const homePath = await mkdtemp(path.join(tmpdir(), "strongcode-home-v7-migration-"));
    for (const file of generatedFiles) {
      const content = await readFile(path.join(fixtureDirectory, file.name));
      expect(sha256(content)).toBe(file.hash);
      await writeFile(path.join(homePath, file.name), content);
    }

    // When
    const expanded = await ensureStrongCodeHome({ homePath, expand: true });

    // Then
    expect(STRONGCODE_HOME_LAYOUT_VERSION).toBe(8);
    expect([...expanded.upgradedFiles].sort()).toEqual(generatedFiles.map(file => file.name).sort());
    for (const file of generatedFiles) {
      const starter = STRONGCODE_HOME_STARTER_FILES[file.name];
      if (!starter) throw new Error(`Missing current starter file: ${file.name}`);
      await expect(readFile(path.join(homePath, file.name), "utf8")).resolves.toBe(starter.content);
    }
  });

  it("preserves customized bytes from an authentic version-7 generated file", async () => {
    // Given
    const homePath = await mkdtemp(path.join(tmpdir(), "strongcode-home-v7-custom-"));
    const fileName = "strongcode.config.yaml";
    const fixture = await readFile(path.join(fixtureDirectory, fileName));
    const customized = Buffer.concat([fixture, Buffer.from("# user customization\n")]);
    await writeFile(path.join(homePath, fileName), customized);

    // When
    const expanded = await ensureStrongCodeHome({ homePath, expand: true });

    // Then
    expect(expanded.preservedFiles).toContain(fileName);
    await expect(readFile(path.join(homePath, fileName))).resolves.toEqual(customized);
  });
});
