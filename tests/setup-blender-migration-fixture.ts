import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ArtifactProvenance, WheelLock } from "../src/setup/blender/artifact-manifest";
import { BLENDER_ADDON_PROBE_SENTINEL } from "../src/setup/blender/blender-preferences";
import type { LegacyInstallBlenderIntegrationOptions } from "../src/setup/blender/install";
import type { EnvironmentProcessAdapter } from "../src/setup/blender/python-env";
import type { ProbeProcessAdapter } from "../src/setup/blender/types";
import type { OfficialInstallFixture } from "./setup-blender-official-install-fixture";

const hash = (source: string | Buffer): string => createHash("sha256").update(source).digest("hex");
const pypiUrl = (filename: string): string =>
  `https://files.pythonhosted.org/packages/aa/bb/${"c".repeat(60)}/${filename}`;

class MigrationPythonProcess implements EnvironmentProcessAdapter {
  async run(request: Parameters<EnvironmentProcessAdapter["run"]>[0]) {
    if (request.args.some(argument => argument.includes("importlib.metadata"))) {
      return { kind: "completed" as const, exitCode: 0,
        stdout: "__STRONGCODE_BLENDER_DISTRIBUTIONS_V1__[\"blender-mcp==1.6.4\"]\n", stderr: "" };
    }
    if (request.args.includes("--self-test")) {
      return { kind: "completed" as const, exitCode: 0,
        stdout: "__STRONGCODE_BLENDER_TOOLS_V1__[\"get_scene_info\",\"get_object_info\",\"get_viewport_screenshot\",\"execute_blender_code\"]\n",
        stderr: "" };
    }
    return { kind: "completed" as const, exitCode: 0, stdout: "", stderr: "" };
  }
}

class MigrationBlenderProcess implements ProbeProcessAdapter {
  async run(request: Parameters<ProbeProcessAdapter["run"]>[0]) {
    if (request.args.some(argument => argument.includes("addon_enable"))) {
      const config = request.env.BLENDER_USER_CONFIG;
      if (config !== undefined) await writeFile(path.join(config, "userpref.blend"), "user preferences\n", "utf8");
      return { kind: "completed" as const, exitCode: 0, stdout: "", stderr: "" };
    }
    return { kind: "completed" as const, exitCode: 0,
      stdout: `${BLENDER_ADDON_PROBE_SENTINEL}${JSON.stringify({ addonEnabled: true, background: true,
        rendezvousExists: false })}\n`, stderr: "" };
  }
}

export async function legacyMigrationOptions(
  value: OfficialInstallFixture
): Promise<LegacyInstallBlenderIntegrationOptions> {
  const wrapperAssetsPath = path.join(value.root, "legacy-wrapper");
  const addonAssetsPath = path.join(value.root, "legacy-addon", "strongcode_blender_mcp");
  await Promise.all([
    mkdir(path.join(wrapperAssetsPath, "wrapper"), { recursive: true }),
    mkdir(addonAssetsPath, { recursive: true })
  ]);
  const wrapper = "# legacy wrapper\n";
  const addon = "# legacy addon\n";
  await Promise.all([
    writeFile(path.join(wrapperAssetsPath, "strongcode-blender-wrapper.py"), wrapper, "utf8"),
    writeFile(path.join(wrapperAssetsPath, "wrapper", "__init__.py"), "", "utf8"),
    writeFile(path.join(addonAssetsPath, "__init__.py"), addon, "utf8")
  ]);
  const wheelContent = "wheel fixture";
  const upstreamAddon = "upstream addon fixture";
  const filename = "blender_mcp-1.6.4-py3-none-any.whl";
  const wheel = { name: "blender-mcp", version: "1.6.4", filename, url: pypiUrl(filename),
    size: Buffer.byteLength(wheelContent), sha256: hash(wheelContent), requiresPython: ">=3.11", license: "MIT" };
  const commit = "a".repeat(40);
  const lock: WheelLock = { schemaVersion: 1,
    target: { implementation: "cp", python: "3.11", abi: "cp311", platform: "win_amd64" },
    roots: ["blender-mcp==1.6.4"], wheels: [wheel] };
  const provenance: ArtifactProvenance = {
    schemaVersion: 1,
    upstream: { repository: "https://github.com/ahujasid/blender-mcp", commit },
    artifacts: [
      { kind: "wheel", ...wheel, metadataUrl: "https://pypi.org/pypi/example/1.0.0/json" },
      { kind: "addon", filename: "addon.py", commit,
        url: `https://raw.githubusercontent.com/owner/repo/${commit}/addon.py`,
        size: Buffer.byteLength(upstreamAddon), sha256: hash(upstreamAddon) }
    ],
    license: { path: "LICENSE", spdx: "MIT", sourceUrl: `https://raw.githubusercontent.com/owner/repo/${commit}/LICENSE`,
      sha256: "b".repeat(64), sourceSha256: "c".repeat(64), appliesTo: [filename, "addon.py"] },
    derivatives: [
      { path: "addon/strongcode_blender_mcp/__init__.py", sha256: hash(addon), licensePath: "LICENSE" },
      { path: "runtime-wrapper/strongcode-blender-wrapper.py", sha256: hash(wrapper), licensePath: "LICENSE" },
      { path: "runtime-wrapper/wrapper/__init__.py", sha256: hash(""), licensePath: "LICENSE" }
    ]
  };
  const artifacts = new Map([[filename, wheelContent], ["addon.py", upstreamAddon]]);
  return {
    homePath: value.homePath,
    selection: { flavor: "legacy", profile: { ...value.options.selection.profile, version: "5.0.0" },
      version: { major: 5, minor: 0, patch: 0 } },
    python: value.options.python,
    platform: "win32",
    architecture: "x64",
    lock,
    provenance,
    requirements: `blender-mcp==1.6.4 --hash=sha256:${wheel.sha256}\n`,
    wrapperAssetsPath,
    addonAssetsPath,
    downloader: { async download(items, destination) {
      await mkdir(destination, { recursive: true });
      await Promise.all(items.map(item => writeFile(path.join(destination, item.filename), artifacts.get(item.filename) ?? "", "utf8")));
    } },
    environmentProcess: new MigrationPythonProcess(),
    blenderProcess: new MigrationBlenderProcess(),
    files: value.options.files,
    extensionProbe: async () => true,
    mcpProbe: value.options.mcpProbe,
    env: value.options.env
  };
}
