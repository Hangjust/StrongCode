import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRuntimeCatalog } from "../src/config/runtime-catalog";
import { strongCodeConfigSchema } from "../src/config/schema";
import * as pathIdentity from "../src/core/path-identity";

function config(overrides: Record<string, unknown> = {}) {
  return strongCodeConfigSchema.parse({
    version: 1,
    workspace: ".",
    dataDir: ".strongcode",
    defaultAgent: "default",
    agents: { default: { model: "mock", tools: [] } },
    models: {
      mock: { provider: "mock" },
      "home-oracle": { provider: "mock" },
      "project-oracle": { provider: "mock" }
    },
    permissions: { tools: {} },
    ...overrides
  });
}

async function tempDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "strongcode-runtime-catalog-"));
}

describe("runtime catalog", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses canonical source defaults when adjacent helper data is missing", async () => {
    // Given
    const directory = await tempDirectory();

    // When
    const catalog = await loadRuntimeCatalog(config(), { directory, trustedAdjacentMetadata: true, configSource: {} });

    // Then
    expect(Object.keys(catalog.helpers)).toHaveLength(10);
    expect(Object.values(catalog.helpers).filter(helper => helper.enabled).map(helper => helper.id)).toEqual([
      "explore",
      "librarian",
      "oracle",
      "metis",
      "momus"
    ]);
    expect(catalog.delegation).toEqual({
      enabled: true,
      maxActive: 4,
      maxChildrenPerRoot: 16,
      defaultTimeoutMs: 600_000,
      maxInlineResultChars: 12_000
    });
  });

  it("ignores valid agents metadata without opening it while loading categories", async () => {
    // Given
    const directory = await tempDirectory();
    const readSpy = vi.spyOn(pathIdentity, "readVerifiedRegularFile");
    await writeFile(path.join(directory, "agents.json"), JSON.stringify({
      version: 1,
      helpers: { oracle: { model: "home-oracle", fallbackModels: ["mock"], maxSteps: 9, timeoutMs: 30_000 } },
      delegation: { maxActive: 3 }
    }), "utf8");
    await writeFile(path.join(directory, "categories.json"), JSON.stringify({
      version: 1,
      categories: { deep: { model: "home-oracle", maxSteps: 12 } }
    }), "utf8");

    // When
    const catalog = await loadRuntimeCatalog(config(), { directory, trustedAdjacentMetadata: true, configSource: {} });

    // Then
    expect(catalog.helpers.oracle).toMatchObject({ model: undefined, fallbackModels: [], maxSteps: undefined, timeoutMs: 600_000 });
    expect(catalog.delegation.maxActive).toBe(4);
    expect(catalog.categories.deep).toEqual({ model: "home-oracle", maxSteps: 12 });
    expect(readSpy.mock.calls.some(([filePath]) => path.basename(filePath) === "agents.json")).toBe(false);
  });

  it("keeps project YAML authoritative over trusted adjacent metadata", async () => {
    // Given
    const directory = await tempDirectory();
    await writeFile(path.join(directory, "agents.json"), JSON.stringify({
      version: 1,
      helpers: { oracle: { model: "home-oracle", fallbackModels: ["mock"], maxSteps: 9, timeoutMs: 30_000 } },
      delegation: { maxActive: 3, maxChildrenPerRoot: 7 }
    }), "utf8");
    await writeFile(path.join(directory, "categories.json"), JSON.stringify({
      version: 1,
      categories: {
        deep: {
          model: "home-oracle",
          fallbackModels: ["mock"],
          tools: ["read_file"],
          skills: ["focus"],
          maxSteps: 12
        }
      }
    }), "utf8");
    const projectConfig = config({
      helpers: { oracle: { model: "project-oracle" } },
      categories: { deep: { model: "project-oracle", timeoutMs: 90_000 } }
    });

    // When
    const catalog = await loadRuntimeCatalog(projectConfig, {
      directory,
      trustedAdjacentMetadata: true,
      configSource: {
        helpers: { oracle: { model: "project-oracle" } },
        delegation: { maxActive: 2 },
        categories: { deep: { model: "project-oracle", timeoutMs: 90_000 } }
      }
    });

    // Then
    expect(catalog.helpers.oracle.model).toBe("project-oracle");
    expect(catalog.helpers.oracle.fallbackModels).toEqual([]);
    expect(catalog.helpers.oracle.maxSteps).toBeUndefined();
    expect(catalog.helpers.oracle.timeoutMs).toBe(600_000);
    expect(catalog.delegation).toMatchObject({ maxActive: 2, maxChildrenPerRoot: 16 });
    expect(catalog.categories.deep).toEqual({
      model: "project-oracle",
      fallbackModels: ["mock"],
      tools: ["read_file"],
      skills: ["focus"],
      maxSteps: 12,
      timeoutMs: 90_000
    });
  });

  it("filters unavailable trusted category models while preserving compatible and operational fields", async () => {
    // Given
    const directory = await tempDirectory();
    await writeFile(path.join(directory, "categories.json"), JSON.stringify({
      version: 1,
      categories: {
        deep: {
          model: "missing-primary",
          fallbackModels: ["missing-first", "mock", "missing-second", "project-oracle"],
          tools: ["read_file"],
          skills: ["focus"],
          maxSteps: 12,
          timeoutMs: 90_000
        },
        empty: { model: "missing-primary", fallbackModels: ["missing-first", "missing-second"] },
        compatible: { model: "home-oracle", fallbackModels: ["mock", "project-oracle"] }
      }
    }), "utf8");

    // When
    const catalog = await loadRuntimeCatalog(config(), { directory, trustedAdjacentMetadata: true, configSource: {} });

    // Then
    expect(catalog.categories.deep).toEqual({
      fallbackModels: ["mock", "project-oracle"],
      tools: ["read_file"],
      skills: ["focus"],
      maxSteps: 12,
      timeoutMs: 90_000
    });
    expect(catalog.categories.empty).toEqual({ fallbackModels: [] });
    expect(catalog.categories.compatible).toEqual({
      model: "home-oracle",
      fallbackModels: ["mock", "project-oracle"]
    });
  });

  it.each([
    { field: "model", category: { model: "missing-model" } },
    { field: "fallbackModels", category: { fallbackModels: ["missing-model"] } }
  ])("rejects unavailable project YAML category $field references", async ({ category }) => {
    // Given
    const directory = await tempDirectory();

    // When
    const loading = loadRuntimeCatalog(config(), {
      directory,
      trustedAdjacentMetadata: true,
      configSource: { categories: { deep: category } }
    });

    // Then
    await expect(loading).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    await expect(loading).rejects.toThrow(/Category 'deep'.*missing-model.*not defined/i);
  });

  it("rejects malformed trusted category metadata", async () => {
    // Given
    const directory = await tempDirectory();
    await writeFile(path.join(directory, "categories.json"), JSON.stringify({
      version: 1,
      categories: { deep: { agent: "build" } }
    }), "utf8");

    // When
    const loading = loadRuntimeCatalog(config(), { directory, trustedAdjacentMetadata: true, configSource: {} });

    // Then
    await expect(loading).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    await expect(loading).rejects.toThrow(/Invalid trusted metadata categories\.json/i);
  });

  it("ignores untrusted adjacent project metadata that attempts to enable Build", async () => {
    // Given
    const directory = await tempDirectory();
    await writeFile(path.join(directory, "agents.json"), JSON.stringify({
      version: 1,
      helpers: { build: { enabled: true, model: "mock" } }
    }), "utf8");

    // When
    const catalog = await loadRuntimeCatalog(config(), { directory, trustedAdjacentMetadata: false });

    // Then
    expect(catalog.helpers.build.enabled).toBe(false);
    expect(catalog.helpers.build.model).toBeUndefined();
  });

  it("ignores malformed agents metadata without opening it", async () => {
    // Given
    const directory = await tempDirectory();
    const readSpy = vi.spyOn(pathIdentity, "readVerifiedRegularFile");
    await writeFile(path.join(directory, "agents.json"), "{not-json", "utf8");

    // When
    const catalog = await loadRuntimeCatalog(config(), { directory, trustedAdjacentMetadata: true });

    // Then
    expect(catalog.helpers.oracle.model).toBeUndefined();
    expect(readSpy.mock.calls.some(([filePath]) => path.basename(filePath) === "agents.json")).toBe(false);
  });
});
