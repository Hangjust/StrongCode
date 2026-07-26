import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureStrongCodeHome, STRONGCODE_HOME_DIRECTORIES } from "../src/config/home";
import {
  STRONGCODE_HOME_EXPANDED_STARTER_FILES,
  STRONGCODE_HOME_LAYOUT_VERSION,
  STRONGCODE_HOME_LEGACY_HASHES
} from "../src/config/home-layout";
import { resolveStrongCodeHome } from "../src/config/paths";

describe("StrongCode home", () => {
  it("uses one predictable default with explicit override precedence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "strongcode-home-paths-"));

    expect(resolveStrongCodeHome({ env: {}, homeDirectory: root })).toBe(path.join(root, ".config", "strongcode"));
    expect(resolveStrongCodeHome({ env: { XDG_CONFIG_HOME: path.join(root, "xdg") }, homeDirectory: root })).toBe(path.join(root, "xdg", "strongcode"));
    expect(resolveStrongCodeHome({ env: { STRONGCODE_HOME: path.join(root, "explicit"), XDG_CONFIG_HOME: path.join(root, "xdg") }, homeDirectory: root })).toBe(path.join(root, "explicit"));
  });

  it("creates the complete starter layout and current Tesla routing", async () => {
    const homePath = await mkdtemp(path.join(os.tmpdir(), "strongcode-home-layout-"));
    const result = await ensureStrongCodeHome({ homePath });

    expect(result.createdFiles).toContain("strongcode.json");
    expect(result.createdFiles).toContain("agents.json");
    expect(result.createdFiles).toContain("providers.json");
    expect(result.createdFiles).toContain("skills.mcps.json");
    expect(result.createdFiles).toContain("strongcode.config.yaml");
    expect(result.createdFiles).toContain("config/retention.json");
    expect(await readFile(path.join(homePath, "AGENTS.md"), "utf8")).toContain("## Branch Names");

    const agents = JSON.parse(await readFile(path.join(homePath, "agents.json"), "utf8"));
    const providers = JSON.parse(await readFile(path.join(homePath, "providers.json"), "utf8"));
    const resources = JSON.parse(await readFile(path.join(homePath, "skills.mcps.json"), "utf8"));
    const generatedReadme = await readFile(path.join(homePath, "README.md"), "utf8");
    const generatedDirectory = STRONGCODE_HOME_EXPANDED_STARTER_FILES["DIRECTORY.md"]?.content ?? "";

    expect(STRONGCODE_HOME_LAYOUT_VERSION).toBe(10);
    expect(agents.generated).toBe(true);
    expect(agents.reviewOnly).toBe(true);
    expect(agents.runtimeSource).toContain("strongcode.config.yaml");
    expect(agents.runtimeSource).toContain("compiled typed agent registry/factory");
    expect(agents.runtimeSource).toContain("runtime permission enforcement");
    expect(agents.runtimeSource).toContain("not runtime-loaded");
    expect(agents.agents.tesla.omoInspiration).toBe("Sisyphus");
    expect(agents.agents.newton.omoInspiration).toBe("Hephaestus");
    expect(agents.agents.jbp.omoInspiration).toBe("Prometheus");
    expect(agents.agents["bob-the-builder"].omoInspiration).toBe("Atlas");
    expect([
      agents.agents.tesla.compatibilityAlias,
      agents.agents.newton.compatibilityAlias,
      agents.agents.jbp.compatibilityAlias,
      agents.agents["bob-the-builder"].compatibilityAlias
    ]).toEqual(["Sisyphus", "Deep Agent", "Plan Builder", "Atlas-Plan Builder"]);
    expect(JSON.stringify(agents)).not.toContain("legacyName");
    expect(agents.defaultAgent).toBe("tesla");
    expect(agents.agents.tesla.model).toBe("mock");
    expect(agents.agentOrder).toEqual([
      "tesla", "newton", "jbp", "bob-the-builder", "hood-research-department",
      "steve-jobs", "government", "meta", "sugar-boo", "warren-buffer"
    ]);
    expect(agents.agents["hood-research-department"].minimumDistinctModels).toBe(4);
    expect(agents.agents.jbp.handoffTo).toBe("bob-the-builder");
    expect(["bob-the-builder", "sugar-boo"].map(id => agents.agents[id].permissionProfile)).toEqual(["read-only", "read-only"]);
    expect([
      agents.agents.tesla.primaryRole,
      agents.agents.newton.primaryRole,
      agents.agents.jbp.primaryRole,
      agents.agents["bob-the-builder"].primaryRole
    ]).toEqual(["Main Agent", "Deep Worker", "Plan Builder", "Plan Executor"]);
    for (const [agentId, role, primaryRole] of [
      ["tesla", "General agent and outcome owner", "Main Agent"],
      ["newton", "Deep code and systems investigator", "Deep Worker"],
      ["jbp", "Implementation planner", "Plan Builder"],
      ["bob-the-builder", "Approved-plan executor", "Plan Executor"]
    ]) {
      const markdown = await readFile(path.join(homePath, "prompts", "agents", `${agentId}.md`), "utf8");
      expect(markdown).toContain(`- Role: ${role}`);
      expect(markdown).toContain(`- Primary role: \`${primaryRole}\``);
      expect(markdown).toContain("Edits to this file do not affect runtime");
      expect(markdown).toContain("not runtime-loaded");
      expect(markdown).not.toContain("Previous name:");
      expect(markdown).toContain("## System prompt");
    }
    for (const agentId of agents.agentOrder) {
      const markdown = await readFile(path.join(homePath, "prompts", "agents", `${agentId}.md`), "utf8");
      expect(markdown.indexOf("Generated review-only mirror")).toBeGreaterThan(markdown.indexOf(`# ${agents.agents[agentId].displayName}`));
      expect(markdown.indexOf("Generated review-only mirror")).toBeLessThan(markdown.indexOf(`- ID: \`${agentId}\``));
    }
    expect(generatedReadme).toContain("strongcode.config.yaml");
    expect(generatedReadme).toContain("compiled typed agent registry/factory");
    expect(generatedReadme).toContain("runtime permission enforcement");
    expect(generatedReadme).toContain("not runtime-loaded");
    expect(generatedReadme).toContain("`categories.json`");
    expect(generatedReadme).toContain("lower-precedence");
    expect(generatedDirectory).toContain("`agents.json` — generated review/setup mirror");
    expect(generatedDirectory).toContain("`categories.json` — trusted-home category routing");
    expect(generatedDirectory).not.toContain("`agents.json` / `categories.json`");
    expect(await readFile(path.join(homePath, "prompts", "agents", "government.md"), "utf8")).toContain("cross-platform security specialist");
    expect(await readFile(path.join(homePath, "prompts", "agents", "warren-buffer.md"), "utf8")).toContain("Warren Buffer");
    expect(providers.providers.openai.baseUrl).toBe("https://api.openai.com/v1");
    expect(providers.providers.openai.apiKeyEnv).toBe("OPENAI_API_KEY");
    expect(resources.nodeModules.directory).toBe("node_modules");
    expect(JSON.parse(await readFile(path.join(homePath, "config", "retention.json"), "utf8"))).toMatchObject({
      version: 1,
      cacheDays: 30
    });

    for (const directory of STRONGCODE_HOME_DIRECTORIES) {
      expect((await stat(path.join(homePath, directory))).isDirectory()).toBe(true);
    }
    await expect(stat(path.join(homePath, "backups"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(homePath, "settings.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(homePath, "resources.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("describes expanded agents artifacts as generated read-only mirrors", () => {
    const agentsReadme = STRONGCODE_HOME_EXPANDED_STARTER_FILES["agents/README.md"]?.content ?? "";
    const schema = JSON.parse(STRONGCODE_HOME_EXPANDED_STARTER_FILES["schemas/agents.schema.json"]?.content ?? "{}");

    expect(agentsReadme).toContain("strongcode.config.yaml");
    expect(agentsReadme).toContain("compiled typed agent registry/factory");
    expect(agentsReadme).not.toContain("Routing lives in `../agents.json`");
    expect(schema.title).toContain("generated review-only");
    expect(schema.description).toContain("not runtime-loaded");
    expect(schema.readOnly).toBe(true);
    expect(schema.required).toEqual(expect.arrayContaining(["generated", "reviewOnly", "runtimeSource"]));
    expect(schema.properties.generated.const).toBe(true);
    expect(schema.properties.reviewOnly.const).toBe(true);
    expect(schema.properties.runtimeSource.type).toBe("string");
    expect(schema.properties.agents.additionalProperties.properties.mode.enum).toEqual(["primary", "subagent"]);
  });

  it("recognizes each exact immediately preceding generated home doc hash once", async () => {
    const priorReadme = await readFile(path.join(process.cwd(), "tests", "fixtures", "strongcode-home-v8-readme.md"));
    const priorDirectory = await readFile(path.join(process.cwd(), "tests", "fixtures", "strongcode-home-v8-directory.md"));

    expect(createHash("sha256").update(priorReadme).digest("hex")).toBe("febcc57ec494626888dc08c25ea12622e2b0f8d7258bf9009df47743954ab005");
    expect(createHash("sha256").update(priorDirectory).digest("hex")).toBe("23b1bfcbdff12eca0e85cf013512a2084b303c44396142c4791767724b5b4bcb");
    expect(STRONGCODE_HOME_LEGACY_HASHES["README.md"]?.filter(hash => hash === "febcc57ec494626888dc08c25ea12622e2b0f8d7258bf9009df47743954ab005")).toHaveLength(1);
    expect(STRONGCODE_HOME_LEGACY_HASHES["DIRECTORY.md"]?.filter(hash => hash === "23b1bfcbdff12eca0e85cf013512a2084b303c44396142c4791767724b5b4bcb")).toHaveLength(1);
  });

  it("recognizes every immediately preceding generated agent mirror for upgrade", () => {
    expect(STRONGCODE_HOME_LEGACY_HASHES["agents.json"]).toContain("821ec04bc569e95ebd76131a64a00d446773f66ff08cdeb01b695e4feaf7561e");
    expect(STRONGCODE_HOME_LEGACY_HASHES["prompts/agents/tesla.md"]).toContain("c01122303397d1edeff4cf9a02bafd7f5fc55d4a7a6987bf9ba5ffb93fbeca22");
    expect(STRONGCODE_HOME_LEGACY_HASHES["prompts/agents/newton.md"]).toContain("383c44e2e15a192ace9779a7e378562d103155e4639c5022ec37ff98e6c7c46e");
    expect(STRONGCODE_HOME_LEGACY_HASHES["prompts/agents/jbp.md"]).toContain("bdd669e84d75822abd613b33b7fc1fc03bf8ea09659b2e57f5ec4da658869a52");
    expect(STRONGCODE_HOME_LEGACY_HASHES["prompts/agents/bob-the-builder.md"]).toContain("1e97a2d15dc9e5276ef7958779c5ca9d3122588e08d9284b1b0b89058574cd44");
    expect(STRONGCODE_HOME_LEGACY_HASHES["prompts/agents/hood-research-department.md"]).toContain("f4e390769a29c286dc5eaf923e67f8cbcf5435bda761adb253e4ed4291ddc8ad");
    expect(STRONGCODE_HOME_LEGACY_HASHES["prompts/agents/steve-jobs.md"]).toContain("12e248ba0417920e393b494b6eae88d27d7ddafaef02ce229b8883d69e99679f");
    expect(STRONGCODE_HOME_LEGACY_HASHES["prompts/agents/government.md"]).toContain("a13e118d9b267f8ec575547dba77dd236ee1ab077adf4f6155f4e942e0ff3b7e");
    expect(STRONGCODE_HOME_LEGACY_HASHES["prompts/agents/meta.md"]).toContain("893b1d5ec9883a068d602277b956eafbefe599dcd68aa7222140e14d8befdb1f");
    expect(STRONGCODE_HOME_LEGACY_HASHES["prompts/agents/sugar-boo.md"]).toContain("4f519b3b370b838467fd8ee11f46599f470451a3834ce359d88cc4a8f2628808");
    expect(STRONGCODE_HOME_LEGACY_HASHES["prompts/agents/warren-buffer.md"]).toContain("d3cc181232adfc1b97f3862b6207a71a3ca90e78ea4d151ea8d087a4de7f4116");
  });

  it("explicitly upgrades a byte-identical prior generated home README", async () => {
    // Given
    const homePath = await mkdtemp(path.join(os.tmpdir(), "strongcode-home-expand-docs-"));
    const prior = await readFile(path.join(process.cwd(), "tests", "fixtures", "strongcode-home-v8-readme.md"), "utf8");
    await writeFile(path.join(homePath, "README.md"), prior, "utf8");

    // When
    const expanded = await ensureStrongCodeHome({ homePath, expand: true });

    // Then
    expect(expanded.upgradedFiles).toContain("README.md");
  }, 60_000);

  it("preserves a customized prior generated home README during explicit expansion", async () => {
    // Given
    const homePath = await mkdtemp(path.join(os.tmpdir(), "strongcode-home-expand-custom-docs-"));
    const prior = await readFile(path.join(process.cwd(), "tests", "fixtures", "strongcode-home-v8-readme.md"), "utf8");
    const customized = prior.replace("# StrongCode Home", "# Customized StrongCode Home");
    await writeFile(path.join(homePath, "README.md"), customized, "utf8");

    // When
    const expanded = await ensureStrongCodeHome({ homePath, expand: true });

    // Then
    expect(expanded.preservedFiles).toContain("README.md");
    expect(await readFile(path.join(homePath, "README.md"), "utf8")).toBe(customized);
  }, 60_000);

  it("is idempotent and never overwrites an existing config", async () => {
    const homePath = await mkdtemp(path.join(os.tmpdir(), "strongcode-home-existing-"));
    const agentsPath = path.join(homePath, "agents.json");
    const customAgents = '{"agents":{"custom":{"model":"local/custom"}}}\n';
    await writeFile(agentsPath, customAgents, "utf8");

    const first = await ensureStrongCodeHome({ homePath });
    const second = await ensureStrongCodeHome({ homePath });

    expect(first.existingFiles).toContain("agents.json");
    expect(second.existingFiles).toContain("agents.json");
    expect(await readFile(agentsPath, "utf8")).toBe(customAgents);
  });

  it("explicitly expands only a byte-identical generated starter file", async () => {
    const homePath = await mkdtemp(path.join(os.tmpdir(), "strongcode-home-expand-"));
    const agentsPath = path.join(homePath, "agents.json");
    const originalGeneratedAgents = `${JSON.stringify({
      version: 1,
      agents: {
        sisyphus: { model: "openai/gpt-5.5" }
      }
    }, null, 2)}\n`;
    await writeFile(agentsPath, originalGeneratedAgents, "utf8");

    const expanded = await ensureStrongCodeHome({ homePath, expand: true });
    const agents = JSON.parse(await readFile(agentsPath, "utf8"));

    expect(expanded.upgradedFiles).toContain("agents.json");
    expect(agents.defaultAgent).toBe("tesla");
    expect(agents.agents.tesla.model).toBe("mock");
    expect(agents.agents.meta.enabled).toBe(true);
  });

  it("preserves a customized starter even during explicit expansion", async () => {
    const homePath = await mkdtemp(path.join(os.tmpdir(), "strongcode-home-expand-custom-"));
    const agentsPath = path.join(homePath, "agents.json");
    const customized = '{"version":1,"agents":{"sisyphus":{"model":"local/my-model"}}}\n';
    await writeFile(agentsPath, customized, "utf8");

    const expanded = await ensureStrongCodeHome({ homePath, expand: true });

    expect(expanded.preservedFiles).toContain("agents.json");
    expect(await readFile(agentsPath, "utf8")).toBe(customized);
  });

  it("upgrades an untouched prior generated prompt during explicit expansion", async () => {
    // Given
    const homePath = await mkdtemp(path.join(os.tmpdir(), "strongcode-home-expand-prompt-"));
    const promptPath = path.join(homePath, "prompts", "agents", "tesla.md");
    await ensureStrongCodeHome({ homePath });
    const priorGeneratedPrompt = await readFile(path.join(process.cwd(), "tests", "fixtures", "strongcode-home-v6-tesla.md"), "utf8");
    await writeFile(promptPath, priorGeneratedPrompt, "utf8");

    // When
    const expanded = await ensureStrongCodeHome({ homePath, expand: true });

    // Then
    expect(expanded.upgradedFiles).toContain("prompts/agents/tesla.md");
    expect(await readFile(promptPath, "utf8")).toContain("Edits to this file do not affect runtime");
  });

  it("preserves a customized prior generated prompt during explicit expansion", async () => {
    // Given
    const homePath = await mkdtemp(path.join(os.tmpdir(), "strongcode-home-expand-custom-prompt-"));
    const promptPath = path.join(homePath, "prompts", "agents", "tesla.md");
    await ensureStrongCodeHome({ homePath });
    const priorGeneratedPrompt = await readFile(path.join(process.cwd(), "tests", "fixtures", "strongcode-home-v6-tesla.md"), "utf8");
    const customizedPrompt = priorGeneratedPrompt.replace("# Tesla", "# My Tesla");
    await writeFile(promptPath, customizedPrompt, "utf8");

    // When
    const expanded = await ensureStrongCodeHome({ homePath, expand: true });

    // Then
    expect(expanded.preservedFiles).toContain("prompts/agents/tesla.md");
    expect(await readFile(promptPath, "utf8")).toBe(customizedPrompt);
  });

  it("publishes complete files under concurrent first-run bootstraps", async () => {
    const homePath = path.join(await mkdtemp(path.join(os.tmpdir(), "strongcode-home-race-")), "home");
    const results = await Promise.all(Array.from({ length: 12 }, () => ensureStrongCodeHome({ homePath })));
    const paths = await readdir(homePath, { recursive: true });
    const jsonPaths = paths.filter(relativePath => relativePath.endsWith(".json"));

    expect(results.every(result => result.conflicts.length === 0)).toBe(true);
    expect(jsonPaths.length).toBeGreaterThanOrEqual(10);
    for (const relativePath of jsonPaths) {
      expect(() => JSON.parse(require("node:fs").readFileSync(path.join(homePath, relativePath), "utf8"))).not.toThrow();
    }
    expect(paths.some(relativePath => relativePath.endsWith(".tmp"))).toBe(false);
  });

  it("reports path-type conflicts without replacing them", async () => {
    const homePath = await mkdtemp(path.join(os.tmpdir(), "strongcode-home-conflict-"));
    const skillsPath = path.join(homePath, "skills");
    await writeFile(skillsPath, "owned by the user\n", "utf8");

    const result = await ensureStrongCodeHome({ homePath });

    expect(result.conflicts).toContainEqual(expect.objectContaining({ path: "skills" }));
    expect(await readFile(skillsPath, "utf8")).toBe("owned by the user\n");
  });

  it("blocks the complete prompts subtree when prompts is a regular file", async () => {
    // Given
    const homePath = await mkdtemp(path.join(os.tmpdir(), "strongcode-home-file-conflict-"));
    const promptsPath = path.join(homePath, "prompts");
    await writeFile(promptsPath, "owned by the user\n", "utf8");

    // When
    const result = await ensureStrongCodeHome({ homePath, expand: true });

    // Then
    expect(result.conflicts).toEqual([
      { path: "prompts", reason: "Expected a directory but found a file" }
    ]);
    expect(await readFile(promptsPath, "utf8")).toBe("owned by the user\n");
    for (const paths of [result.createdDirectories, result.existingDirectories, result.createdFiles, result.existingFiles, result.upgradedFiles, result.preservedFiles]) {
      expect(paths.filter(relativePath => relativePath.startsWith("prompts/"))).toEqual([]);
    }
  });

  it("blocks the complete prompts subtree when prompts links to an external directory", async () => {
    // Given
    const root = await mkdtemp(path.join(os.tmpdir(), "strongcode-home-link-conflict-"));
    const homePath = path.join(root, "home");
    const externalPath = path.join(root, "external");
    const sentinel = Buffer.from([0x00, 0x53, 0x74, 0x72, 0x6f, 0x6e, 0x67, 0xff]);
    await mkdir(homePath);
    await mkdir(externalPath);
    await writeFile(path.join(externalPath, "sentinel.bin"), sentinel);
    try {
      await symlink(externalPath, path.join(homePath, "prompts"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error.code === "EPERM" || error.code === "ENOTSUP")) return;
      throw error;
    }
    const entriesBefore = await readdir(externalPath, { recursive: true });

    // When
    const result = await ensureStrongCodeHome({ homePath, expand: true });

    // Then
    expect(result.conflicts).toEqual([
      { path: "prompts", reason: "Expected a directory but found a symlink" }
    ]);
    expect(await readdir(externalPath, { recursive: true })).toEqual(entriesBefore);
    expect(await readFile(path.join(externalPath, "sentinel.bin"))).toEqual(sentinel);
    await expect(stat(path.join(externalPath, "agents"))).rejects.toMatchObject({ code: "ENOENT" });
    for (const paths of [result.createdDirectories, result.existingDirectories, result.createdFiles, result.existingFiles, result.upgradedFiles, result.preservedFiles]) {
      expect(paths.filter(relativePath => relativePath.startsWith("prompts/"))).toEqual([]);
    }
  });
});
