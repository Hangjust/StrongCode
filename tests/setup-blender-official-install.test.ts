import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { installBlenderIntegration } from "../src/setup/blender/install";
import { OFFICIAL_ADDON_MODULE } from "../src/setup/blender/official-addon";
import {
  cleanupOfficialInstallFixtures,
  officialInstallFixture,
  officialInstallTargets,
  officialInstallTreeSnapshot,
  officialMcpSource,
  officialYamlSource
} from "./setup-blender-official-install-fixture";
import { legacyMigrationOptions } from "./setup-blender-migration-fixture";

afterEach(async () => {
  await cleanupOfficialInstallFixtures();
});

const fixture = officialInstallFixture;
const targets = officialInstallTargets;
const treeSnapshot = officialInstallTreeSnapshot;
const mcpSource = officialMcpSource;
const yamlSource = officialYamlSource;

describe("official Blender integration installer", () => {
  it("fails closed when the selected profile lacks a safe EXTENSIONS resource", async () => {
    // Given
    const value = await fixture();
    const paths = { ...value.options.selection.profile.paths, extensions: undefined };

    // When / Then
    await expect(installBlenderIntegration({ ...value.options, selection: { ...value.options.selection,
      profile: { ...value.options.selection.profile, paths } } })).rejects.toThrow(/safe discovered EXTENSIONS/iu);
    expect(value.runtimeStages).toEqual([]);
  });

  it("rejects an unsupported Python before staging or mutation", async () => {
    // Given
    const value = await fixture();

    // When / Then
    await expect(installBlenderIntegration({ ...value.options, python: {
      ...value.options.python,
      version: { major: 3, minor: 12, patch: 1 }
    } })).rejects.toThrow(/CPython 3\.11|win_amd64/i);
    expect(value.runtimeStages).toEqual([]);
    expect(value.addonStages).toEqual([]);
    expect(await readFile(path.join(value.homePath, "mcp.json"), "utf8")).toBe(mcpSource);
  });

  it("installs runtime, extension, preferences, config, permissions, and receipt transactionally", async () => {
    // Given
    const value = await fixture();
    const managed = targets(value);
    const phases: string[] = [];

    // When
    const result = await installBlenderIntegration({ ...value.options, phaseHook: phase => { phases.push(phase); } });

    // Then
    expect(result.status).toBe("installed");
    expect(await readFile(path.join(managed.addon, "__init__.py"), "utf8")).toBe("official addon");
    expect(await readFile(managed.preferences, "utf8")).toBe("user preferences\n");
    expect(JSON.parse(await readFile(managed.receipt, "utf8"))).toMatchObject({
      schemaVersion: 3,
      flavor: "official",
      integration: { version: "1.0.0", addonModule: OFFICIAL_ADDON_MODULE, launcher: { path: managed.launcher } }
    });
    expect(JSON.parse(await readFile(managed.mcp, "utf8")).mcpServers.blender.command)
      .toEqual([path.join(managed.runtime, "venv", "Scripts", "python.exe"), "-I", managed.launcher,
        "--strongcode-config", managed.privateConfig]);
    expect(YAML.parse(await readFile(managed.permissions, "utf8")).permissions.tools["mcp__blender__*"]).toBe("ask");
    expect(phases).toEqual(["credential_active", "addon_active", "preferences_active", "permissions_active", "mcp_active", "state_active"]);
    expect(value.runtimeStages[0]?.startsWith(`${value.homePath}${path.sep}.blender-install-`)).toBe(true);
    expect(value.addonStages[0]?.startsWith(`${value.homePath}${path.sep}.blender-install-`)).toBe(true);
    expect(value.probes[0]).toMatchObject({ executable: expect.stringContaining(".blender-install-"),
      args: ["-I", expect.stringContaining(".blender-install-"), "--strongcode-config",
        expect.stringContaining(".blender-install-")], shell: false });
  });

  it("verifies a healthy same-flavor install without staging or changing bytes", async () => {
    // Given
    const value = await fixture();
    await installBlenderIntegration(value.options);
    const before = await treeSnapshot(value.root);
    value.runtimeStages.length = 0;
    value.addonStages.length = 0;
    value.probes.length = 0;

    // When
    const result = await installBlenderIntegration({ ...value.options, verifyOnly: true });

    // Then
    expect(result.status).toBe("already-installed");
    expect(await treeSnapshot(value.root)).toEqual(before);
    expect(value.runtimeStages).toEqual([]);
    expect(value.addonStages).toEqual([]);
    expect(value.probes).toHaveLength(1);
  });

  it("requires force for owned drift and repairs it while preserving unrelated state", async () => {
    // Given
    const value = await fixture();
    await installBlenderIntegration(value.options);
    const managed = targets(value);
    await writeFile(path.join(managed.runtime, "tampered.txt"), "drift", "utf8");
    const mcp = JSON.parse(await readFile(managed.mcp, "utf8"));
    mcp.mcpServers.blender.enabled = false;
    mcp.templates.user.extra = "preserved";
    await writeFile(managed.mcp, `${JSON.stringify(mcp, null, 2)}\n`, "utf8");
    await writeFile(managed.permissions, `${await readFile(managed.permissions, "utf8")}# user tail\n`, "utf8");
    await writeFile(managed.preferences, "user adjusted preferences\n", "utf8");

    // When / Then
    await expect(installBlenderIntegration(value.options)).rejects.toThrow(/--force|repair required/i);
    await expect(installBlenderIntegration({ ...value.options, repair: true })).resolves.toMatchObject({ status: "installed" });
    await expect(lstat(path.join(managed.runtime, "tampered.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(managed.mcp, "utf8")).templates.user.extra).toBe("preserved");
    expect(JSON.parse(await readFile(managed.mcp, "utf8")).mcpServers.blender.enabled).toBe(true);
    expect(await readFile(managed.permissions, "utf8")).toContain("# user tail");
    expect(await readFile(managed.preferences, "utf8")).toBe("user adjusted preferences\n");
  });

  it("rolls back every official target when activation fails", async () => {
    // Given
    const value = await fixture();
    const managed = targets(value);

    // When / Then
    await expect(installBlenderIntegration({ ...value.options, phaseHook: phase => {
      if (phase === "mcp_active") throw new Error("official activation failure");
    } })).rejects.toThrow("official activation failure");
    expect(await readFile(managed.mcp, "utf8")).toBe(mcpSource);
    expect(await readFile(managed.permissions, "utf8")).toBe(yamlSource);
    expect(await readFile(managed.preferences, "utf8")).toBe("user preferences\n");
    for (const target of [managed.runtime, managed.addon, managed.receipt]) {
      await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("rejects unowned managed targets and markers before staging", async () => {
    // Given
    const value = await fixture();
    const managed = targets(value);
    await mkdir(managed.addon, { recursive: true });

    // When / Then
    await expect(installBlenderIntegration(value.options)).rejects.toThrow(/unowned|conflict/i);
    expect(value.runtimeStages).toEqual([]);
    await rm(managed.addon, { recursive: true });
    const source = JSON.parse(await readFile(managed.mcp, "utf8"));
    source.templates.user.marker = "strongcode:blender-managed";
    await writeFile(managed.mcp, `${JSON.stringify(source, null, 2)}\n`, "utf8");
    await expect(installBlenderIntegration(value.options)).rejects.toThrow(/ownership receipt|unowned|managed/i);
    expect(value.runtimeStages).toEqual([]);
  });

  it("migrates an exactly owned healthy legacy install to official only with force", async () => {
    // Given
    const value = await fixture();
    const managed = targets(value);
    const legacy = await legacyMigrationOptions(value);
    await installBlenderIntegration(legacy);
    const predecessorSource = await readFile(managed.receipt);
    const legacyRuntime = path.join(value.homePath, "mcps", "blender", "runtime");
    const legacyAddon = path.join(value.options.selection.profile.paths.resources.user, "scripts", "addons", "strongcode_blender_mcp");
    const legacyPrivate = path.join(value.options.selection.profile.paths.config, "strongcode_blender_mcp", "config.json");
    const official = { ...value.options, blenderProcess: legacy.blenderProcess };

    // When / Then
    await expect(installBlenderIntegration(official)).rejects.toThrow(/migration.*--force|--force.*migration/i);
    await expect(installBlenderIntegration({ ...official, repair: true })).resolves.toMatchObject({ status: "installed" });
    const receipt = JSON.parse(await readFile(managed.receipt, "utf8"));
    expect(receipt).toMatchObject({ schemaVersion: 3, flavor: "official", predecessor: {
      receiptSha256: createHash("sha256").update(predecessorSource).digest("hex"),
      flavor: "legacy",
      profileId: legacy.selection.profile.profileId
    } });
    for (const target of [legacyRuntime, legacyAddon, legacyPrivate]) {
      await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(installBlenderIntegration({ ...official, verifyOnly: true }))
      .resolves.toMatchObject({ status: "already-installed" });
  });

  it("migrates an exactly owned healthy official install to legacy only with force", async () => {
    // Given
    const value = await fixture();
    const managed = targets(value);
    await installBlenderIntegration(value.options);
    const predecessorSource = await readFile(managed.receipt);
    const legacy = await legacyMigrationOptions(value);

    // When / Then
    await expect(installBlenderIntegration(legacy)).rejects.toThrow(/migration.*--force|--force.*migration/i);
    await expect(installBlenderIntegration({ ...legacy, repair: true })).resolves.toMatchObject({ status: "installed" });
    const receipt = JSON.parse(await readFile(managed.receipt, "utf8"));
    expect(receipt).toMatchObject({ schemaVersion: 3, flavor: "legacy", predecessor: {
      receiptSha256: createHash("sha256").update(predecessorSource).digest("hex"),
      flavor: "official",
      profileId: value.options.selection.profile.profileId
    } });
    for (const target of [managed.runtime, managed.addon, managed.privateConfig]) {
      await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(lstat(path.join(value.homePath, "mcps", "blender", "runtime"))).resolves.toBeDefined();
    await expect(installBlenderIntegration({ ...legacy, verifyOnly: true }))
      .resolves.toMatchObject({ status: "already-installed" });
  });

  it("rolls a flavor migration back to the predecessor when state activation fails", async () => {
    // Given
    const value = await fixture();
    const managed = targets(value);
    const legacy = await legacyMigrationOptions(value);
    await installBlenderIntegration(legacy);
    const beforeMcp = await readFile(managed.mcp);
    const beforePermissions = await readFile(managed.permissions);
    const beforePreferences = await readFile(managed.preferences);
    const official = { ...value.options, blenderProcess: legacy.blenderProcess };

    // When / Then
    await expect(installBlenderIntegration({ ...official, repair: true, phaseHook: phase => {
      if (phase === "state_active") throw new Error("migration state failure");
    } })).rejects.toThrow("migration state failure");
    expect(await readFile(managed.mcp)).toEqual(beforeMcp);
    expect(await readFile(managed.permissions)).toEqual(beforePermissions);
    expect(await readFile(managed.preferences)).toEqual(beforePreferences);
    expect(JSON.parse(await readFile(managed.receipt, "utf8")).flavor).toBe("legacy");
    await expect(lstat(path.join(value.homePath, "mcps", "blender", "runtime"))).resolves.toBeDefined();
    for (const target of [managed.runtime, managed.addon, managed.privateConfig]) {
      await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("refuses forced migration when predecessor-owned bytes drift", async () => {
    // Given
    const value = await fixture();
    const legacy = await legacyMigrationOptions(value);
    await installBlenderIntegration(legacy);
    const predecessorRuntime = path.join(value.homePath, "mcps", "blender", "runtime");
    await writeFile(path.join(predecessorRuntime, "drift.txt"), "drift", "utf8");

    // When / Then
    await expect(installBlenderIntegration({ ...value.options, blenderProcess: legacy.blenderProcess, repair: true }))
      .rejects.toThrow(/predecessor target requires repair|requires repair before migration/i);
    expect(value.runtimeStages).toEqual([]);
    await expect(lstat(predecessorRuntime)).resolves.toBeDefined();
  });
});
