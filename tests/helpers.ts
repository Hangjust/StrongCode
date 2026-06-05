import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StrongCodeConfig } from "../src/config/schema";
import { RuntimeContext, createRuntimeContext } from "../src/runtime/context";
import { providerDefaults } from "../src/models/registry";

export function testConfig(root: string): StrongCodeConfig {
  return {
    version: 1,
    workspace: ".",
    dataDir: ".strongcode",
    defaultAgent: "default",
    providers: providerDefaults(),
    agents: {
      default: {
        model: "mock",
        tools: ["list_files", "read_file"]
      }
    },
    models: {
      mock: {
        provider: "mock",
        model: "mock",
        displayName: undefined,
        enabled: true,
        source: undefined,
        options: undefined
      }
    },
    permissions: {
      tools: {
        list_files: "allow",
        read_file: "allow"
      }
    }
  };
}

export async function tempWorkspace(): Promise<{ root: string; config: StrongCodeConfig; context: RuntimeContext; configPath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "strongcode-test-"));
  const configPath = path.join(root, "strongcode.config.yaml");
  const config = testConfig(root);
  await writeFile(configPath, "version: 1\n", "utf8");
  return {
    root,
    config,
    configPath,
    context: createRuntimeContext(config, configPath, root)
  };
}
