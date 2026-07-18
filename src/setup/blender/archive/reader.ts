import { inflateRawSync } from "node:zlib";
import { crc32 } from "./crc32";
import { invalidArchive } from "./errors";
import type { SafeZipArchive, SafeZipEntry } from "./types";
import { parseZipRecords, type CompressedZipEntry } from "./zip-records";

export function readSafeZip(archive: Buffer): SafeZipArchive {
  const compressedEntries = parseZipRecords(archive);
  const entries = compressedEntries.map(entry => verifyEntry(entry));
  return { entries };
}

function verifyEntry(entry: CompressedZipEntry): SafeZipEntry {
  const content = decompress(entry);
  if (content.byteLength !== entry.uncompressedSize) invalidArchive("integrity", `ZIP size mismatch: ${entry.path.value}`);
  if (crc32(content) !== entry.crc32) invalidArchive("integrity", `ZIP CRC mismatch: ${entry.path.value}`);
  return { path: entry.path, content, method: entry.method, crc32: entry.crc32 };
}

function decompress(entry: CompressedZipEntry): Buffer {
  if (entry.method === 0) return Buffer.from(entry.compressed);
  try {
    return inflateRawSync(entry.compressed, { maxOutputLength: Math.max(1, entry.uncompressedSize) });
  } catch (error) {
    if (error instanceof Error) invalidArchive("integrity", `ZIP deflate stream is invalid: ${entry.path.value}`);
    throw error;
  }
}
