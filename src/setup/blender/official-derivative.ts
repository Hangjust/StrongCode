import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { BlenderInstallError, sha256 } from "./durable-fs";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  upstream: z.object({ repository: z.literal("https://projects.blender.org/lab/blender_mcp"),
    commit: z.literal("03004fd0216bfe5e0a3d9ac9b47d5efadc3d78c4"), version: z.literal("1.0.0") }).strict(),
  upstreamSources: z.object({ runtimeConnectionSha256: hashSchema, addonServerSha256: hashSchema,
    addonInitSha256: hashSchema }).strict(),
  assets: z.object({ authenticationSha256: hashSchema, connectionSha256: hashSchema,
    addonPatchesSha256: hashSchema, licenseSha256: hashSchema }).strict(),
  derivativeSources: z.object({ runtimeConnectionSha256: hashSchema, authenticationSha256: hashSchema,
    addonServerSha256: hashSchema, addonInitSha256: hashSchema }).strict()
}).strict();
const replacementSchema = z.object({ before: z.string().min(1), after: z.string() }).strict();
const patchFileSchema = z.object({ path: z.enum(["mcp_to_blender_server.py", "__init__.py"]),
  upstreamSha256: hashSchema, replacements: z.array(replacementSchema).min(1) }).strict();
const patchesSchema = z.object({ schemaVersion: z.literal(1), files: z.array(patchFileSchema).length(2) }).strict();

export type OfficialDerivativeIdentity = z.infer<typeof manifestSchema>;

export async function readOfficialDerivativeIdentity(rootPath: string): Promise<OfficialDerivativeIdentity> {
  const root = path.resolve(rootPath);
  const manifest = manifestSchema.parse(JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")));
  const assets = [
    ["strongcode_auth.py", manifest.assets.authenticationSha256],
    ["connection.py", manifest.assets.connectionSha256],
    ["addon-patches.json", manifest.assets.addonPatchesSha256],
    ["LICENSE.md", manifest.assets.licenseSha256]
  ] as const;
  for (const [filename, expected] of assets) {
    if (sha256(await readFile(path.join(root, filename))) !== expected) {
      throw new BlenderInstallError("conflict", `Official authenticated derivative asset hash mismatch: ${filename}`);
    }
  }
  return manifest;
}

export async function applyOfficialRuntimeDerivative(options: {
  readonly contentRoot: string;
  readonly derivativeRootPath: string;
}): Promise<void> {
  const manifest = await readOfficialDerivativeIdentity(options.derivativeRootPath);
  const target = path.join(options.contentRoot, "blmcp", "tools_helpers", "connection.py");
  if (sha256(await readFile(target)) !== manifest.upstreamSources.runtimeConnectionSha256) {
    throw new BlenderInstallError("conflict", "Official runtime connection.py does not match the reviewed upstream source");
  }
  const authenticationTarget = path.join(path.dirname(target), "strongcode_auth.py");
  await Promise.all([
    writeFile(target, await readFile(path.join(options.derivativeRootPath, "connection.py"))),
    writeFile(authenticationTarget, await readFile(path.join(options.derivativeRootPath, "strongcode_auth.py")))
  ]);
  if (sha256(await readFile(target)) !== manifest.derivativeSources.runtimeConnectionSha256
    || sha256(await readFile(authenticationTarget)) !== manifest.derivativeSources.authenticationSha256) {
    throw new BlenderInstallError("conflict", "Official runtime derivative output hash mismatch");
  }
}

export async function applyOfficialAddonDerivative(options: {
  readonly extensionPath: string;
  readonly derivativeRootPath: string;
}): Promise<void> {
  const manifest = await readOfficialDerivativeIdentity(options.derivativeRootPath);
  const patchesSource = await readFile(path.join(options.derivativeRootPath, "addon-patches.json"), "utf8");
  const patches = patchesSchema.parse(JSON.parse(patchesSource));
  const expected = new Map([
    ["mcp_to_blender_server.py", manifest.upstreamSources.addonServerSha256],
    ["__init__.py", manifest.upstreamSources.addonInitSha256]
  ]);
  for (const patch of patches.files) {
    const target = path.join(options.extensionPath, patch.path);
    let source = await readFile(target, "utf8");
    if (patch.upstreamSha256 !== expected.get(patch.path) || sha256(source) !== patch.upstreamSha256) {
      throw new BlenderInstallError("conflict", `Official addon source does not match reviewed upstream context: ${patch.path}`);
    }
    for (const replacement of patch.replacements) source = applyExactReplacement(source, replacement);
    await writeFile(target, source, "utf8");
    const derivativeHash = patch.path === "mcp_to_blender_server.py"
      ? manifest.derivativeSources.addonServerSha256
      : manifest.derivativeSources.addonInitSha256;
    if (sha256(source) !== derivativeHash) {
      throw new BlenderInstallError("conflict", `Official addon derivative output hash mismatch: ${patch.path}`);
    }
  }
  const authenticationTarget = path.join(options.extensionPath, "strongcode_auth.py");
  await writeFile(authenticationTarget,
    await readFile(path.join(options.derivativeRootPath, "strongcode_auth.py")));
  if (sha256(await readFile(authenticationTarget)) !== manifest.derivativeSources.authenticationSha256) {
    throw new BlenderInstallError("conflict", "Official addon authentication derivative output hash mismatch");
  }
}

export function applyExactReplacement(source: string, replacement: { readonly before: string; readonly after: string }): string {
  const first = source.indexOf(replacement.before);
  if (first < 0 || source.indexOf(replacement.before, first + replacement.before.length) >= 0) {
    throw new BlenderInstallError("conflict", "Official derivative patch context must match exactly once");
  }
  return `${source.slice(0, first)}${replacement.after}${source.slice(first + replacement.before.length)}`;
}
