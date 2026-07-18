import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { installBlenderIntegration } from "../src/setup/blender/install";
import { blenderInstallationReceiptV1Schema, blenderInstallationReceiptV2Schema,
  blenderInstallationReceiptV3Schema, type BlenderInstallationReceiptV2 } from "../src/setup/blender/installation-receipt";
import { cleanupOfficialInstallFixtures, officialInstallFixture,
  officialInstallTargets } from "./setup-blender-official-install-fixture";
import { legacyMigrationOptions } from "./setup-blender-migration-fixture";

afterEach(async () => {
  await cleanupOfficialInstallFixtures();
});

async function installedLegacyV2() {
  const value = await officialInstallFixture();
  const legacy = await legacyMigrationOptions(value);
  await installBlenderIntegration(legacy);
  const receiptPath = officialInstallTargets(value).receipt;
  const receipt = blenderInstallationReceiptV3Schema.parse(JSON.parse(await readFile(receiptPath, "utf8")));
  if (receipt.flavor !== "legacy") throw new Error("Expected a legacy fixture receipt");
  const v2 = blenderInstallationReceiptV2Schema.parse({
    schemaVersion: 2,
    profileId: receipt.profileId,
    blender: receipt.blender,
    artifacts: {
      upstreamCommit: receipt.integration.commit,
      wheelSha256: receipt.integration.wheel.sha256,
      addonSha256: receipt.integration.addon.sha256,
      lockSha256: receipt.integration.lockSha256,
      requirementsSha256: receipt.integration.requirementsSha256,
      target: "cp311-win_amd64"
    },
    addonModule: receipt.integration.addonModule,
    telemetry: receipt.telemetry,
    installedAt: receipt.installedAt,
    immutableTargets: receipt.immutableTargets.map(target => ({ path: target.path, state: target.state })),
    managed: {
      mcp: receipt.managed.mcp,
      permissions: receipt.managed.permissions,
      preferences: { ...receipt.managed.preferences, profileId: receipt.profileId }
    }
  });
  await writeFile(receiptPath, `${JSON.stringify(v2, null, 2)}\n`, "utf8");
  return { value, legacy, receiptPath, v2 };
}

describe("legacy v2 Blender migration", () => {
  it("migrates an exactly owned healthy v2 predecessor to official with force", async () => {
    // Given
    const { value, legacy } = await installedLegacyV2();

    // When
    const result = await installBlenderIntegration({ ...value.options, blenderProcess: legacy.blenderProcess, repair: true });

    // Then
    expect(result.status).toBe("installed");
    expect(JSON.parse(await readFile(officialInstallTargets(value).receipt, "utf8"))).toMatchObject({
      schemaVersion: 3,
      flavor: "official",
      predecessor: { flavor: "legacy", profileId: legacy.selection.profile.profileId }
    });
  });

  it("rejects a v2 receipt whose immutable target set is not exact", async () => {
    // Given
    const { value, legacy, receiptPath, v2 } = await installedLegacyV2();
    const targets = [...v2.immutableTargets];
    const first = targets[0];
    if (first === undefined) throw new Error("Expected a v2 target fixture");
    targets[0] = { ...first, path: path.join(value.root, "foreign-target") };
    const tampered: BlenderInstallationReceiptV2 = { ...v2, immutableTargets: targets };
    await writeFile(receiptPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");

    // When / Then
    await expect(installBlenderIntegration({ ...value.options, blenderProcess: legacy.blenderProcess, repair: true }))
      .rejects.toThrow(/immutable target paths are not exact/iu);
  });

  it("rejects legacy v1 receipts with explicit ownership guidance", async () => {
    // Given
    const { value, legacy, receiptPath, v2 } = await installedLegacyV2();
    const v1 = blenderInstallationReceiptV1Schema.parse({
      schemaVersion: 1,
      profileId: v2.profileId,
      blender: v2.blender,
      artifacts: v2.artifacts,
      addonModule: v2.addonModule,
      telemetry: v2.telemetry,
      installedAt: v2.installedAt,
      targets: v2.immutableTargets
    });
    await writeFile(receiptPath, `${JSON.stringify(v1, null, 2)}\n`, "utf8");

    // When / Then
    await expect(installBlenderIntegration({ ...value.options, blenderProcess: legacy.blenderProcess, repair: true }))
      .rejects.toThrow(/exactly owned v2 or v3 predecessor receipt/iu);
  });
});
