import { invalidArchive } from "./errors";
import type { ArchivePath } from "./types";

const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const DRIVE_PATH = /^[A-Za-z]:/u;

export function parseArchivePath(value: string): ArchivePath {
  if (value.length === 0) invalidArchive("unsafe-path", "Archive entry path is empty");
  if (value.includes("\\")) invalidArchive("unsafe-path", `Archive entry uses a backslash: ${value}`);
  if (value.startsWith("/") || DRIVE_PATH.test(value)) invalidArchive("unsafe-path", `Archive entry is absolute: ${value}`);
  if (value.includes(":")) invalidArchive("unsafe-path", `Archive entry uses a drive or alternate stream: ${value}`);
  if (CONTROL_CHARACTER.test(value)) invalidArchive("unsafe-path", "Archive entry path contains a control character");

  const directory = value.endsWith("/");
  const withoutTerminator = directory ? value.slice(0, -1) : value;
  const segments = withoutTerminator.split("/");
  if (segments.length === 0 || segments.some(segment => segment.length === 0)) {
    invalidArchive("unsafe-path", `Archive entry has an empty path component: ${value}`);
  }
  for (const segment of segments) validateSegment(segment, value);
  const normalized = segments.map(segment => segment.normalize("NFC"));
  const collisionKey = normalized.map(segment => segment.toUpperCase().toLowerCase()).join("/");
  return { value: normalized.join("/"), segments: normalized, collisionKey, directory };
}

export function validatePathCollisions(paths: readonly ArchivePath[]): void {
  const known = new Map<string, ArchivePath>();
  for (const current of paths) {
    if (known.has(current.collisionKey)) invalidArchive("collision", `Duplicate archive path: ${current.value}`);
    for (let length = 1; length < current.segments.length; length += 1) {
      const prefix = current.segments.slice(0, length).map(segment => segment.toUpperCase().toLowerCase()).join("/");
      const ancestor = known.get(prefix);
      if (ancestor && !ancestor.directory) invalidArchive("collision", `Path collision has a file parent: ${ancestor.value}`);
    }
    if (!current.directory) {
      const childPrefix = `${current.collisionKey}/`;
      for (const [key] of known) {
        if (key.startsWith(childPrefix)) invalidArchive("collision", `Path collision has a file over an existing directory: ${current.value}`);
      }
    }
    known.set(current.collisionKey, current);
  }
}

function validateSegment(segment: string, fullPath: string): void {
  if (segment === "." || segment === "..") invalidArchive("unsafe-path", `Archive entry traverses directories: ${fullPath}`);
  if (segment.endsWith(".") || segment.endsWith(" ")) {
    invalidArchive("unsafe-path", `Archive path component has a trailing dot or space: ${fullPath}`);
  }
  const stem = segment.split(".", 1)[0] ?? "";
  if (WINDOWS_RESERVED_NAME.test(stem)) invalidArchive("unsafe-path", `Archive path uses a reserved device name: ${fullPath}`);
}
