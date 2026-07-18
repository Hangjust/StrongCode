import { invalidArchive } from "./errors";
import type { RequiredArchiveManifest, SafeZipArchive } from "./types";

export function resolveArchiveRoot(archive: SafeZipArchive, requiredManifest: RequiredArchiveManifest): string {
  const files = archive.entries.filter(entry => !entry.path.directory);
  const candidates = files.filter(entry => {
    const segments = entry.path.segments;
    return segments.length <= 2 && segments.at(-1) === requiredManifest;
  });
  if (candidates.length !== 1) invalidArchive("ambiguous-root", `Archive must contain one eligible ${requiredManifest}`);
  const candidate = candidates[0] ?? invalidArchive("ambiguous-root", `Archive is missing ${requiredManifest}`);
  if (candidate.path.segments.length === 1) return "";
  const wrapper = candidate.path.segments[0] ?? invalidArchive("ambiguous-root", "Archive wrapper is missing");
  if (archive.entries.some(entry => entry.path.segments[0] !== wrapper)) {
    invalidArchive("ambiguous-root", "Archive wrapper directory is not the sole root");
  }
  return wrapper;
}
