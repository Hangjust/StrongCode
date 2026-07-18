import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArtifactProvenanceJson, parseWheelLockJson } from "../src/setup/blender/artifact-manifest";
import { nodeBlenderInstallerFileSystem } from "../src/setup/blender/install-files";
import type {
  CreateBlenderInstallationReceiptV3Options,
  OfficialBlenderInstallationReceiptV3Options
} from "../src/setup/blender/installation-receipt";
import { parseOfficialArtifactCatalogJson, parseOfficialWheelLockJson } from "../src/setup/blender/official-artifact-parser";
import type { BlenderProfileCandidate, CpythonCandidate } from "../src/setup/blender/types";

const ASSET_ROOT = path.join(process.cwd(), "assets", "blender-mcp");
const sha256 = (source: string): string => createHash("sha256").update(source).digest("hex");

export type ReceiptFixture = {
  readonly legacy: CreateBlenderInstallationReceiptV3Options & { readonly flavor: "legacy" };
  readonly official: OfficialBlenderInstallationReceiptV3Options;
};

function profile(root: string, version: string): BlenderProfileCandidate {
  return {
    profileId: `blender-${version.replaceAll(".", "-")}`,
    executable: { canonicalPath: path.join(root, `blender-${version}.exe`), sha256: sha256(`blender-${version}`) },
    version,
    paths: {
      resources: { local: path.join(root, "local"), system: path.join(root, "system"), user: path.join(root, "user") },
      config: path.join(root, "config"),
      scripts: [path.join(root, "user", "scripts")]
    },
    sources: ["association"]
  };
}

function python(root: string): CpythonCandidate {
  return {
    executable: { canonicalPath: path.join(root, "python.exe"), sha256: sha256("python") },
    implementation: "cpython",
    version: { major: 3, minor: 11, patch: 9 },
    prefix: root,
    pointerWidth: 64,
    sysconfigPlatform: "win_amd64"
  };
}

export async function receiptFixture(): Promise<ReceiptFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "strongcode-receipt-v3-"));
  const legacyProfile = profile(path.join(root, "legacy-profile"), "4.3.2");
  const officialBaseProfile = profile(path.join(root, "official-profile"), "5.1.0");
  const officialProfile = { ...officialBaseProfile, paths: { ...officialBaseProfile.paths,
    extensions: path.join(root, "official-profile", "extensions") } };
  const runtime = path.join(root, "managed", "runtime");
  const addon = path.join(root, "managed", "addon");
  const privateConfig = path.join(root, "managed", "private-config.json");
  const launcher = path.join(root, "managed", "official-launcher.py");
  await Promise.all([mkdir(runtime, { recursive: true }), mkdir(addon, { recursive: true }), mkdir(path.dirname(privateConfig), { recursive: true })]);
  await Promise.all([
    writeFile(path.join(runtime, "runtime.txt"), "runtime", "utf8"),
    writeFile(path.join(addon, "__init__.py"), "addon", "utf8"),
    writeFile(privateConfig, "private", "utf8"),
    writeFile(launcher, "launcher", "utf8")
  ]);
  const [runtimeState, addonState, privateConfigState, launcherState] = await Promise.all([
    nodeBlenderInstallerFileSystem.state(runtime),
    nodeBlenderInstallerFileSystem.state(addon),
    nodeBlenderInstallerFileSystem.state(privateConfig),
    nodeBlenderInstallerFileSystem.state(launcher)
  ]);
  const managed = {
    mcp: { path: path.join(root, "home", "mcp.json"), fragmentSha256: "1".repeat(64) },
    permissions: { path: path.join(root, "home", "strongcode.config.yaml"), fragmentSha256: "2".repeat(64) },
    preferencesPath: path.join(root, "profiles", "userpref.blend")
  };
  const [provenanceSource, legacyLockSource, requirements, catalogSource, officialLockSource, officialRequirements] = await Promise.all([
    readFile(path.join(ASSET_ROOT, "provenance.json"), "utf8"),
    readFile(path.join(ASSET_ROOT, "wheels.lock.json"), "utf8"),
    readFile(path.join(ASSET_ROOT, "requirements.lock.txt"), "utf8"),
    readFile(path.join(ASSET_ROOT, "official-catalog.json"), "utf8"),
    readFile(path.join(ASSET_ROOT, "official-wheels.lock.json"), "utf8"),
    readFile(path.join(ASSET_ROOT, "official-requirements.lock.txt"), "utf8")
  ]);
  return {
    legacy: {
      flavor: "legacy",
      profile: legacyProfile,
      python: python(path.join(root, "python")),
      provenance: parseArtifactProvenanceJson(provenanceSource),
      lock: parseWheelLockJson(legacyLockSource),
      requirements,
      immutableTargets: [
        { role: "private-config", path: privateConfig, state: privateConfigState },
        { role: "addon", path: addon, state: addonState },
        { role: "runtime", path: runtime, state: runtimeState }
      ],
      managed,
      predecessor: { receiptSha256: "a".repeat(64), flavor: "legacy", profileId: legacyProfile.profileId },
      installedAt: "2026-07-17T12:00:00.000Z"
    },
    official: {
      flavor: "official",
      profile: officialProfile,
      python: python(path.join(root, "python")),
      catalog: parseOfficialArtifactCatalogJson(catalogSource),
      lock: parseOfficialWheelLockJson(officialLockSource),
      requirements: officialRequirements,
      addonModule: "bl_ext.blender_org.mcp",
      launcher: { path: launcher, sha256: launcherState.kind === "file" ? launcherState.sha256 : "" },
      immutableTargets: [
        { role: "private-config", path: privateConfig, state: privateConfigState },
        { role: "addon", path: addon, state: addonState },
        { role: "runtime", path: runtime, state: runtimeState }
      ],
      managed,
      installedAt: "2026-07-17T12:00:00.000Z"
    }
  };
}
