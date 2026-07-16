import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAgentInstructions } from "../src/config/instructions";
import { loadRuntimeCatalog } from "../src/config/runtime-catalog";
import { strongCodeConfigSchema } from "../src/config/schema";
import { PathIdentityError, inspectPath } from "../src/core/path-identity";
import * as pathIdentity from "../src/core/path-identity";

const roots: string[] = [];

async function trustedHome(): Promise<{
  readonly home: string;
  readonly receipt: Awaited<ReturnType<typeof inspectPath>>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "strongcode-adjacent-"));
  const home = path.join(root, "home");
  await mkdir(home);
  const configPath = path.join(home, "strongcode.config.yaml");
  await writeFile(configPath, "version: 1\n", "utf8");
  roots.push(root);
  return {
    home,
    receipt: await inspectPath(configPath, { finalKind: "regular-file", requireSingleLink: true })
  };
}

async function hardlinkInto(home: string, fileName: string, content: string): Promise<void> {
  const source = path.join(path.dirname(home), `external-${fileName}`);
  await writeFile(source, content, "utf8");
  await link(source, path.join(home, fileName));
}

function config() {
  return strongCodeConfigSchema.parse({
    version: 1,
    workspace: ".",
    dataDir: ".strongcode",
    defaultAgent: "default",
    agents: { default: { model: "mock", tools: [] } },
    models: { mock: { provider: "mock" }, "home-oracle": { provider: "mock" } },
    permissions: { tools: {} }
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("trusted home catalog reads", () => {
  it("ignores a linked agents catalog without opening it", async () => {
    // Given
    const fixture = await trustedHome();
    const source = path.join(path.dirname(fixture.home), "linked-agents");
    await mkdir(source);
    await symlink(source, path.join(fixture.home, "agents.json"), process.platform === "win32" ? "junction" : "dir");
    const readSpy = vi.spyOn(pathIdentity, "readVerifiedRegularFile");

    // When
    const catalog = await loadRuntimeCatalog(config(), {
      directory: fixture.home,
      trustedAdjacentMetadata: true,
      automaticHomeReceipt: fixture.receipt,
      configSource: {}
    });

    // Then
    expect(catalog.helpers.oracle.model).toBeUndefined();
    expect(readSpy.mock.calls.some(([filePath]) => path.basename(filePath) === "agents.json")).toBe(false);
  });

  it("ignores hardlinked agents metadata without opening it", async () => {
    // Given
    const fixture = await trustedHome();
    await hardlinkInto(fixture.home, "agents.json", JSON.stringify({
      version: 1,
      helpers: { oracle: { model: "home-oracle" } }
    }));
    const readSpy = vi.spyOn(pathIdentity, "readVerifiedRegularFile");

    // When
    const catalog = await loadRuntimeCatalog(config(), {
      directory: fixture.home,
      trustedAdjacentMetadata: true,
      automaticHomeReceipt: fixture.receipt,
      configSource: {}
    });

    // Then
    expect(catalog.helpers.oracle.model).toBeUndefined();
    expect(readSpy.mock.calls.some(([filePath]) => path.basename(filePath) === "agents.json")).toBe(false);
  });

  it("rejects hardlinked automatic-home categories metadata", async () => {
    // Given
    const fixture = await trustedHome();
    await hardlinkInto(fixture.home, "categories.json", JSON.stringify({
      version: 1,
      categories: { deep: { model: "home-oracle" } }
    }));

    // When
    const loading = loadRuntimeCatalog(config(), {
      directory: fixture.home,
      trustedAdjacentMetadata: true,
      automaticHomeReceipt: fixture.receipt,
      configSource: {}
    });

    // Then
    await expect(loading).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });

  it("omits unsafe ambient-home metadata for an independently trusted config", async () => {
    // Given
    const fixture = await trustedHome();
    await hardlinkInto(fixture.home, "agents.json", JSON.stringify({
      version: 1,
      helpers: { oracle: { model: "home-oracle" } }
    }));
    const readSpy = vi.spyOn(pathIdentity, "readVerifiedRegularFile");

    // When
    const catalog = await loadRuntimeCatalog(config(), {
      directory: fixture.home,
      trustedAdjacentMetadata: true,
      configSource: {}
    });

    // Then
    expect(catalog.helpers.oracle.model).toBeUndefined();
    expect(readSpy.mock.calls.some(([filePath]) => path.basename(filePath) === "agents.json")).toBe(false);
  });

  it("ignores an identity-raced agents catalog without opening it", async () => {
    // Given
    const fixture = await trustedHome();
    await writeFile(path.join(fixture.home, "agents.json"), JSON.stringify({
      version: 1,
      helpers: { oracle: { model: "home-oracle" } }
    }), "utf8");
    const originalRead = pathIdentity.readVerifiedRegularFile;
    const readSpy = vi.spyOn(pathIdentity, "readVerifiedRegularFile").mockImplementation(async (filePath, options) => {
      if (path.basename(filePath) === "agents.json") {
        throw new PathIdentityError("identity-changed", filePath, "changed after open");
      }
      return originalRead(filePath, options);
    });

    // When
    const catalog = await loadRuntimeCatalog(config(), {
      directory: fixture.home,
      trustedAdjacentMetadata: true,
      automaticHomeReceipt: fixture.receipt,
      configSource: {}
    });

    // Then
    expect(catalog.helpers.oracle.model).toBeUndefined();
    expect(readSpy.mock.calls.some(([filePath]) => path.basename(filePath) === "agents.json")).toBe(false);
  });
});

describe("trusted home instruction reads", () => {
  it("rejects hardlinked automatic-home instructions", async () => {
    // Given
    const fixture = await trustedHome();
    await hardlinkInto(fixture.home, "AGENTS.md", "unsafe global instruction");

    // When
    const loading = loadAgentInstructions(fixture.home, fixture.home, {
      automaticHomeReceipt: fixture.receipt
    });

    // Then
    await expect(loading).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });

  it("omits unsafe ambient instructions without weakening trusted project instructions", async () => {
    // Given
    const fixture = await trustedHome();
    const project = path.join(path.dirname(fixture.home), "project");
    await mkdir(project);
    await hardlinkInto(fixture.home, "AGENTS.md", "unsafe global instruction");
    await writeFile(path.join(project, "AGENTS.md"), "trusted project instruction", "utf8");

    // When
    const instructions = await loadAgentInstructions(project, fixture.home, { includeProject: true });

    // Then
    expect(instructions).toContain("trusted project instruction");
    expect(instructions).not.toContain("unsafe global instruction");
  });

  it("returns no global instructions after a verified-read identity mismatch", async () => {
    // Given
    const fixture = await trustedHome();
    await writeFile(path.join(fixture.home, "AGENTS.md"), "must not be returned", "utf8");
    vi.spyOn(pathIdentity, "readVerifiedRegularFile").mockRejectedValueOnce(
      new PathIdentityError("identity-changed", path.join(fixture.home, "AGENTS.md"), "changed after open")
    );

    // When
    const loading = loadAgentInstructions(fixture.home, fixture.home, {
      automaticHomeReceipt: fixture.receipt
    });

    // Then
    await expect(loading).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });
});
