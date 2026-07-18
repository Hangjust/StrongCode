import path from "node:path";
import YAML from "yaml";
import {
  BLENDER_MANAGED_MARKER,
  planBlenderMcpSource,
  planBlenderPermissionsSource,
  type BlenderMcpLaunch,
  type BlenderMcpTransitionProof
} from "../src/setup/blender/config-merge";

const WINDOWS = process.platform === "win32";
const pythonPath = path.resolve("venv", WINDOWS ? "Scripts/python.exe" : "bin/python");
const wrapperPath = path.resolve("managed", "blender-mcp-wrapper.py");
const privateConfigPath = path.resolve("private", "blender.json");
const launcherPath = path.resolve("managed", "official-blender-mcp.py");
const legacyLaunch: BlenderMcpLaunch = {
  flavor: "legacy",
  pythonPath,
  wrapperPath,
  privateConfigPath
};
const officialLaunch: BlenderMcpLaunch = { flavor: "official", pythonPath, launcherPath, privateConfigPath };
const legacyProof: BlenderMcpTransitionProof = {
  predecessorFlavor: "legacy",
  proof: BLENDER_MANAGED_MARKER
};
const officialProof: BlenderMcpTransitionProof = {
  predecessorFlavor: "official",
  proof: BLENDER_MANAGED_MARKER
};

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
    templates: { user: { preserved: true } }
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

describe("Blender MCP launch flavors", () => {
  it("keeps descriptor-based legacy generation byte-equivalent to the compatibility input", () => {
    // Given
    const source = mcpSource();

    // When
    const descriptorPlan = planBlenderMcpSource(source, legacyLaunch);
    const compatibilityPlan = planBlenderMcpSource(source, { pythonPath, wrapperPath, privateConfigPath });

    // Then
    expect(descriptorPlan).toEqual(compatibilityPlan);
    expect(JSON.parse(descriptorPlan.content).mcpServers.blender).toEqual({
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
  });

  it("reports a disabled StrongCode-managed Blender server as repairable drift instead of unowned", () => {
    // Given
    const managed = planBlenderMcpSource(mcpSource(), legacyLaunch);
    const config = JSON.parse(managed.content);
    config.mcpServers.blender.enabled = false;
    config.templates.user.preserved = "still-user-owned";
    const drifted = `${JSON.stringify(config, null, 2)}\n`;

    // When
    const plan = planBlenderMcpSource(drifted, legacyLaunch);
    const repaired = JSON.parse(plan.content);

    // Then
    expect(plan.changed).toBe(true);
    expect(repaired.mcpServers.blender.enabled).toBe(true);
    expect(repaired.templates.user.preserved).toBe("still-user-owned");
  });

  it("generates an isolated local official stdio launch without URL or environment bridges", () => {
    // Given / When
    const plan = planBlenderMcpSource(mcpSource(), officialLaunch);
    const server = JSON.parse(plan.content).mcpServers.blender;

    // Then
    expect(server).toEqual({
      description: BLENDER_MANAGED_MARKER,
      enabled: true,
      autoStart: false,
      type: "local",
      readOnly: false,
      command: [pythonPath, "-I", launcherPath, "--strongcode-config", privateConfigPath],
      inheritDefaultEnvironment: false,
      environmentFromEnv: [],
      timeout: { startupMs: 30000, requestMs: 180000 }
    });
    expect(server).not.toHaveProperty("url");
    expect(server).not.toHaveProperty("headersFromEnv");
  });

  it("sets only the managed Blender wildcard to ask for a fresh official launch", () => {
    // Given / When
    const plan = planBlenderPermissionsSource(yamlSource, officialLaunch);
    const document = YAML.parseDocument(plan.content);

    // Then
    expect(document.getIn(["permissions", "tools", "mcp__blender__*"])).toBe("ask");
    expect(document.hasIn(["permissions", "tools", "mcp__blender__execute_blender_code"])).toBe(false);
    expect(plan.content).toContain("# user heading");
    expect(plan.content).toContain("# user rule");
  });

  it("rejects an implicit managed legacy-to-official server transition", () => {
    // Given
    const legacy = planBlenderMcpSource(mcpSource(), legacyLaunch).content;

    // When / Then
    expect(() => planBlenderMcpSource(legacy, officialLaunch)).toThrow(/transition|predecessor|proof|authorized/i);
  });

  it("replaces a proven managed legacy server during an authorized official transition", () => {
    // Given
    const legacy = planBlenderMcpSource(mcpSource(), legacyLaunch).content;

    // When
    const plan = planBlenderMcpSource(legacy, officialLaunch, legacyProof);

    // Then
    expect(JSON.parse(plan.content).mcpServers.blender.command)
      .toEqual([pythonPath, "-I", launcherPath, "--strongcode-config", privateConfigPath]);
  });

  it("rejects transition proof for the wrong managed predecessor flavor", () => {
    // Given
    const legacy = planBlenderMcpSource(mcpSource(), legacyLaunch).content;
    const wrongProof: BlenderMcpTransitionProof = {
      predecessorFlavor: "official",
      proof: BLENDER_MANAGED_MARKER
    };

    // When / Then
    expect(() => planBlenderMcpSource(legacy, officialLaunch, wrongProof)).toThrow(/predecessor|proof/i);
  });

  it("rejects a marker-only server whose launch shape is not StrongCode-owned", () => {
    // Given
    const source = mcpSource({
      blender: {
        description: BLENDER_MANAGED_MARKER,
        enabled: true,
        autoStart: false,
        type: "local",
        readOnly: false,
        command: [pythonPath, "-I", launcherPath, "--unexpected"],
        inheritDefaultEnvironment: false,
        environmentFromEnv: [],
        timeout: { startupMs: 30000, requestMs: 180000 }
      }
    });

    // When / Then
    expect(() => planBlenderMcpSource(source, officialLaunch, legacyProof)).toThrow(/unowned|conflict/i);
  });

  it("removes the managed legacy execute exception only with matching transition proof", () => {
    // Given
    const legacy = planBlenderPermissionsSource(yamlSource, legacyLaunch).content;

    // When / Then
    expect(() => planBlenderPermissionsSource(legacy, officialLaunch)).toThrow(/transition|predecessor|proof|authorized/i);
    const transitioned = planBlenderPermissionsSource(legacy, officialLaunch, legacyProof);
    const document = YAML.parseDocument(transitioned.content);
    expect(document.getIn(["permissions", "tools", "mcp__blender__*"])).toBe("ask");
    expect(document.hasIn(["permissions", "tools", "mcp__blender__execute_blender_code"])).toBe(false);
  });

  it("preserves a managed user deny while transitioning to official permissions", () => {
    // Given
    const legacy = planBlenderPermissionsSource(yamlSource, legacyLaunch).content;
    const denied = legacy.replace(
      `mcp__blender__execute_blender_code: ask # ${BLENDER_MANAGED_MARKER}`,
      `mcp__blender__execute_blender_code: deny # ${BLENDER_MANAGED_MARKER}`
    );

    // When
    const plan = planBlenderPermissionsSource(denied, officialLaunch, legacyProof);
    const document = YAML.parseDocument(plan.content);

    // Then
    expect(document.getIn(["permissions", "tools", "mcp__blender__execute_blender_code"])).toBe("deny");
    expect(planBlenderPermissionsSource(plan.content, officialLaunch)).toEqual({ changed: false, content: plan.content });
  });

  it("requires official predecessor proof for a reverse plan with a retained managed deny", () => {
    // Given
    const legacy = planBlenderPermissionsSource(yamlSource, legacyLaunch).content;
    const denied = legacy.replace(
      `mcp__blender__execute_blender_code: ask # ${BLENDER_MANAGED_MARKER}`,
      `mcp__blender__execute_blender_code: deny # ${BLENDER_MANAGED_MARKER}`
    );
    const official = planBlenderPermissionsSource(denied, officialLaunch, legacyProof).content;

    // When / Then
    expect(() => planBlenderPermissionsSource(official, legacyLaunch)).toThrow(/predecessor|proof/i);
  });

  it("changes the managed official wildcard to legacy allow and is idempotent", () => {
    // Given
    const official = planBlenderPermissionsSource(yamlSource, officialLaunch).content;

    // When
    const transitioned = planBlenderPermissionsSource(official, legacyLaunch, officialProof);
    const document = YAML.parseDocument(transitioned.content);

    // Then
    expect(document.getIn(["permissions", "tools", "mcp__blender__*"])).toBe("allow");
    expect(document.getIn(["permissions", "tools", "mcp__blender__execute_blender_code"])).toBe("ask");
    expect(planBlenderPermissionsSource(transitioned.content, legacyLaunch))
      .toEqual({ changed: false, content: transitioned.content });
  });

  it("preserves a managed wildcard deny during an official to legacy transition", () => {
    // Given
    const official = planBlenderPermissionsSource(yamlSource, officialLaunch).content;
    const denied = official.replace(
      `mcp__blender__*: ask # ${BLENDER_MANAGED_MARKER}`,
      `mcp__blender__*: deny # ${BLENDER_MANAGED_MARKER}`
    );

    // When
    const transitioned = planBlenderPermissionsSource(denied, legacyLaunch, officialProof);
    const document = YAML.parseDocument(transitioned.content);

    // Then
    expect(document.getIn(["permissions", "tools", "mcp__blender__*"])).toBe("deny");
    expect(document.getIn(["permissions", "tools", "mcp__blender__execute_blender_code"])).toBe("ask");
  });

  it("rejects unowned legacy permission removal even with transition proof", () => {
    // Given
    const unowned = yamlSource.replace(
      "read_file: allow # user rule",
      "read_file: allow # user rule\n    mcp__blender__execute_blender_code: ask"
    );

    // When / Then
    expect(() => planBlenderPermissionsSource(unowned, officialLaunch, legacyProof)).toThrow(/unowned.*mcp__blender__/i);
  });

  it("rejects unrelated unowned exact permissions in the managed Blender namespace", () => {
    // Given
    const unowned = yamlSource.replace(
      "read_file: allow # user rule",
      "read_file: allow # user rule\n    mcp__blender__render_scene: deny"
    );

    // When / Then
    expect(() => planBlenderPermissionsSource(unowned, officialLaunch)).toThrow(/mcp__blender__render_scene|conflict/i);
  });
});
