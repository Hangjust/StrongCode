import { PassThrough, Readable, Writable } from "node:stream";
import { TerminalSetupPrompter } from "../src/setup/prompter";

describe("terminal setup prompts", () => {
  it("renders the StrongCode wordmark as a compact setup header", () => {
    const input = Readable.from([]);
    let output = "";
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      }
    });
    const prompts = new TerminalSetupPrompter(input, sink);

    prompts.intro("MODEL SETUP");
    prompts.note("\x1b[31mclean output\x1b[0m");
    prompts.outro("StrongCode harness is ready.");
    prompts.close();

    expect(output).toContain("█▀▀▀ ▀█▀▀");
    expect(output).toContain("┌  MODEL SETUP");
    expect(output).toContain("│  clean output");
    expect(output).not.toContain("\x1b[31m");
    expect(output).toContain("└  ✓ StrongCode harness is ready.");
  });

  it("filters long TTY menus in place", async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY: boolean;
      isRaw: boolean;
      setRawMode(mode: boolean): void;
    };
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = mode => { input.isRaw = mode; };
    let output = "";
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      }
    });
    Object.assign(sink, { columns: 80 });
    const prompts = new TerminalSetupPrompter(input, sink);

    const selected = prompts.select("Providers", [
      { value: "openai", label: "OpenAI" },
      { value: "anthropic", label: "Anthropic" },
      { value: "google", label: "Google", hint: "Gemini · Vertex" },
      { value: "grok", label: "xAI" },
      { value: "kimi", label: "Kimi" },
      { value: "deepseek", label: "DeepSeek" },
      { value: "glm", label: "GLM" },
      { value: "custom", label: "Custom" }
    ]);
    setImmediate(() => input.write("goo\r"));

    await expect(selected).resolves.toBe("google");
    prompts.close();
    const plain = output.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
    expect(output).toContain("\x1b[1A");
    expect(plain).toContain("◇  Providers");
    expect(plain).toContain("Google");
    expect(input.isRaw).toBe(false);
  });

  it("reads line-oriented piped input and never echoes secrets", async () => {
    const input = Readable.from(["2\n1,3\nsuper-secret\n"]);
    let output = "";
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      }
    });
    const prompts = new TerminalSetupPrompter(input, sink);

    const selected = await prompts.select("Provider", [
      { value: "a", label: "A" },
      { value: "b", label: "B" }
    ]);
    const multiple = await prompts.multiselect("Models", [
      { value: "one", label: "One" },
      { value: "two", label: "Two" },
      { value: "three", label: "Three" }
    ]);
    const secret = await prompts.secret("API key");
    prompts.close();

    expect(selected).toBe("b");
    expect(multiple).toEqual(["one", "three"]);
    expect(secret).toBe("super-secret");
    expect(output).not.toContain("super-secret");
  });
});
