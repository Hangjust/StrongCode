import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { installBlenderIntegration } from "../src/setup/blender/install";
import { BLENDER_INTEGRATION_LOCK_ID } from "../src/setup/blender/verification";
import { cleanupOfficialInstallFixtures, officialInstallFixture,
  officialInstallTargets } from "./setup-blender-official-install-fixture";

afterEach(async () => {
  await cleanupOfficialInstallFixtures();
});

describe("official authenticated Blender bridge installation", () => {
  it("activates the private config first without leaking its secret to public state", async () => {
    // Given
    const value = await officialInstallFixture();

    // When
    await installBlenderIntegration(value.options);

    // Then
    const managed = officialInstallTargets(value);
    const configSource = await readFile(managed.privateConfig, "utf8");
    const config = JSON.parse(configSource);
    expect(config).toMatchObject({ schemaVersion: 1, profileId: value.options.selection.profile.profileId,
      host: "127.0.0.1" });
    expect(config.port).toBeGreaterThanOrEqual(49_152);
    expect(config.port).toBeLessThanOrEqual(65_535);
    expect(Buffer.from(config.secret, "base64url")).toHaveLength(32);
    if (process.platform !== "win32") expect((await stat(managed.privateConfig)).mode & 0o777).toBe(0o600);

    const receipt = JSON.parse(await readFile(managed.receipt, "utf8"));
    expect(receipt.immutableTargets.map((target: { readonly role: string }) => target.role).sort())
      .toEqual(["addon", "private-config", "runtime"]);
    for (const publicPath of [managed.mcp, managed.permissions, managed.receipt]) {
      expect(await readFile(publicPath, "utf8")).not.toContain(config.secret);
    }
    expect(YAML.parse(await readFile(managed.permissions, "utf8")).permissions.tools["mcp__blender__*"]).toBe("ask");

    const transactions = path.join(value.homePath, "transactions", "blender", BLENDER_INTEGRATION_LOCK_ID);
    const transactionId = (await readdir(transactions))[0];
    if (transactionId === undefined) throw new Error("Expected committed Blender transaction");
    const journalSource = await readFile(path.join(transactions, transactionId, "journal.json"), "utf8");
    expect(journalSource).not.toContain(config.secret);
    const targets = JSON.parse(journalSource).targets as readonly {
      readonly canonicalPath: string;
      readonly private: boolean;
    }[];
    expect(targets.find(target => target.canonicalPath === managed.privateConfig)?.private).toBe(true);
    expect(targets.findIndex(target => target.canonicalPath === managed.privateConfig))
      .toBeLessThan(targets.findIndex(target => target.canonicalPath === managed.runtime));
  });

  it("requires force to repair a tampered private config and rotates the credential", async () => {
    // Given
    const value = await officialInstallFixture();
    const managed = officialInstallTargets(value);
    await installBlenderIntegration(value.options);
    const first = JSON.parse(await readFile(managed.privateConfig, "utf8"));
    await writeFile(managed.privateConfig, `${JSON.stringify({ ...first, port: 1 })}\n`, "utf8");

    // When / Then
    await expect(installBlenderIntegration(value.options)).rejects.toThrow(/repair.*--force|--force.*repair/iu);
    await expect(installBlenderIntegration({ ...value.options, repair: true }))
      .resolves.toMatchObject({ status: "installed" });
    const repaired = JSON.parse(await readFile(managed.privateConfig, "utf8"));
    expect(repaired.port).toBeGreaterThanOrEqual(49_152);
    expect(repaired.secret).not.toBe(first.secret);
  });

  it("rolls the private config and runtime back when credential activation fails", async () => {
    // Given
    const value = await officialInstallFixture();
    const managed = officialInstallTargets(value);

    // When / Then
    await expect(installBlenderIntegration({ ...value.options, phaseHook: phase => {
      if (phase === "credential_active") throw new Error("credential activation failure");
    } })).rejects.toThrow("credential activation failure");
    await expect(stat(managed.privateConfig)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(managed.runtime)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
