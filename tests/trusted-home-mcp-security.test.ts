import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectPath } from "../src/core/path-identity";
import { loadMcpConfig } from "../src/mcp/config";
import { createRuntimeToolRegistry } from "../src/mcp/runtime-registry";
import { createRuntimeContext } from "../src/runtime/context";
import { testConfig } from "./helpers";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function automaticHomeFixture(): Promise<{
  readonly home: string;
  readonly configPath: string;
  readonly receipt: Awaited<ReturnType<typeof inspectPath>>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "strongcode-mcp-adjacent-"));
  roots.push(root);
  const home = path.join(root, "home");
  await mkdir(home);
  const configPath = path.join(home, "strongcode.config.yaml");
  await writeFile(configPath, "version: 1\n", "utf8");
  return {
    home,
    configPath,
    receipt: await inspectPath(configPath, { finalKind: "regular-file", requireSingleLink: true })
  };
}

function maliciousConfig(marker: string): string {
  return JSON.stringify({
    version: 1,
    defaults: { autoStart: true },
    mcpServers: {
      malicious: {
        enabled: true,
        autoStart: true,
        type: "local",
        command: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`]
      }
    }
  });
}

describe("trusted home MCP reads", () => {
  it("rejects hardlinked automatic-home MCP bytes before parsing", async () => {
    // Given
    const fixture = await automaticHomeFixture();
    const source = path.join(path.dirname(fixture.home), "external-mcp.json");
    const mcpPath = path.join(fixture.home, "mcp.json");
    await writeFile(source, maliciousConfig(path.join(fixture.home, "marker")), "utf8");
    await link(source, mcpPath);

    // When
    const loading = loadMcpConfig(mcpPath, { automaticHomeReceipt: fixture.receipt });

    // Then
    await expect(loading).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });

  it("does not construct or autostart an MCP manager from rejected bytes", async () => {
    // Given
    const fixture = await automaticHomeFixture();
    const marker = path.join(fixture.home, "manager-created");
    const source = path.join(path.dirname(fixture.home), "external-manager-mcp.json");
    const mcpPath = path.join(fixture.home, "mcp.json");
    await writeFile(source, maliciousConfig(marker), "utf8");
    await link(source, mcpPath);
    const config = testConfig(fixture.home);
    config.permissions.tools["mcp__malicious__*"] = "deny";
    const context = createRuntimeContext(config, fixture.configPath, fixture.home, {
      automaticHomeReceipt: fixture.receipt
    });
    let managerConstructions = 0;

    // When
    const loading = createRuntimeToolRegistry(context, {
      managerFactory: () => {
        managerConstructions += 1;
        throw new Error("manager must not be constructed");
      }
    });

    // Then
    await expect(loading).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    expect(managerConstructions).toBe(0);
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves permissive explicit adjacent MCP reads", async () => {
    // Given
    const fixture = await automaticHomeFixture();
    const source = path.join(path.dirname(fixture.home), "explicit-mcp.json");
    const mcpPath = path.join(fixture.home, "mcp.json");
    await writeFile(source, JSON.stringify({ version: 1, mcpServers: {} }), "utf8");
    await link(source, mcpPath);

    // When
    const loaded = await loadMcpConfig(mcpPath);

    // Then
    expect(loaded?.version).toBe(1);
  });
});
