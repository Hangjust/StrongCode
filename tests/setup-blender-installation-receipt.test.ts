import { writeFile } from "node:fs/promises";
import path from "node:path";
import { nodeBlenderInstallerFileSystem } from "../src/setup/blender/install-files";
import {
  assertInstallationReceiptOwnership,
  assertInstallationReceiptV3Ownership,
  blenderInstallationReceiptSchema,
  blenderInstallationReceiptV1Schema,
  blenderInstallationReceiptV2Schema,
  createInstallationReceipt,
  createInstallationReceiptV3,
  installationReceiptFlavor,
  installationReceiptMatches,
  installationReceiptV3Matches
} from "../src/setup/blender/installation-receipt";
import { receiptFixture } from "./setup-blender-installation-receipt-fixtures";

const oldCommon = {
  profileId: "legacy-profile",
  blender: {
    executablePath: path.resolve("legacy", "blender.exe"),
    executableSha256: "1".repeat(64),
    version: "4.3.2",
    configPath: path.resolve("legacy", "config"),
    userResourcePath: path.resolve("legacy", "user")
  },
  artifacts: {
    upstreamCommit: "2".repeat(40),
    wheelSha256: "3".repeat(64),
    addonSha256: "4".repeat(64),
    lockSha256: "5".repeat(64),
    requirementsSha256: "6".repeat(64),
    target: "cp311-win_amd64" as const
  },
  addonModule: "strongcode_blender_mcp" as const,
  telemetry: "off" as const,
  installedAt: "2026-07-17T12:00:00.000Z"
};

describe("Blender installation receipt v3", () => {
  it("keeps v1 and v2 parsing strict and classifies both as legacy evidence", () => {
    // Given
    const target = { path: path.resolve("legacy", "runtime"), state: { kind: "directory" as const, sha256: "7".repeat(64) } };
    const v1 = blenderInstallationReceiptV1Schema.parse({ schemaVersion: 1, ...oldCommon, targets: [target] });
    const v2 = blenderInstallationReceiptV2Schema.parse({
      schemaVersion: 2,
      ...oldCommon,
      immutableTargets: [target, { ...target, path: path.resolve("legacy", "addon") }, { ...target, path: path.resolve("legacy", "private") }],
      managed: {
        mcp: { path: path.resolve("home", "mcp.json"), serverId: "blender", fragmentSha256: "8".repeat(64) },
        permissions: { path: path.resolve("home", "strongcode.config.yaml"), fragmentSha256: "9".repeat(64) },
        preferences: { path: path.resolve("legacy", "userpref.blend"), profileId: oldCommon.profileId, addonModule: oldCommon.addonModule }
      }
    });

    // When / Then
    expect(blenderInstallationReceiptSchema.parse(v1)).toEqual(v1);
    expect(blenderInstallationReceiptSchema.parse(v2)).toEqual(v2);
    expect(installationReceiptFlavor(v1)).toBe("legacy");
    expect(installationReceiptFlavor(v2)).toBe("legacy");
    expect(blenderInstallationReceiptV1Schema.safeParse({ ...v1, flavor: "official" }).success).toBe(false);
  });

  it("uses a v1 receipt only as read-only legacy ownership evidence", async () => {
    // Given
    const fixture = await receiptFixture();
    const v2 = createInstallationReceipt({
      profile: fixture.legacy.profile,
      lock: fixture.legacy.lock,
      provenance: fixture.legacy.provenance,
      requirements: fixture.legacy.requirements,
      immutableTargets: fixture.legacy.immutableTargets,
      managed: fixture.legacy.managed
    });
    const receipt = blenderInstallationReceiptV1Schema.parse({
      schemaVersion: 1,
      profileId: v2.profileId,
      blender: v2.blender,
      artifacts: v2.artifacts,
      addonModule: v2.addonModule,
      telemetry: v2.telemetry,
      installedAt: v2.installedAt,
      targets: v2.immutableTargets
    });
    const targetPaths = receipt.targets.map(target => target.path);
    const ownership = { receipt, profile: fixture.legacy.profile, immutableTargetPaths: targetPaths,
      legacyTargetPaths: targetPaths, mcpPath: fixture.legacy.managed.mcp.path,
      permissionsPath: fixture.legacy.managed.permissions.path,
      preferencesPath: fixture.legacy.managed.preferencesPath };

    // When / Then
    expect(() => assertInstallationReceiptOwnership(ownership)).not.toThrow();
    await expect(installationReceiptMatches({ ...ownership, provenance: fixture.legacy.provenance,
      lock: fixture.legacy.lock, requirements: fixture.legacy.requirements,
      mcpFragmentSha256: fixture.legacy.managed.mcp.fragmentSha256,
      permissionsFragmentSha256: fixture.legacy.managed.permissions.fragmentSha256,
      files: nodeBlenderInstallerFileSystem })).resolves.toBe(false);
  });

  it("creates legacy evidence with Python, managed fragments, targets, and predecessor proof", async () => {
    // Given
    const fixture = await receiptFixture();

    // When
    const receipt = createInstallationReceiptV3(fixture.legacy);

    // Then
    expect(receipt).toMatchObject({
      schemaVersion: 3,
      serverId: "blender",
      flavor: "legacy",
      python: { implementation: "cpython", version: { major: 3, minor: 11, patch: 9 }, pointerWidth: 64, sysconfigTarget: "win_amd64" },
      integration: { name: "blender-mcp", version: "1.6.4", addonModule: "strongcode_blender_mcp" },
      predecessor: fixture.legacy.predecessor,
      telemetry: "off"
    });
    expect(receipt.immutableTargets.map(target => target.role)).toEqual(["private-config", "addon", "runtime"]);
  });

  it("creates official Blender Lab evidence with both release assets and StrongCode SHA authority", async () => {
    // Given
    const fixture = await receiptFixture();

    // When
    const receipt = createInstallationReceiptV3(fixture.official);

    // Then
    expect(receipt.integration).toMatchObject({
      name: "Blender Lab",
      version: "1.0.0",
      repository: "https://projects.blender.org/lab/blender_mcp",
      commit: "03004fd0216bfe5e0a3d9ac9b47d5efadc3d78c4",
      addonId: "mcp",
      addonModule: fixture.official.addonModule,
      integrity: { authority: "StrongCode", kind: "sha256-pin", upstreamSignature: false }
    });
    expect(receipt.integration.releaseAssets).toEqual(fixture.official.catalog.release.assets);
    expect(receipt.integration.launcher).toEqual(fixture.official.launcher);
  });

  it("rejects unknown fields, unnormalized paths, and signature-authority tampering", async () => {
    // Given
    const fixture = await receiptFixture();
    const receipt = createInstallationReceiptV3(fixture.official);

    // When / Then
    expect(blenderInstallationReceiptSchema.safeParse({ ...receipt, unexpected: true }).success).toBe(false);
    expect(blenderInstallationReceiptSchema.safeParse({ ...receipt, immutableTargets: [
      { ...receipt.immutableTargets[0], path: "relative/path" }, ...receipt.immutableTargets.slice(1)
    ] }).success).toBe(false);
    expect(blenderInstallationReceiptSchema.safeParse({ ...receipt, integration: {
      ...receipt.integration,
      integrity: { authority: "upstream", kind: "signature", upstreamSignature: true }
    } }).success).toBe(false);
  });

  it("rejects flavor-semantic v3 receipts at the schema boundary", async () => {
    // Given
    const fixture = await receiptFixture();
    const official = createInstallationReceiptV3(fixture.official);
    const legacy = createInstallationReceiptV3(fixture.legacy);

    // When / Then
    expect(blenderInstallationReceiptSchema.safeParse({ ...official,
      blender: { ...official.blender, extensionsPath: undefined } }).success).toBe(false);
    expect(blenderInstallationReceiptSchema.safeParse({ ...official, immutableTargets: [
      ...official.immutableTargets,
      { ...legacy.immutableTargets[0], role: "private-config" }
    ] }).success).toBe(false);
    expect(blenderInstallationReceiptSchema.safeParse({ ...legacy,
      immutableTargets: legacy.immutableTargets.filter(target => target.role !== "private-config") }).success).toBe(false);
  });

  it("requires exact profile, flavor, target roles, and managed paths for ownership", async () => {
    // Given
    const fixture = await receiptFixture();
    const receipt = createInstallationReceiptV3(fixture.legacy);
    const ownership = { receipt, flavor: fixture.legacy.flavor, profile: fixture.legacy.profile,
      immutableTargets: fixture.legacy.immutableTargets, managed: fixture.legacy.managed };

    // When / Then
    expect(() => assertInstallationReceiptV3Ownership(ownership)).not.toThrow();
    expect(() => assertInstallationReceiptV3Ownership({ ...ownership, flavor: "official" })).toThrow(/flavor|ownership/i);
    expect(() => assertInstallationReceiptV3Ownership({ ...ownership, immutableTargets: [
      { ...fixture.legacy.immutableTargets[0], path: path.resolve("outside") }, ...fixture.legacy.immutableTargets.slice(1)
    ] })).toThrow(/target|path|ownership/i);
  });

  it("matches every v3 identity and live state and rejects metadata or byte tampering", async () => {
    // Given
    const fixture = await receiptFixture();
    const receipt = createInstallationReceiptV3(fixture.official);

    // When / Then
    await expect(installationReceiptV3Matches({ ...fixture.official, receipt, files: nodeBlenderInstallerFileSystem })).resolves.toBe(true);
    const changedHash = blenderInstallationReceiptSchema.parse({ ...receipt, integration: {
      ...receipt.integration,
      launcher: { ...receipt.integration.launcher, sha256: "f".repeat(64) }
    } });
    if (changedHash.schemaVersion !== 3) throw new Error("Expected receipt v3");
    await expect(installationReceiptV3Matches({ ...fixture.official, receipt: changedHash, files: nodeBlenderInstallerFileSystem })).resolves.toBe(false);
    const runtime = fixture.official.immutableTargets.find(target => target.role === "runtime");
    if (!runtime) throw new Error("Official runtime target is required");
    await writeFile(path.join(runtime.path, "tampered.txt"), "tampered", "utf8");
    await expect(installationReceiptV3Matches({ ...fixture.official, receipt, files: nodeBlenderInstallerFileSystem })).resolves.toBe(false);
  });
});
