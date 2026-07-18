import { createHash } from "node:crypto";
import { z } from "zod";
import { readSafeZip, resolveArchiveRoot, type SafeZipArchive } from "./archive";

const manifestSchema = z.object({
  manifest_version: z.literal("0.4"),
  name: z.literal("Blender"),
  version: z.literal("1.0.0"),
  server: z.object({
    type: z.literal("uv"),
    entry_point: z.literal("blmcp/__init__.py")
  }).passthrough(),
  compatibility: z.object({ runtimes: z.object({ python: z.string() }).strict() }).strict()
}).passthrough();

const EXPECTED_DEPENDENCIES = ["docutils", "mcp", "pyyaml"] as const;

export type VerifiedOfficialProject = {
  readonly archive: Buffer;
  readonly root: string;
};

export type OfficialProjectIdentity = {
  readonly lockSource: { readonly path: string; readonly size: number; readonly sha256: string };
};

export class OfficialProjectError extends Error {
  readonly name = "OfficialProjectError";
}

export function validateOfficialProjectArchive(
  source: Buffer,
  catalog: OfficialProjectIdentity
): VerifiedOfficialProject {
  const archive = readSafeZip(source);
  const root = resolveArchiveRoot(archive, "pyproject.toml");
  const pyproject = readText(archive, root, "pyproject.toml");
  const lock = readBytes(archive, root, catalog.lockSource.path);
  const manifest = parseJson(readText(archive, root, "manifest.json"));

  if (lock.byteLength !== catalog.lockSource.size
    || createHash("sha256").update(lock).digest("hex") !== catalog.lockSource.sha256) {
    throw new OfficialProjectError("Official MCPB uv.lock does not match the catalog");
  }
  requirePyproject(pyproject);
  const parsedManifest = manifestSchema.safeParse(manifest);
  if (!parsedManifest.success || !/^>=\s*3\.10$/u.test(parsedManifest.data.compatibility.runtimes.python)) {
    throw new OfficialProjectError("Official MCPB manifest metadata is invalid");
  }
  return { archive: Buffer.from(source), root };
}

function requirePyproject(source: string): void {
  const name = /^name\s*=\s*"([^"]+)"\s*$/mu.exec(source)?.[1];
  const version = /^version\s*=\s*"([^"]+)"\s*$/mu.exec(source)?.[1];
  const python = /^requires-python\s*=\s*"([^"]+)"\s*$/mu.exec(source)?.[1];
  const entrypoint = /^blender-mcp\s*=\s*"([^"]+)"\s*$/mu.exec(source)?.[1];
  const dependencyBlock = /dependencies\s*=\s*\[([\s\S]*?)\]\s*\n\s*\[/u.exec(source)?.[1] ?? "";
  const dependencies = [...dependencyBlock.matchAll(/"([^"]+)"/gu)]
    .map(match => match[1]?.split(/[\[<>=]/u)[0])
    .filter((value): value is string => value !== undefined).sort();
  if (name !== "blender-mcp" || version !== "1.0.0" || python !== ">=3.10"
    || entrypoint !== "blmcp:main" || dependencies.join("\n") !== [...EXPECTED_DEPENDENCIES].sort().join("\n")) {
    throw new OfficialProjectError("Official MCPB pyproject metadata is invalid");
  }
}

function readBytes(archive: SafeZipArchive, root: string, name: string): Buffer {
  const expected = root ? `${root}/${name}` : name;
  const entry = archive.entries.find(candidate => !candidate.path.directory && candidate.path.value === expected);
  if (!entry) throw new OfficialProjectError(`Official MCPB is missing ${name}`);
  return entry.content;
}

function readText(archive: SafeZipArchive, root: string, name: string): string {
  return readBytes(archive, root, name).toString("utf8");
}

function parseJson(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch (error) {
    if (error instanceof SyntaxError) throw new OfficialProjectError("Official MCPB manifest.json is invalid JSON");
    throw error;
  }
}
