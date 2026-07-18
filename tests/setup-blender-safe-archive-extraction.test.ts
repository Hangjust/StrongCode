import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  extractSafeArchive,
  type SafeArchiveFileSystem
} from "../src/setup/blender/archive";
import { buildZip } from "./zip-fixtures";

describe("safe Blender archive extraction", () => {
  it.each([
    ["stored add-on ZIP", 0, "blender_manifest.toml", ""],
    ["deflated MCPB wrapper", 8, "pyproject.toml", "package"]
  ] as const)("extracts a valid %s only into a fresh staging directory", async (_label, method, requiredManifest, wrapper) => {
    // Given
    const parent = await mkdtemp(path.join(tmpdir(), "strongcode-archive-parent-"));
    const prefix = wrapper ? `${wrapper}/` : "";
    const archive = buildZip([
      ...(wrapper ? [{ name: prefix }, { name: `${prefix}src/` }] : [{ name: "src/" }]),
      { name: `${prefix}${requiredManifest}`, content: "[project]\nname = \"blender-mcp\"\n", method },
      { name: `${prefix}src/server.py`, content: "print('ready')\n", method, flags: 0x0808, descriptorSignature: method === 0 }
    ]);

    // When
    const result = await extractSafeArchive({ archive, parentDirectory: parent, requiredManifest });

    // Then
    expect(path.dirname(result.stagingPath)).toBe(parent);
    expect(result.contentRoot).toBe(wrapper ? path.join(result.stagingPath, wrapper) : result.stagingPath);
    expect(await readFile(path.join(result.contentRoot, "src", "server.py"), "utf8")).toBe("print('ready')\n");
    expect(await readdir(parent)).toEqual([path.basename(result.stagingPath)]);
  });

  it("verifies every entry before creating a staging directory", async () => {
    // Given
    const parent = await mkdtemp(path.join(tmpdir(), "strongcode-archive-verify-first-"));
    const archive = buildZip([
      { name: "blender_manifest.toml", content: "valid" },
      { name: "payload.py", content: "tampered", crc32: 0 }
    ]);

    // When / Then
    await expect(extractSafeArchive({ archive, parentDirectory: parent, requiredManifest: "blender_manifest.toml" })).rejects.toThrow(/CRC/i);
    expect(await readdir(parent)).toEqual([]);
  });

  it("removes the staging tree when an exclusive write fails", async () => {
    // Given
    const parent = await mkdtemp(path.join(tmpdir(), "strongcode-archive-cleanup-"));
    let stagingPath = "";
    const files: SafeArchiveFileSystem = {
      async createStagingDirectory(parentDirectory) {
        stagingPath = await mkdtemp(path.join(parentDirectory, ".archive-test-"));
        return stagingPath;
      },
      async createDirectory(directoryPath) {
        await mkdir(directoryPath, { recursive: true });
      },
      async writeExclusive() {
        throw new FixtureWriteError();
      },
      async removeTree(filePath) {
        await rm(filePath, { recursive: true, force: true });
      }
    };
    const archive = buildZip([{ name: "pyproject.toml", content: "[project]\n" }]);

    // When / Then
    await expect(extractSafeArchive({ archive, parentDirectory: parent, requiredManifest: "pyproject.toml", files })).rejects.toThrow(FixtureWriteError);
    expect(stagingPath).not.toBe("");
    expect(await readdir(parent)).toEqual([]);
  });
});

class FixtureWriteError extends Error {
  readonly name = "FixtureWriteError";
}
