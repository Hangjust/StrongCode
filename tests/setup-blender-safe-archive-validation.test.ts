import {
  ArchiveValidationError,
  readSafeZip,
  resolveArchiveRoot
} from "../src/setup/blender/archive";
import { buildZip, zipExtra, type ZipFixtureEntry, ZIP_SIGNATURES } from "./zip-fixtures";

const manifest = (name = "blender_manifest.toml"): ZipFixtureEntry => ({ name, content: "schema_version = \"1.0.0\"\n" });
const unixAttributes = (mode: number): number => (mode << 16) >>> 0;

describe("safe Blender ZIP path validation", () => {
  it.each([
    ["parent traversal", "../escape.py"],
    ["absolute path", "/escape.py"],
    ["UNC path", "//server/share.py"],
    ["drive path", "C:/escape.py"],
    ["backslash confusion", "safe\\..\\escape.py"],
    ["alternate data stream", "safe.py:payload"],
    ["control character", "safe\u0001.py"],
    ["reserved device", "con.txt"],
    ["reserved nested device", "safe/AUX.py"],
    ["trailing dot", "safe/file."],
    ["trailing space", "safe/file "],
    ["empty segment", "safe//file.py"],
    ["current segment", "safe/./file.py"]
  ])("rejects %s before yielding archive entries", (_label, unsafePath) => {
    // Given
    const archive = buildZip([manifest(), { name: unsafePath, content: "unsafe" }]);

    // When / Then
    expect(() => readSafeZip(archive)).toThrow(ArchiveValidationError);
  });

  it.each([
    ["case-folded duplicate", [{ name: "Addon.py" }, { name: "addon.py" }]],
    ["Unicode-normalized duplicate", [{ name: "caf\u00e9.py" }, { name: "cafe\u0301.py" }]],
    ["file-directory prefix", [{ name: "addon", content: "file" }, { name: "addon/code.py" }]],
    ["directory-file identity", [{ name: "addon/" }, { name: "ADDON", content: "file" }]]
  ])("rejects %s collisions", (_label, conflicting) => {
    // Given
    const archive = buildZip([manifest(), ...conflicting]);

    // When / Then
    expect(() => readSafeZip(archive)).toThrow(/collision|duplicate/i);
  });
});

describe("safe Blender ZIP record validation", () => {
  it.each([
    ["symbolic link", 0o120777],
    ["character device", 0o020666],
    ["block device", 0o060660],
    ["FIFO", 0o010644],
    ["socket", 0o140777]
  ])("rejects a Unix %s entry", (_label, mode) => {
    // Given
    const archive = buildZip([manifest(), { name: "special", externalAttributes: unixAttributes(mode) }]);

    // When / Then
    expect(() => readSafeZip(archive)).toThrow(/file type|special/i);
  });

  it.each([
    ["traditional encryption", { flags: 0x0801 }],
    ["strong encryption", { flags: 0x0841 }],
    ["unsupported compression", { method: 12 }],
    ["unsupported feature version", { versionNeeded: 45 }],
    ["Zip64 extra data", { centralExtra: zipExtra(0x0001) }],
    ["local Zip64 extra data", { localExtra: zipExtra(0x0001) }],
    ["AES extra data", { centralExtra: zipExtra(0x9901) }],
    ["Unix hard-link metadata", { centralExtra: zipExtra(0x000d) }],
    ["Windows reparse point", { versionMadeBy: 0x0a14, externalAttributes: 0x0400 }],
    ["DOS volume label", { versionMadeBy: 0x0014, externalAttributes: 0x0008 }],
    ["unknown host attributes", { versionMadeBy: 0x0714 }],
    ["unsupported flag", { flags: 0x0810 }]
  ])("rejects %s", (_label, fields) => {
    // Given
    const archive = buildZip([manifest(), { name: "payload.py", content: "data", ...fields }]);

    // When / Then
    expect(() => readSafeZip(archive)).toThrow(ArchiveValidationError);
  });

  it("rejects malformed EOCD, central, and local records", () => {
    // Given
    const valid = buildZip([manifest()]);
    const truncated = valid.subarray(0, valid.byteLength - 1);
    const wrongCount = Buffer.from(valid);
    wrongCount.writeUInt16LE(2, signatureOffset(wrongCount, ZIP_SIGNATURES.end) + 10);
    const wrongLocalName = buildZip([{ ...manifest(), localName: "different.toml" }]);
    const wrongLocalFlags = Buffer.from(valid);
    wrongLocalFlags.writeUInt16LE(0, signatureOffset(wrongLocalFlags, ZIP_SIGNATURES.local) + 6);

    // When / Then
    for (const archive of [Buffer.alloc(3), truncated, wrongCount, wrongLocalName, wrongLocalFlags]) {
      expect(() => readSafeZip(archive)).toThrow(ArchiveValidationError);
    }
  });

  it("rejects content whose CRC does not match the central record", () => {
    // Given
    const archive = buildZip([manifest(), { name: "payload.py", content: "verified bytes", crc32: 0 }]);

    // When / Then
    expect(() => readSafeZip(archive)).toThrow(/CRC/i);
  });
});

describe("safe Blender ZIP resource limits", () => {
  it("rejects more than 5000 entries", () => {
    // Given
    const entries = Array.from({ length: 5001 }, (_, index) => ({ name: `files/${index}.txt` }));

    // When / Then
    expect(() => readSafeZip(buildZip(entries))).toThrow(/5000|entries/i);
  });

  it.each([
    ["per-entry size", [{ ...manifest(), uncompressedSize: 32 * 1024 * 1024 + 1 }]],
    ["total size", Array.from({ length: 5 }, (_, index) => ({ name: `file-${index}`, compressedSize: 1024 * 1024, uncompressedSize: 32 * 1024 * 1024 }))],
    ["compression ratio", [{ ...manifest(), compressedSize: 1, uncompressedSize: 101 }]]
  ])("rejects the %s limit before inflation", (_label, entries) => {
    // Given
    const archive = buildZip(entries);

    // When / Then
    expect(() => readSafeZip(archive)).toThrow(/size|ratio|limit/i);
  });
});

describe("Blender archive root resolution", () => {
  it.each([
    ["archive root", [manifest()], ""],
    ["sole wrapper", [manifest("bundle/blender_manifest.toml"), { name: "bundle/__init__.py" }], "bundle"]
  ])("resolves a manifest at the %s deterministically", (_label, entries, expected) => {
    // Given
    const archive = readSafeZip(buildZip(entries));

    // When
    const root = resolveArchiveRoot(archive, "blender_manifest.toml");

    // Then
    expect(root).toBe(expected);
  });

  it.each([
    ["missing manifest", [{ name: "addon.py" }]],
    ["root and wrapper manifests", [manifest(), manifest("wrapper/blender_manifest.toml")]],
    ["multiple wrappers", [manifest("one/blender_manifest.toml"), manifest("two/blender_manifest.toml")]],
    ["wrapper with sibling", [manifest("wrapper/blender_manifest.toml"), { name: "sibling.txt" }]]
  ])("rejects an ambiguous %s layout", (_label, entries) => {
    // Given
    const archive = readSafeZip(buildZip(entries));

    // When / Then
    expect(() => resolveArchiveRoot(archive, "blender_manifest.toml")).toThrow(/root|manifest|wrapper/i);
  });
});

function signatureOffset(archive: Buffer, signature: number): number {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(signature);
  return archive.indexOf(bytes);
}
