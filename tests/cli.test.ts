import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createProgram } from "../src/cli";
import { ProviderAuthStore } from "../src/models/auth-store";
import { tempWorkspace } from "./helpers";

async function runCli(args: string[]): Promise<{ stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = createProgram();
  program.configureOutput({
    writeOut: text => stdout.push(text),
    writeErr: text => stderr.push(text)
  });
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (message?: unknown) => stdout.push(String(message ?? ""));
  console.error = (message?: unknown) => stderr.push(String(message ?? ""));
  try {
    await program.parseAsync(["node", "strongcode", ...args]);
    return { stdout, stderr };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

describe("cli", () => {
  it("validates config, lists tools, runs hello, and shows a session", async () => {
    const workspace = await tempWorkspace();
    const configPath = path.join(workspace.root, "strongcode.config.yaml");
    await writeFile(configPath, `version: 1
workspace: "."
dataDir: ".strongcode"
defaultAgent: default
agents:
  default:
    model: mock
    tools:
      - list_files
      - read_file
models:
  mock:
    provider: mock
permissions:
  tools:
    list_files: allow
    read_file: allow
`, "utf8");

    const validate = await runCli(["config", "validate", "--config", configPath]);
    const tools = await runCli(["tools", "list", "--config", configPath]);
    const run = await runCli(["run", "hello", "--config", configPath, "--session", "smoke"]);
    const session = await runCli(["session", "show", "smoke", "--config", configPath]);

    expect(validate.stdout.join("")).toContain("Config valid");
    expect(tools.stdout.join("")).toContain("list_files");
    expect(run.stdout.join("")).toContain("Mock response: hello");
    expect(session.stdout.join("")).toContain("hello");
    
    // Verify TUI header is not printed
    expect(validate.stdout.join("")).not.toContain("StrongCode");
  });

  it("runs OpenAI-compatible models with auth.json credentials", async () => {
    const workspace = await tempWorkspace();
    const configPath = path.join(workspace.root, "strongcode.config.yaml");
    await writeFile(configPath, `version: 1
workspace: "."
dataDir: ".strongcode"
defaultAgent: default
providers:
  custom:
    type: openai-compatible
    displayName: Custom Provider
    apiKeyEnv: STRONGCODE_TEST_API_KEY
    baseUrl: https://example.com/v1
    modelsEndpoint: /models
    enabled: true
agents:
  default:
    model: custom-model
    tools: []
models:
  custom-model:
    provider: custom
    model: provider-model
    enabled: true
permissions:
  tools: {}
`, "utf8");
    await new ProviderAuthStore(workspace.context.dataDir).set("custom", { type: "api", key: "auth-json-key" });

    const originalApiKey = process.env.STRONGCODE_TEST_API_KEY;
    const originalFetch = globalThis.fetch;
    const calls: Array<{ authorization: string | undefined }> = [];
    delete process.env.STRONGCODE_TEST_API_KEY;
    globalThis.fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({ authorization: headers.get("authorization") ?? undefined });
      return new Response(JSON.stringify({ choices: [{ message: { content: "auth store response" } }] }), { status: 200 });
    };

    try {
      const run = await runCli(["run", "hello", "--config", configPath, "--session", "auth-json"]);

      expect(run.stdout.join("")).toContain("auth store response");
      expect(calls).toEqual([{ authorization: "Bearer auth-json-key" }]);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalApiKey === undefined) delete process.env.STRONGCODE_TEST_API_KEY;
      else process.env.STRONGCODE_TEST_API_KEY = originalApiKey;
    }
  });
});
