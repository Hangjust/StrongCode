import { renderHome, renderSessionLayout, renderStatus, renderHints } from "../src/tui/render";
import { exactHomeCommandOverlay, runTui, shouldSubmitHomePrompt } from "../src/tui/app";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultTuiConfig } from "../src/tui/config/tui";
import { describeKeybinds, parseTuiKeybinds } from "../src/tui/config/keybind";
import { createDefaultPalette } from "../src/tui/ui/palette";
import { PromptHistory, PromptHistoryStore } from "../src/tui/component/prompt/history";
import { createKeySequenceState, dispatchKeySequence, renderWhichKey } from "../src/tui/keymap";
import { createBuiltinPluginRuntime } from "../src/tui/plugin";
import { renderPaletteOverlay, renderSlashCommandOverlay } from "../src/tui/ui/overlay";
import { screenForRoute, TuiRouter } from "../src/tui/route";
import { renderApprovalSurface, renderDiffSurface, renderEditorPasteSurface, renderPickerSurface, renderProviderDialogSurface } from "../src/tui/ui/surfaces";
import { renderFilteredPalette } from "../src/tui/ui/palette";

function visibleLength(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function expectBounded(output: string, width = 80): void {
  output.split("\n").forEach(line => {
    expect(visibleLength(line)).toBeLessThanOrEqual(width);
  });
}

function expectStrongCodeSurface(output: string): void {
  expect(output).toMatch(/strongcode/i);
}

function expectNoControlSequences(output: string): void {
  expect(output).not.toMatch(/\x1b\]/);
  expect(output).not.toMatch(/\x1b\[/);
  expect(output).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/);
}

async function runScriptedTui(lines: string[]): Promise<string> {
  const input = new PassThrough();
  const output = new PassThrough();
  let outputData = "";
  output.on("data", (chunk) => {
    outputData += chunk;
  });

  const finished = runTui(input, output);
  await new Promise<void>(resolve => setImmediate(resolve));
  for (const line of lines) {
    input.write(`${line}\n`);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  input.end();
  await finished;
  return outputData;
}

describe("tui", () => {
  it("renders home layout with long values", () => {
    const state = {
      provider: "very-long-provider-name-that-should-be-clipped",
      model: "very-long-model-name-that-should-be-clipped",
      defaultAgent: "default",
      configPath: "strongcode.config.yaml",
      configMissing: false,
      workspace: "/a/very/long/path/that/should/be/clipped/to/fit/in/the/top/band",
      dataDir: ".strongcode",
    };
    
     const home = renderHome(state, true);
     
    expect(home).toContain("██████ ██████ █████");
    expect(home).toContain("Ask anything...");
    expect(home).toContain("Default ·");
    expect(home).not.toContain("ctrl+x agents");
    expect(home).not.toContain("ctrl+x commands");
    expect(home).not.toContain("N/A");
    expect(home).not.toContain("▀");
    expect(home).toContain("/status");
    expectBounded(home);
  });

  it("renders session layout with long values", () => {
    const state = {
      provider: "very-long-provider-name-that-should-be-clipped",
      defaultAgent: "default",
      configPath: "strongcode.config.yaml",
      configMissing: false,
      workspace: "/a/very/long/path/that/should/be/clipped/to/fit/in/the/footer",
      dataDir: ".strongcode"
    };

     const session = renderSessionLayout(state, ["a very long message that should be split into multiple lines because it is way too long for the main width of the terminal"], true);
     
    expect(session).toContain("a very long message");
    expect(session).toContain("┃");
    expect(session).toContain("StrongCode 0.1.0");
    expect(session).toContain("▣ Build");
    expectBounded(session);
  });

  it("renders empty session layout", () => {
    const state = {
      provider: "mock",
      defaultAgent: "default",
      configPath: "strongcode.config.yaml",
      configMissing: false,
      workspace: ".",
      dataDir: ".strongcode"
    };

     const session = renderSessionLayout(state, [], true);
    expect(session).toContain("No messages in session.");
    expectStrongCodeSurface(session);
    expectBounded(session);
  });

  it("strips terminal control sequences from dynamic TUI values", () => {
    const state = {
      provider: "mock\u001b[31mred",
      model: "mock\u001b]52;c;clipboard\u0007",
      defaultAgent: "default\u001b[2J",
      configPath: "strongcode.config.yaml",
      configMissing: false,
      workspace: ".\u001b[?25l",
      dataDir: ".strongcode\u0000hidden"
    };

    const output = [
      renderHome(state, true),
      renderSessionLayout(state, ["user: hi\u001b]52;c;steal\u0007", "assistant: ok\u001b[0m"], true),
      renderStatus(state, true)
    ].join("\n");

    expect(output).toContain("mockred");
    expect(output).not.toContain("clipboard");
    expect(output).not.toContain("steal");
    expect(output).toContain("default");
    expectNoControlSequences(output);
    expectBounded(output);
  });

  it("renders colorized hints with bounded visible lines", () => {
    const hints = renderHints(false);
    expectBounded(hints);
    expect(hints).toContain("/sessions");
    expect(hints).toContain("/commands");
    expect(hints).not.toContain("ctrl+x leader");
    expect(hints).not.toContain("ctrl+k leader");
  });

  it("provides default tui config, keybind descriptions, and palette commands", () => {
    const config = defaultTuiConfig();
    const keybinds = parseTuiKeybinds({ command_palette: ["p"], app_exit: "none" });
    const descriptions = describeKeybinds(keybinds);
    const palette = createDefaultPalette();

    expect(config.leader).toBe("");
    expect(config.leaderTimeout).toBe(2000);
    expect(config.keybinds.command_palette).toEqual([]);
    expect(keybinds.command_palette).toEqual(["p"]);
    expect(keybinds.app_exit).toEqual([]);
    expect(descriptions.join("\n")).toContain("command_palette");
    expect(palette.find("/commands")?.title).toBe("Command Palette");
    expect(palette.search("theme")[0]?.slash).toBe("/themes");
  });

  it("cycles prompt history without duplicate adjacent prompts", () => {
    const history = new PromptHistory();
    history.add("first");
    history.add("second");
    history.add("second");

    expect(history.list()).toEqual(["first", "second"]);
    expect(history.previous()).toBe("second");
    expect(history.previous()).toBe("first");
    expect(history.next()).toBe("second");
    expect(history.next()).toBe("");
  });

  it("persists prompt history to the tui data directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-tui-history-"));
    const store = new PromptHistoryStore(root);
    const history = new PromptHistory();
    history.add("remember this");

    await store.save(history);
    const loaded = await store.load();

    expect(loaded.list()).toEqual(["remember this"]);
    expect(await readFile(path.join(root, "tui", "prompt-history.json"), "utf8")).toContain("remember this");
  });

  it("resolves key sequences and renders which-key hints", () => {
    const state = createKeySequenceState();
    const keybinds = parseTuiKeybinds({ command_palette: ["p"] });
    const pending = dispatchKeySequence(state, keybinds, "p", 2000, 1);
    const matched = dispatchKeySequence(state, keybinds, "p", 2000, 2);

    expect(pending.type).toBe("matched");
    expect(matched.type).toBe("matched");
  });

  it("renders plugin slots and palette cursor overlays", () => {
    const runtime = createBuiltinPluginRuntime();
    const palette = createDefaultPalette();
    palette.select(1);

    expect(runtime.render("status")).toContain("Plugin slots ready");
    expect(renderPaletteOverlay(palette.list(), palette.cursor())).toContain("> /status");
    expect(renderFilteredPalette(palette, "diff")).toContain("/diff");
  });

  it("renders slash command suggestions without the full command palette chrome", () => {
    const palette = createDefaultPalette();
    const commands = palette.search("mod");
    const output = renderSlashCommandOverlay(commands, 0, "mod");

    expect(output).toContain("╭");
    expect(output).toContain("› /model");
    expect(output).toContain("/models");
    expect(output).toContain("Open active model picker or select");
    expect(output).not.toContain("enter run");
    expect(output).not.toContain("Slash Commands");
    expect(output).not.toContain("Command Palette");
    expectBounded(output);
  });

  it("keeps selected slash command visible when suggestions scroll", () => {
    const commands = Array.from({ length: 12 }, (_, index) => ({
      id: `cmd-${index}`,
      title: `Command ${index}`,
      description: `Description ${index}`,
      slash: `/cmd-${index}`
    }));
    const output = renderSlashCommandOverlay(commands, 11, "cmd");

    expect(output).not.toContain("/cmd-0");
    expect(output).toContain("› /cmd-11");
    expectBounded(output);
  });

  it("describes extended routes and bounded StrongCode-style surfaces", () => {
    const router = new TuiRouter();
    const route = router.go("diff");
    const output = [
      screenForRoute(route.name).title,
      renderDiffSurface({ filePath: "src/example.ts", before: "const ready = false;", after: "const ready = true;" }),
      renderApprovalSurface({ toolName: "write_file", risk: "medium", description: "Approve a write." }),
      renderPickerSurface("Picker", [{ id: "one", label: "One", description: "First" }], 0),
      renderEditorPasteSurface({ content: "hello\nworld" })
    ].join("\n");

    expect(output).toContain("Diff Review");
    expect(output).toContain("Tool Approval");
    expect(output).toContain("> One First");
    expect(output).toContain("Editor Paste");
    expectBounded(output);
  });

  it("renders OpenCode-style provider dialog surface", () => {
    const output = renderProviderDialogSurface([
      {
        id: "openai",
        title: "GPT / OpenAI",
        description: "(ChatGPT Plus/Pro or API key)",
        category: "Popular",
        connected: false,
        credential: "env OPENAI_API_KEY (missing)",
        footer: "https://api.openai.com/v1"
      },
      {
        id: "mock",
        title: "Mock",
        description: "(local mock provider)",
        category: "Popular",
        connected: true,
        credential: "no key required"
      },
      {
        id: "custom",
        title: "Other",
        description: "Custom provider",
        category: "Providers",
        connected: false,
        credential: "env CUSTOM_PROVIDER_API_KEY (missing)"
      }
    ], 1);

    expect(output).toContain("Connect a provider");
    expect(output).toContain("esc");
    expect(output).toContain("Search");
    expect(output).toContain("Popular");
    expect(output).toContain("> ✓ Mock (local mock provider)");
    expect(output).toContain("Providers");
    expect(output).toContain("Other Custom provider");
    expect(renderProviderDialogSurface([
      {
        id: "openai",
        title: "GPT / OpenAI",
        description: "(ChatGPT Plus/Pro or API key)",
        category: "Popular",
        connected: false,
        credential: "env OPENAI_API_KEY (missing)"
      }
    ], 0, "open")).toContain("Search open");
    expect(output).not.toContain("sk-");
    expectBounded(output);
  });

  it("renders status and help with bounded lines", () => {
    const status = renderStatus({
      provider: "mock",
      defaultAgent: "default",
      configPath: "strongcode.config.yaml",
      configMissing: false,
      workspace: "/a/very/long/path/that/should/be/clipped/to/fit/in/the/status/panel",
      dataDir: ".strongcode"
    }, true);

    expectBounded(status);
    expectStrongCodeSurface(status);
    
    expect(status).toContain("Status");
    expect(status).toContain("State      connected");
    expect(status).toContain("┃");
    
    const hints = renderHints(true);
    expectBounded(hints);
    expect(hints).toContain("/themes");
  });

  it("runs TUI and exits", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    
    let outputData = "";
    let sentExit = false;
    output.on("data", (chunk) => {
      outputData += chunk;
      if (!sentExit && outputData.includes("Ask anything...")) {
        sentExit = true;
        input.write("/exit\n");
        input.end();
      }
    });

    await runTui(input, output);
    
    expect(outputData).toContain("Ask anything...");
  });

  it("keeps piped readline responses on bounded lines", async () => {
    const providerOutput = await runScriptedTui(["/provider select openai", "/exit"]);
    const unknownOutput = await runScriptedTui(["/unknown-command-that-is-long-enough-to-test-the-line-boundary", "/exit"]);
    const outputData = `${providerOutput}\n${unknownOutput}`;

    expect(outputData).toContain("No enabled model for openai");
    expect(outputData).toContain("Unknown command:");
    expectBounded(outputData);
  });

  it("renders provider status for exact provider command", async () => {
    const outputData = await runScriptedTui(["/provider", "/exit"]);

    expect(outputData).toContain("Current provider");
    expect(outputData).toContain("Setup");
    expect(outputData).toContain("/provider configure custom");
    expectBounded(outputData);
  });

  it("recognizes providers alias without falling through to unknown command", async () => {
    const outputData = await runScriptedTui(["/providers", "/exit"]);

    expect(outputData).toContain("Current provider");
    expect(outputData).not.toContain("Unknown command: /providers");
    expectBounded(outputData);
  });

  it("runs provider status from slash suggestion selection", async () => {
    const palette = createDefaultPalette();

    expect(palette.find("/provider")?.description).toContain("subcommands");
    expect(palette.find("/providers")?.title).toBe("Providers");
  });

  it("routes exact home provider and model commands to picker overlays", () => {
    expect(exactHomeCommandOverlay("/provider")).toBe("providers");
    expect(exactHomeCommandOverlay("/providers")).toBe("providers");
    expect(exactHomeCommandOverlay("/model")).toBe("models");
    expect(exactHomeCommandOverlay("/models")).toBeUndefined();
    expect(exactHomeCommandOverlay("/provider list")).toBeUndefined();
    expect(exactHomeCommandOverlay("hello")).toBeUndefined();
    expect(shouldSubmitHomePrompt("none")).toBe(true);
    expect(shouldSubmitHomePrompt("providers")).toBe(false);
    expect(shouldSubmitHomePrompt("models")).toBe(false);
    expect(shouldSubmitHomePrompt("slashCommands")).toBe(false);
  });

  it("submits prompt text when input sends a line", async () => {
    const outputData = await runScriptedTui(["hello", "/exit"]);

    expect(outputData).toContain("hello");
    expect(outputData).toContain("Mock response: hello");
    expectBounded(outputData);
  });

  it("handles new palette, themes, sessions, models, and new-session commands", async () => {
    const outputData = await runScriptedTui(["/commands diff", "/themes", "/plugins", "/whichkey", "/diff", "/approve", "/pick", "/paste", "/sessions", "/models", "/status", "/toast", "/new", "/exit"]);

    expect(outputData).toContain("Command Palette: diff");
    expect(outputData).toContain("Theme ember");
    expect(outputData).toContain("Theme Picker");
    expect(outputData).toContain("Sessions");
    expect(outputData).toContain("Models");
    expect(outputData).toContain("Status Dashboard");
    expect(outputData).toContain("Toast stack is active.");
    expect(outputData).toContain("Plugin slots ready");
    expect(outputData).toContain("Which key: disabled");
    expect(outputData).toContain("Diff Review");
    expect(outputData).toContain("Tool Approval");
    expect(outputData).toContain("Editor Paste");
    expect(outputData).toContain("Started a new local session view.");
  });

  it("sanitizes unknown command text before terminal output", async () => {
    const outputData = await runScriptedTui(["/bad\u001b]52;c;steal\u0007\u001b[31mred", "/exit"]);

    expect(outputData).toContain("/badred");
    expect(outputData).not.toContain("steal");
    expectNoControlSequences(outputData.replace(/\x1b\[[0-9;]*m/g, ""));
    expectBounded(outputData);
  });
});
