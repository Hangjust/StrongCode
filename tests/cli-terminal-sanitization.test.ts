import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createProgram, main, type CliDependencies } from "../src/cli";
import { StrongCodeError } from "../src/core/errors";
import { tempWorkspace } from "./helpers";

type CliOutput = {
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
};

async function writeMockConfig(configPath: string): Promise<void> {
  await writeFile(configPath, `version: 1
workspace: "."
dataDir: ".strongcode"
defaultAgent: default
agents:
  default:
    model: mock
    tools: []
models:
  mock:
    provider: mock
permissions:
  tools: {}
`, "utf8");
}

async function runProgram(args: readonly string[], dependencies: CliDependencies = {}): Promise<CliOutput> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previousHome = process.env.STRONGCODE_HOME;
  if (dependencies.homePath) process.env.STRONGCODE_HOME = dependencies.homePath;
  const program = createProgram(dependencies);
  program.configureOutput({
    writeOut: text => stdout.push(text),
    writeErr: text => stderr.push(text)
  });
  const log = vi.spyOn(console, "log").mockImplementation(message => {
    stdout.push(String(message ?? ""));
  });
  const error = vi.spyOn(console, "error").mockImplementation(message => {
    stderr.push(String(message ?? ""));
  });
  try {
    await program.parseAsync(["node", "strongcode", ...args]);
    return { stdout, stderr };
  } finally {
    if (previousHome === undefined) delete process.env.STRONGCODE_HOME;
    else process.env.STRONGCODE_HOME = previousHome;
    log.mockRestore();
    error.mockRestore();
  }
}

async function runMainWithError(message: string, homePath: string): Promise<CliOutput> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previousExitCode = process.exitCode;
  const log = vi.spyOn(console, "log").mockImplementation(value => {
    stdout.push(String(value ?? ""));
  });
  const error = vi.spyOn(console, "error").mockImplementation(value => {
    stderr.push(String(value ?? ""));
  });
  try {
    await main(["node", "strongcode", "setup"], {
      homePath,
      runSetup: async () => {
        throw new StrongCodeError("CONFIG_ERROR", message);
      }
    });
    return { stdout, stderr };
  } finally {
    process.exitCode = previousExitCode;
    log.mockRestore();
    error.mockRestore();
  }
}

async function runCommanderFailure(args: readonly string[]): Promise<CliOutput & { readonly errorName?: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = createProgram();
  program.configureOutput({
    writeOut: text => stdout.push(text),
    writeErr: text => stderr.push(text)
  });
  let errorName: string | undefined;
  try {
    await program.parseAsync(["node", "strongcode", ...args]);
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "CommanderError") throw error;
    errorName = error.name;
  }
  return { stdout, stderr, errorName };
}

describe("CLI terminal sanitization", () => {
  it("sanitizes a raw model response before writing it to stdout", async () => {
    // Given
    const workspace = await tempWorkspace();
    await writeMockConfig(workspace.configPath);
    const untrustedPrompt = "visible\u001B]2;forged title\u0007 tail\nsecond\tcolumn";

    // When
    const output = await runProgram([
      "run",
      untrustedPrompt,
      "--config",
      workspace.configPath,
      "--session",
      "terminal-model-output"
    ], { homePath: workspace.root });

    // Then
    expect(output.stdout.join("\n")).toBe("Mock response: visible tail\nsecond\tcolumn");
    expect(output.stderr).toEqual([]);
  });

  it("sanitizes a dynamic StrongCodeError before writing it to stderr", async () => {
    // Given
    const homePath = await mkdtemp(path.join(tmpdir(), "strongcode-terminal-error-"));
    const untrustedMessage = "operation failed\u001B]2;forged title\u0007 safely\nsecond\tline";

    // When
    const output = await runMainWithError(untrustedMessage, homePath);

    // Then
    expect(output.stderr.join("\n")).toBe("CONFIG_ERROR: operation failed safelysecondline");
    expect(output.stdout).toEqual([]);
  });

  it("keeps session-show JSON parseable while sanitizing raw C1 transcript strings", async () => {
    // Given
    const workspace = await tempWorkspace();
    await writeMockConfig(workspace.configPath);
    const sessionId = "terminal-c1-json-framing";
    const prompts = [
      { untrusted: "osc-left\u009D52;c;spoof\u0007osc-right", safe: "osc-leftosc-right" },
      { untrusted: "csi-left\u009B31", safe: "csi-left" },
      { untrusted: "dcs-left\u0090spoof\u009Cdcs-right", safe: "dcs-leftdcs-right" }
    ] as const;
    for (const prompt of prompts) {
      await runProgram([
        "run",
        prompt.untrusted,
        "--config",
        workspace.configPath,
        "--session",
        sessionId
      ], { homePath: workspace.root });
    }

    // When
    const output = await runProgram([
      "session",
      "show",
      sessionId,
      "--config",
      workspace.configPath
    ], { homePath: workspace.root });

    // Then
    const events = output.stdout.map(line => JSON.parse(line));
    const contents = events
      .filter(event => event.type === "message")
      .map(event => event.content);
    expect(contents).toEqual(prompts.flatMap(prompt => [
      prompt.safe,
      `Mock response: ${prompt.safe}`
    ]));
  });

  it.each([
    {
      name: "unknown command",
      args: ["bad\u001B]52;c;forged\u0007\u202Ecommand"],
      framing: "error: unknown command 'badcommand'"
    },
    {
      name: "unknown option",
      args: ["--bad\u001B]52;c;forged\u0007\u001B[2J\u202Eoption"],
      framing: "error: unknown option '--badoption'"
    }
  ])("sanitizes Commander $name diagnostics while preserving framing", async ({ args, framing }) => {
    // Given
    const untrustedArguments = args;

    // When
    const output = await runCommanderFailure(untrustedArguments);

    // Then
    const diagnostic = output.stderr.join("");
    expect(output.errorName).toBe("CommanderError");
    expect(output.stdout).toEqual([]);
    expect(diagnostic).toContain(framing);
    expect(diagnostic).not.toMatch(/[\u0007\u001B\u009B\u202E]/u);
    expect(diagnostic).not.toContain("forged");
  });
});
