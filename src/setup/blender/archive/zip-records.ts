import { parseArchivePath, validatePathCollisions } from "./archive-path";
import { invalidArchive } from "./errors";
import type { ArchivePath, ZipMethod } from "./types";
import {
  DESCRIPTOR_FLAG,
  decodeZipName,
  parseZipMethod,
  validateZipComment,
  validateZipExtra,
  validateZipFeatures,
  validateZipFileType,
  validateZipSizes,
  ZIP_LIMITS
} from "./zip-policy";

const SIGNATURE = { local: 0x04034b50, central: 0x02014b50, end: 0x06054b50 } as const;

export type CompressedZipEntry = {
  readonly path: ArchivePath;
  readonly method: ZipMethod;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly compressed: Buffer;
};

type CentralEntry = Omit<CompressedZipEntry, "compressed"> & {
  readonly flags: number;
  readonly versionNeeded: number;
  readonly nameBytes: Buffer;
  readonly localOffset: number;
};

type EndRecord = {
  readonly offset: number;
  readonly centralOffset: number;
  readonly centralSize: number;
  readonly entries: number;
};

type LocalSpan = {
  readonly start: number;
  readonly end: number;
  readonly entry: CompressedZipEntry;
};

export function parseZipRecords(archive: Buffer): readonly CompressedZipEntry[] {
  const end = parseEndRecord(archive);
  const central = parseCentralDirectory(archive, end);
  validatePathCollisions(central.map(entry => entry.path));
  const spans = central.map(entry => parseLocalRecord(archive, entry, end.centralOffset)).sort((left, right) => left.start - right.start);
  let cursor = 0;
  for (const span of spans) {
    if (span.start !== cursor) invalidArchive("malformed", "ZIP local records overlap or leave unreferenced data");
    cursor = span.end;
  }
  if (cursor !== end.centralOffset) invalidArchive("malformed", "ZIP local records do not end at the central directory");
  return spans.map(span => span.entry);
}

function parseEndRecord(archive: Buffer): EndRecord {
  if (archive.byteLength < 22) invalidArchive("malformed", "ZIP end record is missing");
  const firstCandidate = Math.max(0, archive.byteLength - 65_557);
  const candidates: number[] = [];
  for (let offset = archive.byteLength - 22; offset >= firstCandidate; offset -= 1) {
    if (archive.readUInt32LE(offset) === SIGNATURE.end) {
      const commentLength = archive.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === archive.byteLength) candidates.push(offset);
    }
  }
  if (candidates.length !== 1) invalidArchive("malformed", "ZIP must contain one terminal end record");
  const offset = candidates[0] ?? invalidArchive("malformed", "ZIP end record is missing");
  const disk = archive.readUInt16LE(offset + 4);
  const centralDisk = archive.readUInt16LE(offset + 6);
  const diskEntries = archive.readUInt16LE(offset + 8);
  const entries = archive.readUInt16LE(offset + 10);
  const centralSize = archive.readUInt32LE(offset + 12);
  const centralOffset = archive.readUInt32LE(offset + 16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entries) invalidArchive("unsupported", "Multi-disk ZIP archives are unsupported");
  if (entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) invalidArchive("unsupported", "Zip64 archives are unsupported");
  if (offset >= 20 && archive.readUInt32LE(offset - 20) === 0x07064b50) invalidArchive("unsupported", "Zip64 locator is unsupported");
  if (entries > ZIP_LIMITS.entries) invalidArchive("limit", `ZIP contains more than ${ZIP_LIMITS.entries} entries`);
  if (centralOffset + centralSize !== offset) invalidArchive("malformed", "ZIP central directory bounds are inconsistent");
  return { offset, centralOffset, centralSize, entries };
}

function parseCentralDirectory(archive: Buffer, end: EndRecord): readonly CentralEntry[] {
  const entries: CentralEntry[] = [];
  let cursor = end.centralOffset;
  let totalSize = 0;
  for (let index = 0; index < end.entries; index += 1) {
    assertRange(archive, cursor, 46, "central record");
    if (archive.readUInt32LE(cursor) !== SIGNATURE.central) invalidArchive("malformed", "ZIP central record signature is invalid");
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    assertRange(archive, cursor, recordLength, "central record fields");
    if (archive.readUInt16LE(cursor + 34) !== 0) invalidArchive("unsupported", "Multi-disk ZIP entry is unsupported");
    const nameBytes = Buffer.from(archive.subarray(cursor + 46, cursor + 46 + nameLength));
    const flags = archive.readUInt16LE(cursor + 8);
    const method = parseZipMethod(archive.readUInt16LE(cursor + 10));
    const versionNeeded = archive.readUInt16LE(cursor + 6);
    validateZipFeatures(flags, method, versionNeeded);
    validateZipExtra(archive.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength));
    validateZipComment(archive.subarray(cursor + 46 + nameLength + extraLength, cursor + recordLength), flags);
    const path = parseArchivePath(decodeZipName(nameBytes, flags));
    validateZipFileType(path, archive.readUInt16LE(cursor + 4), archive.readUInt32LE(cursor + 38));
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    validateZipSizes(path, method, compressedSize, uncompressedSize);
    totalSize += uncompressedSize;
    if (totalSize > ZIP_LIMITS.totalSize) invalidArchive("limit", "ZIP total uncompressed size exceeds 128 MiB");
    entries.push({
      path,
      flags,
      method,
      versionNeeded,
      nameBytes,
      crc32: archive.readUInt32LE(cursor + 16),
      compressedSize,
      uncompressedSize,
      localOffset: archive.readUInt32LE(cursor + 42)
    });
    cursor += recordLength;
  }
  if (cursor !== end.centralOffset + end.centralSize) invalidArchive("malformed", "ZIP central directory size does not match its entries");
  return entries;
}

function parseLocalRecord(archive: Buffer, central: CentralEntry, centralOffset: number): LocalSpan {
  const start = central.localOffset;
  assertRange(archive, start, 30, "local record");
  if (archive.readUInt32LE(start) !== SIGNATURE.local) invalidArchive("malformed", "ZIP local record signature is invalid");
  const nameLength = archive.readUInt16LE(start + 26);
  const extraLength = archive.readUInt16LE(start + 28);
  const headerLength = 30 + nameLength + extraLength;
  assertRange(archive, start, headerLength, "local record fields");
  const localName = archive.subarray(start + 30, start + 30 + nameLength);
  if (!localName.equals(central.nameBytes)) invalidArchive("malformed", `ZIP local name differs for ${central.path.value}`);
  if (archive.readUInt16LE(start + 4) !== central.versionNeeded
    || archive.readUInt16LE(start + 6) !== central.flags
    || archive.readUInt16LE(start + 8) !== central.method) {
    invalidArchive("malformed", `ZIP local metadata differs for ${central.path.value}`);
  }
  validateZipExtra(archive.subarray(start + 30 + nameLength, start + headerLength));
  const dataStart = start + headerLength;
  const dataEnd = dataStart + central.compressedSize;
  if (dataEnd > centralOffset) invalidArchive("malformed", `ZIP data exceeds its local section: ${central.path.value}`);
  const descriptorEnd = validateLocalSizesAndDescriptor(archive, central, start, dataEnd, centralOffset);
  return {
    start,
    end: descriptorEnd,
    entry: {
      path: central.path,
      method: central.method,
      crc32: central.crc32,
      compressedSize: central.compressedSize,
      uncompressedSize: central.uncompressedSize,
      compressed: Buffer.from(archive.subarray(dataStart, dataEnd))
    }
  };
}

function validateLocalSizesAndDescriptor(archive: Buffer, central: CentralEntry, start: number, dataEnd: number, centralOffset: number): number {
  const localCrc = archive.readUInt32LE(start + 14);
  const localCompressed = archive.readUInt32LE(start + 18);
  const localUncompressed = archive.readUInt32LE(start + 22);
  if ((central.flags & DESCRIPTOR_FLAG) === 0) {
    if (localCrc !== central.crc32 || localCompressed !== central.compressedSize || localUncompressed !== central.uncompressedSize) {
      invalidArchive("malformed", `ZIP local sizes differ for ${central.path.value}`);
    }
    return dataEnd;
  }
  if (localCrc !== 0 || localCompressed !== 0 || localUncompressed !== 0) invalidArchive("malformed", "ZIP descriptor entry has populated local sizes");
  assertRange(archive, dataEnd, 12, "data descriptor");
  const signed = dataEnd + 16 <= centralOffset
    && archive.readUInt32LE(dataEnd) === 0x08074b50
    && archive.readUInt32LE(dataEnd + 4) === central.crc32
    && archive.readUInt32LE(dataEnd + 8) === central.compressedSize
    && archive.readUInt32LE(dataEnd + 12) === central.uncompressedSize;
  if (signed) return dataEnd + 16;
  if (archive.readUInt32LE(dataEnd) === central.crc32
    && archive.readUInt32LE(dataEnd + 4) === central.compressedSize
    && archive.readUInt32LE(dataEnd + 8) === central.uncompressedSize) return dataEnd + 12;
  invalidArchive("malformed", `ZIP data descriptor differs for ${central.path.value}`);
}

function assertRange(archive: Buffer, offset: number, length: number, label: string): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || offset + length > archive.byteLength) {
    invalidArchive("malformed", `ZIP ${label} is outside the archive`);
  }
}
