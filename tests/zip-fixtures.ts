import { deflateRawSync } from "node:zlib";

export const ZIP_SIGNATURES = {
  local: 0x04034b50,
  central: 0x02014b50,
  end: 0x06054b50
} as const;

export type ZipFixtureEntry = {
  readonly name: string;
  readonly content?: string | Buffer;
  readonly method?: number;
  readonly flags?: number;
  readonly descriptorSignature?: boolean;
  readonly versionMadeBy?: number;
  readonly versionNeeded?: number;
  readonly externalAttributes?: number;
  readonly localName?: string;
  readonly centralExtra?: Buffer;
  readonly localExtra?: Buffer;
  readonly crc32?: number;
  readonly compressedSize?: number;
  readonly uncompressedSize?: number;
};

type BuiltEntry = {
  readonly source: ZipFixtureEntry;
  readonly name: Buffer;
  readonly localName: Buffer;
  readonly compressed: Buffer;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly flags: number;
  readonly method: number;
  readonly versionNeeded: number;
  readonly localOffset: number;
};

export function zipExtra(id: number, content = Buffer.alloc(0)): Buffer {
  const field = Buffer.alloc(4 + content.byteLength);
  field.writeUInt16LE(id, 0);
  field.writeUInt16LE(content.byteLength, 2);
  content.copy(field, 4);
  return field;
}

export function buildZip(entries: readonly ZipFixtureEntry[]): Buffer {
  const localRecords: Buffer[] = [];
  const built: BuiltEntry[] = [];
  let localOffset = 0;

  for (const source of entries) {
    const content = typeof source.content === "string"
      ? Buffer.from(source.content)
      : source.content ?? Buffer.alloc(0);
    const method = source.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(content) : content;
    const flags = source.flags ?? 0x0800;
    const name = Buffer.from(source.name);
    const localName = Buffer.from(source.localName ?? source.name);
    const localExtra = source.localExtra ?? Buffer.alloc(0);
    const crc = source.crc32 ?? fixtureCrc32(content);
    const compressedSize = source.compressedSize ?? compressed.byteLength;
    const uncompressedSize = source.uncompressedSize ?? content.byteLength;
    const versionNeeded = source.versionNeeded ?? (method === 8 ? 20 : 10);
    const local = Buffer.alloc(30 + localName.byteLength + localExtra.byteLength);
    local.writeUInt32LE(ZIP_SIGNATURES.local, 0);
    local.writeUInt16LE(versionNeeded, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE((flags & 0x0008) === 0 ? crc : 0, 14);
    local.writeUInt32LE((flags & 0x0008) === 0 ? compressedSize : 0, 18);
    local.writeUInt32LE((flags & 0x0008) === 0 ? uncompressedSize : 0, 22);
    local.writeUInt16LE(localName.byteLength, 26);
    local.writeUInt16LE(localExtra.byteLength, 28);
    localName.copy(local, 30);
    localExtra.copy(local, 30 + localName.byteLength);
    const descriptor = (flags & 0x0008) === 0
      ? Buffer.alloc(0)
      : dataDescriptor(crc, compressedSize, uncompressedSize, source.descriptorSignature ?? true);
    localRecords.push(local, compressed, descriptor);
    built.push({
      source,
      name,
      localName,
      compressed,
      crc32: crc,
      compressedSize,
      uncompressedSize,
      flags,
      method,
      versionNeeded,
      localOffset
    });
    localOffset += local.byteLength + compressed.byteLength + descriptor.byteLength;
  }

  const centralRecords = built.map(entry => centralRecord(entry));
  const centralSize = centralRecords.reduce((total, record) => total + record.byteLength, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_SIGNATURES.end, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localRecords, ...centralRecords, end]);
}

function centralRecord(entry: BuiltEntry): Buffer {
  const extra = entry.source.centralExtra ?? Buffer.alloc(0);
  const record = Buffer.alloc(46 + entry.name.byteLength + extra.byteLength);
  const directory = entry.source.name.endsWith("/");
  const defaultMode = directory ? 0o040755 : 0o100644;
  record.writeUInt32LE(ZIP_SIGNATURES.central, 0);
  record.writeUInt16LE(entry.source.versionMadeBy ?? 0x0314, 4);
  record.writeUInt16LE(entry.versionNeeded, 6);
  record.writeUInt16LE(entry.flags, 8);
  record.writeUInt16LE(entry.method, 10);
  record.writeUInt32LE(entry.crc32, 16);
  record.writeUInt32LE(entry.compressedSize, 20);
  record.writeUInt32LE(entry.uncompressedSize, 24);
  record.writeUInt16LE(entry.name.byteLength, 28);
  record.writeUInt16LE(extra.byteLength, 30);
  record.writeUInt32LE(entry.source.externalAttributes ?? ((defaultMode << 16) >>> 0), 38);
  record.writeUInt32LE(entry.localOffset, 42);
  entry.name.copy(record, 46);
  extra.copy(record, 46 + entry.name.byteLength);
  return record;
}

function dataDescriptor(crc: number, compressedSize: number, uncompressedSize: number, signature: boolean): Buffer {
  const descriptor = Buffer.alloc(signature ? 16 : 12);
  const offset = signature ? 4 : 0;
  if (signature) descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(crc, offset);
  descriptor.writeUInt32LE(compressedSize, offset + 4);
  descriptor.writeUInt32LE(uncompressedSize, offset + 8);
  return descriptor;
}

function fixtureCrc32(content: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb88320);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
