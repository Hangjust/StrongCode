import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { atomicReplaceExpectedSource, sha256Source } from "../src/config/save";
import { strongCodeConfigSchema } from "../src/config/schema";
import { selectedMcpEnvironment } from "../src/mcp/client";
import { mcpConfigSchema } from "../src/mcp/config";
import {
  BLENDER_MANAGED_MARKER,
  planBlenderMcpSource,
  planBlenderPermissionsSource,
  planGlobalBlenderConfigMerge
} from "../src/setup/blender/config-merge";

const WINDOWS = process.platform === "win32";
const pythonPath = path.resolve("venv", WINDOWS ? "Scripts/python.exe" : "bin/python");
const wrapperPath = path.resolve("managed", "blender-mcp-wrapper.py");
const privateConfigPath = path.resolve("private", "blender.json");
const managedPaths = { pythonPath, wrapperPath, privateConfigPath };

function mcpSource(servers: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    version: 1,
    defaults: {
      autoStart: false,
      timeout: { startupMs: 15000, requestMs: 60000 },
      environment: { inherit: false, allowlist: ["PATH"] }
    },
    mcpServers: servers,
    webSearch: { providers: [] },
    templates: { custom: { preserved: true } }
  }, null, 2)}\n`;
}

const yamlSource = `# user heading
version: 1
workspace: .
dataDir: .strongcode
defaultAgent: tesla
agents:
  tesla:
    model: mock
    tools: [read_file]
models:
  mock:
    provider: mock
permissions:
  tools:
    read_file: allow # user rule
`;

describe("Blender config merge planning", () => {
  it("plans a managed local MCP server while preserving unrelated JSON data", () => {
    // Given
    const source = mcpSource({ user_server: { type: "local", command: ["user-command"], enabled: false } });

    // When
    const plan = planBlenderMcpSource(source, managedPaths);
    const result = JSON.parse(plan.content);

    // Then
    expect(plan.changed).toBe(true);
    expect(result.templates).toEqual({ custom: { preserved: true } });
    expect(result.mcpServers.user_server).toEqual({ type: "local", command: ["user-command"], enabled: false });
    expect(result.mcpServers.blender).toEqual({
      description: BLENDER_MANAGED_MARKER,
      enabled: true,
      autoStart: false,
      type: "local",
      readOnly: false,
      command: [pythonPath, "-I", wrapperPath, "--config", privateConfigPath],
      inheritDefaultEnvironment: false,
      environmentFromEnv: [],
      timeout: { startupMs: 30000, requestMs: 180000 }
    });
    const parsed = mcpConfigSchema.parse(result);
    const blender = parsed.mcpServers.blender;
    if (blender.type !== "local" && blender.type !== "stdio") throw new Error("Expected local Blender MCP server");
    expect(selectedMcpEnvironment(parsed, blender, { PATH: "inherited", HOME: "inherited" })).toEqual({});
  });

  it("is idempotent for an already managed MCP entry", () => {
    // Given
    const first = planBlenderMcpSource(mcpSource(), managedPaths);

    // When
    const second = planBlenderMcpSource(first.content, managedPaths);

    // Then
    expect(second).toEqual({ changed: false, content: first.content });
  });

  it("treats reordered managed MCP fields as semantically unchanged", () => {
    // Given
    const first = planBlenderMcpSource(mcpSource(), managedPaths);
    const config = JSON.parse(first.content);
    config.mcpServers.blender = Object.fromEntries(Object.entries(config.mcpServers.blender).reverse());
    const reordered = `${JSON.stringify(config, null, 2)}\n`;

    // When
    const second = planBlenderMcpSource(reordered, managedPaths);

    // Then
    expect(second).toEqual({ changed: false, content: reordered });
  });

  it.each([
    ["normalized server", { "Blender.": { type: "local", command: ["python"] } }],
    ["Blender MCP command", { custom: { type: "local", command: ["uvx", "blender-mcp"] } }],
    ["StrongCode derivative", { custom: { type: "local", command: ["python", "strongcode-blender-wrapper.py"] } }]
  ])("rejects an unowned %s conflict", (_label, servers) => {
    // Given / When / Then
    expect(() => planBlenderMcpSource(mcpSource(servers), managedPaths)).toThrow(/unowned|conflict/i);
  });

  it("adds owned Blender permissions and missing MCP gateways without disturbing YAML comments", () => {
    // Given / When
    const plan = planBlenderPermissionsSource(yamlSource);
    const document = YAML.parseDocument(plan.content);

    // Then
    expect(plan.changed).toBe(true);
    expect(plan.content).toContain("# user heading");
    expect(plan.content).toContain("# user rule");
    expect(document.getIn(["permissions", "tools", "mcp_list_tools"])).toBe("allow");
    expect(document.getIn(["permissions", "tools", "mcp_call"])).toBe("allow");
    expect(document.getIn(["permissions", "tools", "mcp__blender__*"])).toBe("allow");
    expect(document.getIn(["permissions", "tools", "mcp__blender__execute_blender_code"])).toBe("ask");
    expect(plan.content.match(new RegExp(BLENDER_MANAGED_MARKER, "g"))).toHaveLength(2);
  });

  it("adds MCP gateway tools exactly once to only the custom default agent", () => {
    // Given
    const source = yamlSource
      .replace("defaultAgent: tesla", "defaultAgent: custom")
      .replace(`agents:
  tesla:
    model: mock
    tools: [read_file]`, `agents:
  custom:
    model: mock
    tools:
      - custom_tool # keep custom tool
  tesla:
    model: mock
    tools: [read_file]`);

    // When
    const first = planBlenderPermissionsSource(source);
    const second = planBlenderPermissionsSource(first.content);
    const document = YAML.parseDocument(first.content);
    const config = strongCodeConfigSchema.parse(document.toJS());

    // Then
    expect(config.agents.custom.tools).toEqual(["custom_tool", "mcp_list_tools", "mcp_call"]);
    expect(config.agents.tesla.tools).toEqual(["read_file"]);
    expect(first.content).toContain("# keep custom tool");
    expect(first.content.match(/- mcp_list_tools\b/g)).toHaveLength(1);
    expect(first.content.match(/- mcp_call\b/g)).toHaveLength(1);
    expect(second).toEqual({ changed: false, content: first.content });
  });

  it("rejects a default agent whose tools are not a YAML sequence", () => {
    // Given
    const source = yamlSource.replace("tools: [read_file]", "tools: { read_file: true }");

    // When / Then
    expect(() => planBlenderPermissionsSource(source)).toThrow(/agents.*tools|sequence/i);
  });

  it("preserves stricter MCP permissions and produces an idempotent plan", () => {
    // Given
    const source = yamlSource.replace("read_file: allow # user rule", "read_file: allow # user rule\n    mcp_call: deny");
    const first = planBlenderPermissionsSource(source);

    // When
    const second = planBlenderPermissionsSource(first.content);
    const document = YAML.parseDocument(second.content);

    // Then
    expect(document.getIn(["permissions", "tools", "mcp_call"])).toBe("deny");
    expect(second).toEqual({ changed: false, content: first.content });
  });

  it("restores execute_blender_code to ask when a managed marker is paired with allow", () => {
    // Given
    const managed = planBlenderPermissionsSource(yamlSource).content;
    const permissive = managed.replace(
      `mcp__blender__execute_blender_code: ask # ${BLENDER_MANAGED_MARKER}`,
      `mcp__blender__execute_blender_code: allow # ${BLENDER_MANAGED_MARKER}`
    );

    // When
    const plan = planBlenderPermissionsSource(permissive);

    // Then
    expect(plan.changed).toBe(true);
    expect(YAML.parseDocument(plan.content).getIn(["permissions", "tools", "mcp__blender__execute_blender_code"])).toBe("ask");
  });

  it("rejects preexisting unowned Blender permission keys", () => {
    // Given
    const source = yamlSource.replace("read_file: allow # user rule", "read_file: allow # user rule\n    mcp__blender__*: deny");

    // When / Then
    expect(() => planBlenderPermissionsSource(source)).toThrow(/unowned.*mcp__blender__/i);
  });

  it.each([
    ["malformed MCP JSON", "{", yamlSource],
    ["malformed YAML", mcpSource(), "permissions: ["],
    ["schema-invalid YAML", mcpSource(), "version: 1\npermissions: {}\n"]
  ])("rejects %s without producing a replacement", async (_label, mcp, yaml) => {
    // Given
    const homePath = await mkdtemp(path.join(os.tmpdir(), "strongcode-blender-plan-invalid-"));
    await writeFile(path.join(homePath, "mcp.json"), mcp, "utf8");
    await writeFile(path.join(homePath, "strongcode.config.yaml"), yaml, "utf8");

    // When / Then
    await expect(planGlobalBlenderConfigMerge({ homePath, ...managedPaths })).rejects.toThrow();
  });

  it("rejects oversized and non-regular global config paths", async () => {
    // Given
    const homePath = await mkdtemp(path.join(os.tmpdir(), "strongcode-blender-plan-path-"));
    await writeFile(path.join(homePath, "mcp.json"), "x".repeat(1024 * 1024 + 1), "utf8");
    await symlink(homePath, path.join(homePath, "strongcode.config.yaml"), "junction");

    // When / Then
    await expect(planGlobalBlenderConfigMerge({ homePath, ...managedPaths })).rejects.toThrow(/exceeds|regular|symlink/i);
  });

  it("rejects a symlinked global YAML config", async () => {
    // Given
    const homePath = await mkdtemp(path.join(os.tmpdir(), "strongcode-blender-plan-symlink-"));
    await writeFile(path.join(homePath, "mcp.json"), mcpSource(), "utf8");
    await symlink(homePath, path.join(homePath, "strongcode.config.yaml"), "junction");

    // When / Then
    await expect(planGlobalBlenderConfigMerge({ homePath, ...managedPaths })).rejects.toThrow(/regular|symlink/i);
  });

  it("rejects a global home reached through a junction", async () => {
    // Given
    const root = await mkdtemp(path.join(os.tmpdir(), "strongcode-blender-plan-parent-link-"));
    const realHome = path.join(root, "real-home");
    const linkedHome = path.join(root, "linked-home");
    await mkdir(realHome);
    await writeFile(path.join(realHome, "mcp.json"), mcpSource(), "utf8");
    await writeFile(path.join(realHome, "strongcode.config.yaml"), yamlSource, "utf8");
    await symlink(realHome, linkedHome, "junction");

    // When / Then
    await expect(planGlobalBlenderConfigMerge({ homePath: linkedHome, ...managedPaths })).rejects.toThrow(/symlink|junction/i);
  });

  it("rejects a directory in place of the global MCP config", async () => {
    // Given
    const homePath = await mkdtemp(path.join(os.tmpdir(), "strongcode-blender-plan-directory-"));
    await mkdir(path.join(homePath, "mcp.json"));
    await writeFile(path.join(homePath, "strongcode.config.yaml"), yamlSource, "utf8");

    // When / Then
    await expect(planGlobalBlenderConfigMerge({ homePath, ...managedPaths })).rejects.toThrow(/regular|symlink/i);
  });
});

describe("expected-source-hash replacement", () => {
  it("atomically replaces an unchanged regular file", async () => {
    // Given
    const directory = await mkdtemp(path.join(os.tmpdir(), "strongcode-cas-replace-"));
    const filePath = path.join(directory, "config.yaml");
    await writeFile(filePath, "before\n", "utf8");

    // When
    await atomicReplaceExpectedSource({ filePath, expectedSourceHash: sha256Source("before\n"), content: "after\n" });

    // Then
    expect(await readFile(filePath, "utf8")).toBe("after\n");
  });

  it("rejects stale content and symlink targets without changing either target", async () => {
    // Given
    const directory = await mkdtemp(path.join(os.tmpdir(), "strongcode-cas-reject-"));
    const filePath = path.join(directory, "config.yaml");
    const linkPath = path.join(directory, "linked.yaml");
    await writeFile(filePath, "current\n", "utf8");
    await symlink(directory, linkPath, "junction");

    // When / Then
    await expect(atomicReplaceExpectedSource({ filePath, expectedSourceHash: sha256Source("stale\n"), content: "new\n" })).rejects.toThrow(/changed|stale/i);
    await expect(atomicReplaceExpectedSource({ filePath: linkPath, expectedSourceHash: sha256Source("current\n"), content: "new\n" })).rejects.toThrow(/symlink|regular/i);
    expect(await readFile(filePath, "utf8")).toBe("current\n");
  });

  it("rejects replacement through a junctioned parent", async () => {
    // Given
    const root = await mkdtemp(path.join(os.tmpdir(), "strongcode-cas-parent-link-"));
    const realDirectory = path.join(root, "real");
    const linkedDirectory = path.join(root, "linked");
    await mkdir(realDirectory);
    await writeFile(path.join(realDirectory, "config.yaml"), "current\n", "utf8");
    await symlink(realDirectory, linkedDirectory, "junction");

    // When / Then
    await expect(atomicReplaceExpectedSource({
      filePath: path.join(linkedDirectory, "config.yaml"),
      expectedSourceHash: sha256Source("current\n"),
      content: "new\n"
    })).rejects.toThrow(/symlink|junction/i);
    expect(await readFile(path.join(realDirectory, "config.yaml"), "utf8")).toBe("current\n");
  });
});
