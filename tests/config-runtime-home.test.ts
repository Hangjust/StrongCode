import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load";

const SELECTED_HOME_CONFIG_YAML = `version: 1
workspace: .
dataDir: .strongcode
defaultAgent: default
agents:
  default:
    model: mock
    tools: []
models:
  mock:
    provider: mock
  ambient-model:
    provider: mock
  supplied-model:
    provider: mock
permissions:
  tools: {}
`;

describe("runtime config home selection", () => {
  it("uses inert home agents metadata and merges home categories beneath active project YAML", async () => {
    // Given
    const home = await mkdtemp(path.join(os.tmpdir(), "strongcode-runtime-home-"));
    const project = await mkdtemp(path.join(os.tmpdir(), "strongcode-runtime-project-"));
    const projectConfigPath = path.join(project, "strongcode.config.yaml");
    const previousHome = process.env.STRONGCODE_HOME;
    process.env.STRONGCODE_HOME = home;
    try {
      await writeFile(path.join(home, "agents.json"), JSON.stringify({
        version: 1,
        helpers: {
          oracle: { model: "home-oracle", fallbackModels: ["mock"], maxSteps: 9, timeoutMs: 30_000 }
        },
        delegation: { maxActive: 3 }
      }), "utf8");
      await writeFile(path.join(home, "categories.json"), JSON.stringify({
        version: 1,
        categories: { deep: { model: "home-oracle", fallbackModels: ["mock"], maxSteps: 12 } }
      }), "utf8");
      await writeFile(projectConfigPath, `version: 1
workspace: .
dataDir: .strongcode
defaultAgent: default
agents:
  default:
    model: mock
    tools: []
models:
  mock:
    provider: mock
  home-oracle:
    provider: mock
  project-oracle:
    provider: mock
helpers:
  oracle:
    model: project-oracle
    timeoutMs: 45000
categories:
  deep:
    model: project-oracle
    timeoutMs: 90000
permissions:
  tools: {}
`, "utf8");
      await writeFile(path.join(project, "agents.json"), JSON.stringify({
        version: 1,
        helpers: { build: { enabled: true, model: "mock" } }
      }), "utf8");
      await writeFile(path.join(project, "categories.json"), "{not-json", "utf8");

      // When
      const projectLoaded = await loadConfig(projectConfigPath);

      // Then
      expect(projectLoaded.ok).toBe(true);
      if (projectLoaded.ok) {
        expect(projectLoaded.value.runtimeCatalog?.helpers.oracle).toMatchObject({
          model: "project-oracle",
          fallbackModels: [],
          maxSteps: undefined,
          timeoutMs: 45_000
        });
        expect(projectLoaded.value.runtimeCatalog?.delegation.maxActive).toBe(4);
        expect(projectLoaded.value.runtimeCatalog?.categories.deep).toEqual({
          model: "project-oracle",
          fallbackModels: ["mock"],
          maxSteps: 12,
          timeoutMs: 90_000
        });
        expect(projectLoaded.value.runtimeCatalog?.helpers.build).toMatchObject({ enabled: false, model: undefined });
      }
    } finally {
      if (previousHome === undefined) delete process.env.STRONGCODE_HOME;
      else process.env.STRONGCODE_HOME = previousHome;
    }
  });

  it("uses the supplied home instead of the ambient home for project runtime metadata", async () => {
    // Given
    const ambientHome = await mkdtemp(path.join(os.tmpdir(), "strongcode-runtime-ambient-home-"));
    const suppliedHome = await mkdtemp(path.join(os.tmpdir(), "strongcode-runtime-supplied-home-"));
    const project = await mkdtemp(path.join(os.tmpdir(), "strongcode-runtime-selected-project-"));
    const suppliedHomeConfigPath = path.join(suppliedHome, "strongcode.config.yaml");
    const projectConfigPath = path.join(project, "strongcode.config.yaml");
    const previousHome = process.env.STRONGCODE_HOME;
    process.env.STRONGCODE_HOME = ambientHome;
    try {
      await writeFile(path.join(ambientHome, "categories.json"), JSON.stringify({
        version: 1,
        categories: { deep: { model: "ambient-model" } }
      }), "utf8");
      await writeFile(path.join(suppliedHome, "categories.json"), JSON.stringify({
        version: 1,
        categories: { deep: { model: "supplied-model", fallbackModels: ["mock"], maxSteps: 12 } }
      }), "utf8");
      await writeFile(suppliedHomeConfigPath, SELECTED_HOME_CONFIG_YAML, "utf8");
      await writeFile(projectConfigPath, SELECTED_HOME_CONFIG_YAML, "utf8");

      // When
      const loaded = await loadConfig(projectConfigPath, { strongCodeHome: suppliedHomeConfigPath });

      // Then
      expect(loaded).toMatchObject({ ok: true, value: { source: { kind: "explicit", atHomePath: false } } });
      if (loaded.ok) {
        expect(loaded.value.runtimeCatalog?.categories.deep).toEqual({
          model: "supplied-model",
          fallbackModels: ["mock"],
          maxSteps: 12
        });
      }
    } finally {
      if (previousHome === undefined) delete process.env.STRONGCODE_HOME;
      else process.env.STRONGCODE_HOME = previousHome;
    }
  });

  it("marks an explicit supplied-home config as being at the home path", async () => {
    // Given
    const ambientHome = await mkdtemp(path.join(os.tmpdir(), "strongcode-runtime-explicit-ambient-"));
    const suppliedHome = await mkdtemp(path.join(os.tmpdir(), "strongcode-runtime-explicit-supplied-"));
    const suppliedHomeConfigPath = path.join(suppliedHome, "strongcode.config.yaml");
    const previousHome = process.env.STRONGCODE_HOME;
    process.env.STRONGCODE_HOME = ambientHome;
    try {
      await writeFile(suppliedHomeConfigPath, SELECTED_HOME_CONFIG_YAML, "utf8");

      // When
      const loaded = await loadConfig(suppliedHomeConfigPath, { strongCodeHome: suppliedHomeConfigPath });

      // Then
      expect(loaded).toMatchObject({ ok: true, value: { source: { kind: "explicit", atHomePath: true } } });
    } finally {
      if (previousHome === undefined) delete process.env.STRONGCODE_HOME;
      else process.env.STRONGCODE_HOME = previousHome;
    }
  });
});
