import { invalidArchive } from "./errors";
import type { ArchivePath, ZipMethod } from "./types";

export const ZIP_LIMITS = {
  entries: 5000,
  entrySize: 32 * 1024 * 1024,
  totalSize: 128 * 1024 * 1024,
  ratio: 100
} as const;

export const UTF8_FLAG = 0x0800;
export const DESCRIPTOR_FLAG = 0x0008;

export function parseZipMethod(method: number): ZipMethod {
  if (method !== 0 && method !== 8) invalidArchive("unsupported", `ZIP compression method ${method} is unsupported`);
  return method;
}

export function decodeZipName(name: Buffer, flags: number): string {
  if ((flags & UTF8_FLAG) === 0 && name.some(byte => byte >= 0x80)) invalidArchive("unsupported", "Non-ASCII legacy ZIP names are unsupported");
  return decodeUtf8(name, "entry name");
}

export function validateZipComment(comment: Buffer, flags: number): void {
  if ((flags & UTF8_FLAG) !== 0) decodeUtf8(comment, "entry comment");
}

export function validateZipFeatures(flags: number, method: ZipMethod, versionNeeded: number): void {
  if (versionNeeded > 20) invalidArchive("unsupported", "ZIP feature version is unsupported");
  const allowed = method === 8 ? UTF8_FLAG | DESCRIPTOR_FLAG | 0x0006 : UTF8_FLAG | DESCRIPTOR_FLAG;
  if ((flags & ~allowed) !== 0) invalidArchive("unsupported", "Encrypted or unsupported ZIP flags are present");
}

export function validateZipSizes(path: ArchivePath, method: ZipMethod, compressed: number, uncompressed: number): void {
  if (uncompressed > ZIP_LIMITS.entrySize) invalidArchive("limit", `ZIP entry size exceeds 32 MiB: ${path.value}`);
  if (uncompressed > compressed * ZIP_LIMITS.ratio) invalidArchive("limit", `ZIP entry exceeds the 100:1 ratio: ${path.value}`);
  if (method === 0 && compressed !== uncompressed) invalidArchive("malformed", `Stored ZIP sizes differ: ${path.value}`);
  if (path.directory && (compressed !== 0 || uncompressed !== 0)) invalidArchive("malformed", `ZIP directory contains data: ${path.value}`);
}

export function validateZipFileType(path: ArchivePath, versionMadeBy: number, attributes: number): void {
  const host = versionMadeBy >>> 8;
  if (host !== 0 && host !== 3 && host !== 10 && host !== 19) invalidArchive("unsupported", `ZIP host system is unsupported: ${host}`);
  if ((attributes & 0x0008) !== 0 || (attributes & 0x0400) !== 0) invalidArchive("unsupported", `ZIP special file attributes are unsupported: ${path.value}`);
  if (host === 3 || host === 19) {
    const fileType = (attributes >>> 16) & 0o170000;
    if (fileType !== 0 && fileType !== 0o040000 && fileType !== 0o100000) invalidArchive("unsupported", `ZIP special file type is unsupported: ${path.value}`);
    if ((fileType === 0o040000) !== path.directory) invalidArchive("malformed", `ZIP directory attributes disagree with its path: ${path.value}`);
  } else if (((attributes & 0x0010) !== 0) !== path.directory) {
    invalidArchive("malformed", `ZIP directory attributes disagree with its path: ${path.value}`);
  }
}

export function validateZipExtra(extra: Buffer): void {
  let cursor = 0;
  while (cursor < extra.byteLength) {
    if (cursor + 4 > extra.byteLength) invalidArchive("malformed", "ZIP extra field header is truncated");
    const id = extra.readUInt16LE(cursor);
    const size = extra.readUInt16LE(cursor + 2);
    if (cursor + 4 + size > extra.byteLength) invalidArchive("malformed", "ZIP extra field is truncated");
    if (id === 0x0001) invalidArchive("unsupported", "Zip64 extra data is unsupported");
    if (id === 0x9901) invalidArchive("unsupported", "ZIP AES encryption metadata is unsupported");
    if (id === 0x000d || id === 0x5855 || id === 0x756e) invalidArchive("unsupported", "ZIP Unix link metadata is unsupported");
    cursor += 4 + size;
  }
}

function decodeUtf8(content: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (error) {
    if (error instanceof TypeError) invalidArchive("malformed", `ZIP ${label} is not valid UTF-8`);
    throw error;
  }
}
