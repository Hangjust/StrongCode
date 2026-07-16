import { renderAllModelList, renderHome, renderSessionLayout, renderStatus, renderHints } from "../src/tui/render";
import { START_WORK_HANDOFF_PROMPT, activeCustomProviderModelRows, apiKeyEnvForProviderId, approvedPlanExecutionForActivation, connectCommandForProviderAuthMethod, customProviderCursorOffset, customProviderEndpointLoadingText, customProviderFetchingModelsText, draftHomeCommandOverlay, fallbackCommandContainsApiKey, isAvailableCustomProviderId, isProviderPopupOverlay, isValidCustomProviderId, navigationKeyName, nextSelectionIndex, promptDraftAfterEscape, providerAuthOverlayForMethods, providerDialogRowCount, providerDialogSelectedRowIndex, providerDialogTitle, providerEndpointLabel, providerPickerDescription, providerPickerPriority, renderAgentRoster, runTui, scrollTopForSelectedRow, selectedCustomProviderModels, selectedSlashCommand, selectedTextForClipboard, shouldAutoDiscoverCustomProviderModels, shouldCopySelectionForInput, shouldCopySelectionForMouse, shouldRefreshCustomProviderDiscoveryPanel, shouldSubmitHomePrompt, shouldSubmitHomeValue, slashOverlayTop, slashSelectionValue, toggleCustomProviderSelectedModel } from "../src/tui/app";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
import { renderApprovalSurface, renderDiffSurface, renderEditorPasteSurface, renderPickerSurface } from "../src/tui/ui/surfaces";
import { renderFilteredPalette } from "../src/tui/ui/palette";
import { loadConfig } from "../src/config/load";
import { fullTuiRouteForInput, parseSlashCommand } from "../src/tui/slash-command-registry";
import { vi } from "vitest";
import { testConfig, writeOpenAICompatibleTestConfig } from "./helpers";

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

function expectNoBidiSpoofingControls(output: string): void {
  expect(output).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/u);
}

function countOccurrences(output: string, value: string): number {
  return output.split(value).length - 1;
}

async function runScriptedTui(lines: string[], homeDirectory?: string): Promise<string> {
  const originalHome = process.env.STRONGCODE_HOME;
  const temporaryHome = homeDirectory === undefined
    ? await mkdtemp(path.join(tmpdir(), "strongcode-tui-home-"))
    : undefined;
  process.env.STRONGCODE_HOME = homeDirectory ?? temporaryHome;

  try {
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
  } finally {
    if (originalHome === undefined) delete process.env.STRONGCODE_HOME;
    else process.env.STRONGCODE_HOME = originalHome;
    if (temporaryHome !== undefined) {
      await rm(temporaryHome, { recursive: true, force: true });
    }
  }
}

async function writeMockJbpConfig(root: string): Promise<void> {
  await writeFile(path.join(root, "strongcode.config.yaml"), `version: 1
workspace: "."
dataDir: ".strongcode"
defaultAgent: jbp
providers:
  mock:
    type: mock
    displayName: Mock
    enabled: true
agents:
  jbp:
    model: mock
    tools: []
models:
  mock:
    provider: mock
    model: mock
    enabled: true
permissions:
  tools: {}
`, "utf8");
}

async function runScriptedTuiInDirectory(directory: string, lines: string[]): Promise<string> {
  const originalCwd = process.cwd();
  process.chdir(directory);
  try {
    return await runScriptedTui(lines, path.join(directory, ".strongcode-home"));
  } finally {
    process.chdir(originalCwd);
  }
}

async function loadConfigInDirectory(directory: string) {
  const originalHome = process.env.STRONGCODE_HOME;
  process.env.STRONGCODE_HOME = path.join(directory, ".strongcode-home");
  try {
    return await loadConfig(path.join(directory, "strongcode.config.yaml"));
  } finally {
    if (originalHome === undefined) delete process.env.STRONGCODE_HOME;
    else process.env.STRONGCODE_HOME = originalHome;
  }
}

describe("tui", () => {
  it("renders home layout with long values", () => {
    const state = {
      provider: "very-long-provider-name-that-should-be-clipped",
      model: "very-long-model-name-that-should-be-clipped",
      modelDisplayName: "GPT-5.5",
      defaultAgent: "default",
      configPath: "strongcode.config.yaml",
      configMissing: false,
      workspace: "/a/very/long/path/that/should/be/clipped/to/fit/in/the/top/band",
      dataDir: ".strongcode",
    };
    
     const home = renderHome(state, true);
     
    expect(home).toContain("█▀▀▀ ▀█▀▀ █▀▀▄ █▀▀█ █▀▀▄ █▀▀▀");
    expect(home).toContain("█▀▀▀ █▀▀█ █▀▀▄ █▀▀▀");
    expect(home).toContain("GPT-5.5");
    expect(home).toContain("Ask anything…");
    expect(countOccurrences(home, "STRONGCODE")).toBe(1);
    const logoLine = home.split("\n").find(line => line.includes("█▀▀▀ ▀█▀▀"));
    const promptLine = home.split("\n").find(line => line.includes("Ask anything…"));
    expect(logoLine).toBeDefined();
    expect(promptLine).toBeDefined();
    expect(promptLine?.indexOf("│")).toBeLessThanOrEqual(logoLine?.search(/\S/) ?? 0);
    expect(home).not.toContain("LOCAL AGENT FORGE");
    expect(home).not.toContain("TUI OPERATIONS CONSOLE");
    expect(home).not.toContain("it says");
    expect(home).not.toContain("ctrl+x agents");
    expect(home).not.toContain("ctrl+x commands");
    expect(home).not.toContain("N/A");
    expect(home).toContain("▀");
    expect(home).toContain("/model switch");
    expect(home).toContain("Ctrl+H commands");
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
    expect(session).toContain("╭─ message");
    expect(session).toContain("v0.1.0");
    expect(session).toContain("▣ default");
    expect(session).toContain("Finished · default");
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
    expect(session).toContain("Ready for your first message.");
    expectStrongCodeSurface(session);
    expectBounded(session);
  });

  it("renders registry-backed fallback composer roles with a white model and emoji-only status", () => {
    const state = {
      provider: "openai",
      model: "composer-2.5",
      modelDisplayName: "Composer 2.5",
      defaultAgent: "Tesla",
      agentIdentity: "tesla",
      configPath: "strongcode.config.yaml",
      configMissing: false,
      workspace: "."
    };

    const plain = renderSessionLayout(state, [], true);
    const colored = renderSessionLayout(state, [], false);

    expect(plain).toContain("Tesla - Main Agent · Composer 2.5 (composer-2.5) · 🧠 · ⚡");
    for (const [agentIdentity, agent, label] of [
      ["newton", "Newton", "Newton - Deep Worker"],
      ["jbp", "JBP", "JBP - Plan Builder"],
      ["bob-the-builder", "Bob The Builder", "Bob The Builder - Plan Executor"],
      ["steve-jobs", "Steve Jobs", "Steve Jobs"],
      ["custom-worker", "Custom Worker", "Custom Worker"]
    ]) {
      const output = renderSessionLayout({ ...state, agentIdentity, defaultAgent: agent }, [], true);
      expect(output).toContain(`${label} · Composer 2.5 (composer-2.5) · 🧠 · ⚡`);
    }
    const specialist = renderSessionLayout({ ...state, agentIdentity: "steve-jobs", defaultAgent: "Steve Jobs" }, [], true);
    const custom = renderSessionLayout({ ...state, agentIdentity: "custom-worker", defaultAgent: "Custom Worker" }, [], true);
    const impersonatingCustom = renderSessionLayout({ ...state, agentIdentity: "custom-agent", defaultAgent: "Tesla" }, [], true);
    const renamedTesla = renderSessionLayout({ ...state, defaultAgent: "Ada" }, [], true);
    const collidingTesla = renderSessionLayout({ ...state, defaultAgent: "JBP" }, [], true);
    expect(specialist).not.toContain("Steve Jobs - ");
    expect(custom).not.toContain("Custom Worker - ");
    expect(impersonatingCustom).toContain("Tesla · Composer 2.5 (composer-2.5) · 🧠 · ⚡");
    expect(impersonatingCustom).not.toContain("Tesla - Main Agent");
    expect(renamedTesla).toContain("Ada - Main Agent · Composer 2.5 (composer-2.5) · 🧠 · ⚡");
    expect(collidingTesla).toContain("JBP - Main Agent · Composer 2.5 (composer-2.5) · 🧠 · ⚡");
    expect(collidingTesla).not.toContain("JBP - Plan Builder");
    expect(plain).not.toContain("@ Tesla");
    expect(plain).not.toContain("🧠 Reasoning");
    expect(plain).not.toContain("⚡ Fast");
    expect(colored).toContain("\x1b[38;2;242;238;230mComposer 2.5 (composer-2.5)\x1b[0m");
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
      renderSessionLayout(state, [{
        role: "assistant",
        text: "safe",
        receipt: { status: "finished", agent: "Her\u001b]52;c;receipt-steal\u0007man", model: "GPT\u001b[2J", durationMs: 1, toolCalls: 0 }
      }], true),
      renderStatus(state, true)
    ].join("\n");

    expect(output).toContain("mockred");
    expect(output).not.toContain("clipboard");
    expect(output).not.toContain("steal");
    expect(output).not.toContain("receipt-steal");
    expect(output).toContain("default");
    expectNoControlSequences(output);
    expectBounded(output);
  });

  it("removes bidi spoofing controls from fallback display projections", () => {
    const controls = "\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069";
    const state = {
      provider: `provider${controls}`,
      providerDisplayName: `Provider${controls}`,
      model: `model${controls}`,
      modelDisplayName: `Model${controls}`,
      defaultAgent: `Agent${controls}`,
      configPath: "strongcode.config.yaml",
      configMissing: false,
      workspace: `workspace${controls}`,
      dataDir: ".strongcode"
    };
    const output = [
      renderHome(state, true),
      renderStatus(state, true),
      renderSessionLayout(state, [
        { role: "user" as const, text: `Title${controls}` },
        { role: "assistant" as const, text: `Transcript${controls}`, receipt: { status: "finished" as const, agent: `Receipt agent${controls}`, model: `Receipt model${controls}`, durationMs: 1, toolCalls: 0 } }
      ], true)
    ].join("\n");

    expect(output).toContain("Agent");
    expect(output).toContain("Provider");
    expect(output).toContain("Model");
    expect(output).toContain("Title");
    expect(output).toContain("Transcript");
    expect(output).toContain("Receipt agent");
    expect(output).toContain("Receipt model");
    expectNoBidiSpoofingControls(output);
    expectBounded(output);
  });

  it("renders colorized hints with bounded visible lines", () => {
    const hints = renderHints(false);
    expectBounded(hints);
    expect(hints).toContain("/connect");
    expect(hints).not.toContain("/commands");
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
    expect(config.keybinds.help).toEqual(["ctrl+h", "f1"]);
    expect(config.keybinds.agent_next).toEqual(["tab"]);
    expect(config.keybinds.agent_previous).toEqual(["shift+tab"]);
    expect(config.keybinds.reasoning_focus).toEqual(["ctrl+r"]);
    expect(keybinds.command_palette).toEqual(["p"]);
    expect(keybinds.app_exit).toEqual([]);
    expect(descriptions.join("\n")).toContain("command_palette");
    expect(descriptions.join("\n")).not.toContain("status");
    expect(descriptions.join("\n")).not.toContain("session_new");
    expect(descriptions.join("\n")).toContain("session_list");
    expect(descriptions.join("\n")).toContain("theme_picker");
    expect(descriptions.join("\n")).toContain("reasoning_focus");
    expect(palette.list().map(command => command.slash)).toEqual(["/connect", "/agent", "/agents", "/start-work", "/compact", "/model", "/models", "/summary", "/help", "/exit"]);
    expect(palette.find("/commands")).toBeUndefined();
    expect(palette.search("theme")).toEqual([]);
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
    palette.select(5);

    expect(runtime.render("status")).toContain("Plugin slots ready");
    expect(renderPaletteOverlay(palette.list(), palette.cursor())).toContain("> /model");
    expect(renderFilteredPalette(palette, "con")).toContain("/connect");
    expect(renderFilteredPalette(palette, "model")).toContain("/model");
  });

  it("renders slash command suggestions without the full command palette chrome", () => {
    const palette = createDefaultPalette();
    const commands = palette.search("con");
    const output = renderSlashCommandOverlay(commands, 0, "con");

    expect(output).toContain("╭");
    expect(output).toContain("› /connect");
    expect(output).toContain("Open provider login");
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

  it("normalizes arrow keys and wraps slash selection", () => {
    expect(navigationKeyName("up")).toBe("up");
    expect(navigationKeyName("ArrowUp")).toBe("up");
    expect(navigationKeyName("arrow_up")).toBe("up");
    expect(navigationKeyName("upArrow")).toBe("up");
    expect(navigationKeyName("down")).toBe("down");
    expect(navigationKeyName("ArrowDown")).toBe("down");
    expect(navigationKeyName("arrow_down")).toBe("down");
    expect(navigationKeyName("downArrow")).toBe("down");
    expect(navigationKeyName("Enter")).toBe("return");
    expect(navigationKeyName("esc")).toBe("escape");
    expect(navigationKeyName("tab")).toBeUndefined();
    expect(nextSelectionIndex(0, 3, -1)).toBe(2);
    expect(nextSelectionIndex(2, 3, 1)).toBe(0);
    expect(nextSelectionIndex(1, 3, 1)).toBe(2);
    expect(nextSelectionIndex(5, 0, -1)).toBe(0);
  });

  it("keeps selected dialog row inside the scroll viewport", () => {
    expect(scrollTopForSelectedRow(0, 12)).toBe(0);
    expect(scrollTopForSelectedRow(11, 12)).toBe(0);
    expect(scrollTopForSelectedRow(12, 12)).toBe(1);
    expect(scrollTopForSelectedRow(20, 12)).toBe(9);
    expect(scrollTopForSelectedRow(3, 0)).toBe(3);
    const lastRowWithTopPadding = 11 + 1;
    expect(scrollTopForSelectedRow(lastRowWithTopPadding, 12)).toBe(1);
  });

  it("positions slash command suggestions above the prompt", () => {
    expect(slashOverlayTop(20, 6)).toBe(14);
    expect(slashOverlayTop(3, 8)).toBe(0);
    expect(slashOverlayTop(9, 0)).toBe(8);
  });

  it("keeps connect provider rows visible with repeated category headers", () => {
    const options = [
      { category: "Popular" },
      { category: "Popular" },
      { category: "Providers" },
      { category: "Providers" },
      { category: "Popular" },
      { category: "Providers" },
      { category: "Popular" }
    ];

    expect(providerDialogRowCount(options)).toBe(12);
    expect(providerDialogSelectedRowIndex(options, 0)).toBe(1);
    expect(providerDialogSelectedRowIndex(options, 4)).toBe(7);
    expect(providerDialogSelectedRowIndex(options, 6)).toBe(11);
    expect(scrollTopForSelectedRow(providerDialogSelectedRowIndex(options, 6), 6)).toBe(6);
  });

  it("copies only non-empty selected TUI text for Ctrl+C and right-click", () => {
    const selectedText = selectedTextForClipboard({ getSelectedText: () => "copy me" });
    const emptyText = selectedTextForClipboard({ getSelectedText: () => "" });

    expect(selectedText).toBe("copy me");
    expect(emptyText).toBeUndefined();
    expect(selectedTextForClipboard(null)).toBeUndefined();
    expect(shouldCopySelectionForInput("ctrl+c", selectedText)).toBe(true);
    expect(shouldCopySelectionForInput("ctrl+c", emptyText)).toBe(false);
    expect(shouldCopySelectionForInput("ctrl+x", selectedText)).toBe(false);
    expect(shouldCopySelectionForMouse({ type: "down", button: 2 }, 2, selectedText)).toBe(true);
    expect(shouldCopySelectionForMouse({ type: "up", button: 2 }, 2, selectedText)).toBe(false);
    expect(shouldCopySelectionForMouse({ type: "down", button: 0 }, 2, selectedText)).toBe(false);
    expect(shouldCopySelectionForMouse({ type: "down", button: 2 }, 2, emptyText)).toBe(false);
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
    expect(hints).toContain("/connect");
  });

  it("runs TUI and exits", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    
    let outputData = "";
    let sentExit = false;
    output.on("data", (chunk) => {
      outputData += chunk;
      if (!sentExit && outputData.includes("Ask anything…")) {
        sentExit = true;
        input.write("/exit\n");
        input.end();
      }
    });

    await runTui(input, output);
    
    expect(outputData).toContain("Ask anything…");
  });

  it("isolates scripted fallback sessions from the user home and restores the environment", async () => {
    const poisonedHome = await mkdtemp(path.join(tmpdir(), "strongcode-tui-poisoned-home-"));
    const originalHome = process.env.STRONGCODE_HOME;
    await writeFile(path.join(poisonedHome, "categories.json"), JSON.stringify({
      version: 1,
      categories: {
        quick: { model: "openai/gpt-5.5" }
      }
    }), "utf8");
    process.env.STRONGCODE_HOME = poisonedHome;

    try {
      const outputData = await runScriptedTui(["/models", "/exit"]);

      expect(outputData).toContain("Models");
      expect(outputData).not.toContain("Category 'quick' model 'openai/gpt-5.5' is not defined");
      expect(process.env.STRONGCODE_HOME).toBe(poisonedHome);
    } finally {
      if (originalHome === undefined) delete process.env.STRONGCODE_HOME;
      else process.env.STRONGCODE_HOME = originalHome;
      await rm(poisonedHome, { recursive: true, force: true });
    }
  });

  it("accepts case-insensitive plain exit aliases in fallback mode", async () => {
    const exitOutput = await runScriptedTui(["EXIT"]);
    const quitOutput = await runScriptedTui(["QuIt"]);

    expect(exitOutput).not.toContain("Unknown command");
    expect(quitOutput).not.toContain("Unknown command");
  });

  it("routes uppercase canonical slash commands in fallback mode", async () => {
    const outputData = await runScriptedTui(["/HELP", "/AGENTS", "/MODELS", "/START-WORK", "/EXIT"]);

    expect(outputData).toContain("StrongCode commands");
    expect(outputData).toContain("Agents");
    expect(outputData).toContain("Models");
    expect(outputData).toContain("Start-work requires an active JBP planning session");
    expect(outputData).not.toContain("Unknown command");
    expectBounded(outputData);
  });

  it("keeps piped readline responses on bounded lines", async () => {
    const providerOutput = await runScriptedTui(["/provider select openai", "/exit"]);
    const unknownOutput = await runScriptedTui(["/unknown-command-that-is-long-enough-to-test-the-line-boundary", "/exit"]);
    const outputData = `${providerOutput}\n${unknownOutput}`;

    expect(outputData).toContain("Unknown command: /provider select openai");
    expect(outputData).toContain("Unknown command:");
    expectBounded(outputData);
  });

  it("rejects removed provider slash commands", async () => {
    const outputData = await runScriptedTui(["/provider", "/providers", "/exit"]);

    expect(outputData).toContain("Unknown command: /provider");
    expect(outputData).toContain("Unknown command: /providers");
    expectBounded(outputData);
  });

  it("refuses echoed inline API keys in the fallback TUI", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-tui-connect-"));
    await writeFile(path.join(root, "strongcode.config.yaml"), `version: 1
workspace: "."
dataDir: ".strongcode"
defaultAgent: default
providers:
  mock:
    type: mock
    displayName: Mock
    enabled: true
  custom:
    type: openai-compatible
    displayName: Custom Provider
    apiKeyEnv: CUSTOM_PROVIDER_API_KEY
    baseUrl: https://example.com/v1
    modelsEndpoint: /models
    enabled: false
agents:
  default:
    model: mock
    tools: []
models:
  mock:
    provider: mock
    model: mock
    enabled: true
permissions:
  tools: {}
`, "utf8");

    const outputData = await runScriptedTuiInDirectory(root, ["/CONNECT custom same-session-key", "/exit"]);

    expect(outputData).toContain("Inline API keys are disabled in the fallback terminal");
    expect(outputData).not.toContain("Connected custom");
    expect(outputData).not.toContain("same-session-key");
    expectBounded(outputData);
  });

  it("renders only final content from OpenAI-compatible reasoning responses in fallback mode", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-tui-reasoning-"));
    await writeOpenAICompatibleTestConfig(root);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: "Final answer", reasoning_content: "Private reasoning" } }]
    }), { status: 200 });

    try {
      const outputData = await runScriptedTuiInDirectory(root, ["hello", "/exit"]);
      const sessionFiles = await readdir(path.join(root, ".strongcode", "sessions"));
      const session = await readFile(path.join(root, ".strongcode", "sessions", sessionFiles[0] ?? "missing"), "utf8");

      expect(sessionFiles).toHaveLength(1);
      expect(outputData).toContain("Final answer");
      expect(outputData).not.toContain("Private reasoning");
      expect(outputData).not.toContain("[+] Reasoning");
      expect(outputData).not.toContain("[-] Reasoning");
      expect(session).toContain("Final answer");
      expect(session).not.toContain("Private reasoning");
      expectBounded(outputData);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("registers the supported startup slash suggestions", async () => {
    const palette = createDefaultPalette();

    expect(palette.list().map(command => command.slash)).toEqual(["/connect", "/agent", "/agents", "/start-work", "/compact", "/model", "/models", "/summary", "/help", "/exit"]);
    expect(palette.find("/connect")?.title).toBe("Connect");
    expect(palette.find("/model")?.title).toBe("Model");
    expect(palette.find("/exit")?.title).toBe("Exit");
    expect(palette.find("/providers")).toBeUndefined();
  });

  it("parses agent listing, selection, cycling, and start-work roster details", () => {
    expect(parseSlashCommand("/agent")).toEqual({ command: "agent", action: "list" });
    expect(parseSlashCommand("/agents")).toEqual({ command: "agent", action: "list" });
    expect(parseSlashCommand("/agent next")).toEqual({ command: "agent", action: "next" });
    expect(parseSlashCommand("/agent previous")).toEqual({ command: "agent", action: "previous" });
    expect(parseSlashCommand("/agent Hood Research Department")).toEqual({ command: "agent", action: "select", target: "Hood Research Department" });
    expect(parseSlashCommand("/model")).toEqual({ command: "model", action: "open" });
    expect(parseSlashCommand("/models")).toEqual({ command: "model", action: "list" });
    expect(parseSlashCommand("/model gpt-5.5")).toEqual({ command: "model", action: "select", modelId: "gpt-5.5" });
    expect(parseSlashCommand("/model newton gemini-4-pro")).toEqual({ command: "model", action: "select", agentId: "newton", modelId: "gemini-4-pro" });

    const roster = renderAgentRoster("jbp");
    expect(roster).toContain("> JBP");
    expect(roster).toContain("Tesla");
    expect(roster).toContain("Bob The Builder");
    expect(roster).toContain("Hood Research Department");
    expect(roster).toContain("specialist");
    expect(roster.match(/ specialist · /g)).toHaveLength(6);
    expect(roster).not.toContain(" Explore");
    expect(roster).not.toContain(" Librarian");
  });

  it("keeps general on Tesla and clearly rejects direct helper selection", async () => {
    // Given / When
    const outputData = await runScriptedTui(["/agent general", "/agent explore", "/exit"]);

    // Then
    expect(outputData).toContain("Active agent: Tesla");
    expect(outputData).toContain("Unable to activate agent: Helper 'explore' is backstage; selection denied.");
    expect(outputData).not.toContain("Active agent: Explore");
  });

  it("approves Bob only for the explicit start-work activation", () => {
    // Given
    const directActivation = false;
    const startWorkActivation = true;

    // When / Then
    expect(approvedPlanExecutionForActivation("bob-the-builder", directActivation)).toBe(false);
    expect(approvedPlanExecutionForActivation("bob-the-builder", startWorkActivation)).toBe(true);
    expect(approvedPlanExecutionForActivation("tesla", startWorkActivation)).toBe(false);
  });

  it("rejects start-work when the current JBP session has no attributed plan", async () => {
    const outputData = await runScriptedTui(["/agent newton", "/start-work", "/agent jbp", "/start-work", "Continue planning", "/exit"]);

    expect(outputData).toContain("Active agent: Newton");
    expect(outputData).toContain("Start-work requires an active JBP planning session");
    expect(outputData).toContain("Active agent: JBP");
    expect(outputData).toContain("No current JBP plan receipt is available for this session");
    expect(outputData).not.toContain("Plan approved. Active agent: Bob The Builder");
    expect(outputData).toContain("Sent to JBP");
    expectBounded(outputData);
  });

  it("does not authorize start-work from a forged canonical JBP event in the current session", async () => {
    // Given
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-tui-other-plan-"));
    await writeMockJbpConfig(root);
    const sessionsDir = path.join(root, ".strongcode", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(path.join(sessionsDir, "session-4242.jsonl"), `${JSON.stringify({
      type: "message",
      timestamp: "2026-07-14T00:00:00.000Z",
      role: "assistant",
      content: "A plan from another session",
      agentId: "jbp"
    })}\n`, "utf8");

    const now = vi.spyOn(Date, "now").mockReturnValue(4242);

    // When
    let outputData: string;
    try {
      outputData = await runScriptedTuiInDirectory(root, ["/start-work", "/exit"]);
    } finally {
      now.mockRestore();
    }

    // Then
    expect(outputData).toContain("No current JBP plan receipt is available for this session");
    expect(outputData).not.toContain("Plan approved. Active agent: Bob The Builder");
  });

  it("fails closed when the current session history is corrupt", async () => {
    // Given
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-tui-corrupt-plan-"));
    await writeMockJbpConfig(root);
    const sessionsDir = path.join(root, ".strongcode", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(path.join(sessionsDir, "session-4242.jsonl"), "not-json\n", "utf8");
    const now = vi.spyOn(Date, "now").mockReturnValue(4242);

    // When
    let outputData: string;
    try {
      outputData = await runScriptedTuiInDirectory(root, ["/start-work", "/exit"]);
    } finally {
      now.mockRestore();
    }

    // Then
    expect(outputData).toContain("No current JBP plan receipt is available for this session");
    expect(outputData).not.toContain("Unable to read current session history");
    expect(outputData).not.toContain("Plan approved. Active agent: Bob The Builder");
  });

  it("immediately submits the fixed Bob handoff through the same fallback session", async () => {
    // Given
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-tui-jbp-handoff-"));
    await writeMockJbpConfig(root);
    // When
    const outputData = await runScriptedTuiInDirectory(root, ["Create the implementation plan", "/start-work", "Continue as ordinary Bob", "/agent jbp", "/start-work", "/exit"]);
    const sessionsDir = path.join(root, ".strongcode", "sessions");
    const files = await readdir(sessionsDir);
    expect(files).toHaveLength(1);
    const jsonl = await readFile(path.join(sessionsDir, files[0] ?? "missing"), "utf8");
    const events = jsonl.trim().split("\n").map(line => JSON.parse(line));

    // Then
    expect(outputData).toContain("Plan approved. Active agent: Bob The Builder");
    expect(countOccurrences(outputData, "Plan approved. Active agent: Bob The Builder")).toBe(1);
    expect(outputData).toContain("No current JBP plan receipt is available for this session");
    expect(outputData).toContain("Mock response: StrongCode /start-work handoff:");
    expect(outputData).toContain("Mock response: Continue as ordinary Bob");
    const conversationEvents = events.filter(event => event.type === "message" || event.type === "conversation_item");
    expect(events.filter(event => event.type === "attempt_created" && event.role === "primary")).toHaveLength(3);
    expect(conversationEvents.map(event => ({ role: event.role, content: event.content, agentId: event.agentId }))).toEqual([
      { role: "user", content: "Create the implementation plan", agentId: "jbp" },
      { role: "assistant", content: "Mock response: Create the implementation plan", agentId: "jbp" },
      { role: "user", content: START_WORK_HANDOFF_PROMPT, agentId: "bob-the-builder" },
      { role: "assistant", content: `Mock response: ${START_WORK_HANDOFF_PROMPT}`, agentId: "bob-the-builder" },
      { role: "user", content: "Continue as ordinary Bob", agentId: "bob-the-builder" },
      { role: "assistant", content: "Mock response: Continue as ordinary Bob", agentId: "bob-the-builder" }
    ]);
  });

  it("resolves partial slash input through the selected suggestion", () => {
    const palette = createDefaultPalette();
    const connectSuggestions = palette.search("con").sort((left, right) => left.slash.localeCompare(right.slash));

    const connectIndex = connectSuggestions.findIndex(command => command.slash === "/connect");
    expect(selectedSlashCommand(connectSuggestions, connectIndex)?.slash).toBe("/connect");
    expect(selectedSlashCommand([], 0)).toBeUndefined();
    expect(slashSelectionValue(connectSuggestions, connectIndex, "/con")).toBe("/connect");
    expect(slashSelectionValue([], 0, "/not-a-command")).toBe("/not-a-command");
    expect(slashSelectionValue([], 0, "/")).toBeUndefined();
  });

  it("routes exact home provider and model commands to picker overlays", () => {
    expect(fullTuiRouteForInput("/provider")).toBeUndefined();
    expect(fullTuiRouteForInput("/connect")).toBe("providers");
    expect(fullTuiRouteForInput("/providers")).toBeUndefined();
    expect(fullTuiRouteForInput("/model")).toBe("models");
    expect(fullTuiRouteForInput("/models")).toBeUndefined();
    expect(fullTuiRouteForInput("/help")).toBe("help");
    expect(fullTuiRouteForInput("/summary")).toBe("summary");
    expect(fullTuiRouteForInput("/provider list")).toBeUndefined();
    expect(fullTuiRouteForInput("hello")).toBeUndefined();
    expect(shouldSubmitHomePrompt("none")).toBe(true);
    expect(shouldSubmitHomePrompt("providers")).toBe(false);
    expect(shouldSubmitHomePrompt("providerAuthMethod")).toBe(false);
    expect(shouldSubmitHomePrompt("models")).toBe(false);
    expect(shouldSubmitHomePrompt("slashCommands")).toBe(false);
    expect(shouldSubmitHomeValue("slashCommands", "/connect")).toBe(true);
    expect(shouldSubmitHomeValue("slashCommands", "/providers")).toBe(false);
    expect(shouldSubmitHomeValue("slashCommands", "/model")).toBe(true);
    expect(shouldSubmitHomeValue("slashCommands", "/models")).toBe(false);
    expect(shouldSubmitHomeValue("slashCommands", "/con")).toBe(false);
    expect(shouldSubmitHomeValue("slashCommands", "/connect custom")).toBe(false);
    expect(shouldSubmitHomeValue("providers", "/connect")).toBe(false);
    expect(shouldSubmitHomeValue("providers", "hello")).toBe(false);
  });

  it("does not open provider popup while typing exact connect", () => {
    expect(draftHomeCommandOverlay("/connect")).toBeUndefined();
    expect(draftHomeCommandOverlay("/con")).toBeUndefined();
    expect(draftHomeCommandOverlay("/connect custom")).toBeUndefined();
    expect(draftHomeCommandOverlay("/provider")).toBeUndefined();
  });

  it("clears secret provider auth input on escape", () => {
    expect(promptDraftAfterEscape("providerAuth", "sk-secret")).toBe("");
    expect(promptDraftAfterEscape("providerAuthMethod", "sk-secret")).toBe("");
    expect(promptDraftAfterEscape("slashCommands", "/con")).toBe("");
    expect(promptDraftAfterEscape("providers", "open")).toBe("open");
  });

  it("routes provider auth methods like the OpenCode connect popup", () => {
    const apiOnlyMethods = [{ type: "api" as const, label: "API key" }];
    const oauthMethods = [
      { id: "browser", type: "oauth" as const, label: "ChatGPT browser login" },
      { id: "device-code", type: "oauth" as const, label: "ChatGPT headless/device-code login" }
    ];

    expect(providerAuthOverlayForMethods(apiOnlyMethods)).toBe("providerAuth");
    expect(providerAuthOverlayForMethods(oauthMethods)).toBe("providerAuthMethod");
    expect(connectCommandForProviderAuthMethod("chatgpt", oauthMethods[0])).toBe("/connect chatgpt browser");
    expect(connectCommandForProviderAuthMethod("chatgpt", oauthMethods[1])).toBe("/connect chatgpt headless");
    expect(connectCommandForProviderAuthMethod("openai", apiOnlyMethods[0])).toBeUndefined();
  });

  it("treats provider flows as popup overlays", () => {
    expect(isProviderPopupOverlay("providers")).toBe(true);
    expect(isProviderPopupOverlay("providerAuthMethod")).toBe(true);
    expect(isProviderPopupOverlay("providerAuth")).toBe(true);
    expect(isProviderPopupOverlay("models")).toBe(true);
    expect(isProviderPopupOverlay("slashCommands")).toBe(false);
    expect(isProviderPopupOverlay("none")).toBe(false);
  });

  it("keeps custom provider form visible in the connect provider picker", () => {
    expect(providerDialogTitle("custom", "Custom Provider")).toBe("Custom Provider");
    expect(providerPickerDescription("custom")).toBe("(OpenAI-compatible custom provider)");
    expect(providerEndpointLabel("https://api.example.com/v1")).toBe("https://api.example.com");
    expect(fallbackCommandContainsApiKey("/connect custom secret")).toBe(true);
    expect(fallbackCommandContainsApiKey("/CONNECT Custom Secret")).toBe(true);
    expect(fallbackCommandContainsApiKey("/connect remove custom")).toBe(false);
    expect(providerPickerPriority("custom")).toBeGreaterThan(providerPickerPriority("openai"));
    expect(providerPickerPriority("custom")).toBeLessThan(providerPickerPriority("kimi"));
  });

  it("validates custom provider form IDs and derives API-key env names", () => {
    expect(isValidCustomProviderId("myprovider")).toBe(true);
    expect(isValidCustomProviderId("my-provider_2")).toBe(true);
    expect(isValidCustomProviderId("MyProvider")).toBe(false);
    expect(isValidCustomProviderId("my.provider")).toBe(false);
    const config = testConfig(process.cwd());
    expect(isAvailableCustomProviderId(config, "new-provider", "custom")).toBe(true);
    expect(isAvailableCustomProviderId(config, "custom", "custom")).toBe(true);
    expect(isAvailableCustomProviderId(config, "mock", "custom")).toBe(false);
    expect(apiKeyEnvForProviderId("my-provider_2")).toBe("MY_PROVIDER_2_API_KEY");
  });

  it("renders discovered custom provider models as active", () => {
    expect(activeCustomProviderModelRows(["model-a", "model-b"])).toEqual(["● model-a", "● model-b"]);
    expect(activeCustomProviderModelRows(["model-a", "model-b"], ["model-b"])).toEqual(["○ model-a", "● model-b"]);
    expect(activeCustomProviderModelRows(["model\u001b[31m-red"])[0]).toBe("● model-red");
  });

  it("toggles selected custom provider models", () => {
    const models = ["model-a", "model-b", "model-c"];

    expect(toggleCustomProviderSelectedModel(models, ["model-a", "model-c"], "model-a")).toEqual(["model-c"]);
    expect(toggleCustomProviderSelectedModel(models, ["model-a"], "model-c")).toEqual(["model-a", "model-c"]);
    expect(toggleCustomProviderSelectedModel(models, ["model-a", "stale"], "missing")).toEqual(["model-a"]);
    expect(selectedCustomProviderModels(models, ["model-c", "stale", "model-a"])).toEqual(["model-a", "model-c"]);
  });

  it("detects when custom provider credentials are ready for discovery", () => {
    expect(shouldAutoDiscoverCustomProviderModels("https://api.example.com/v1", "secret-key")).toBe(true);
    expect(shouldAutoDiscoverCustomProviderModels("", "secret-key")).toBe(false);
    expect(shouldAutoDiscoverCustomProviderModels("https://api.example.com/v1", "")).toBe(false);
    expect(shouldAutoDiscoverCustomProviderModels("   ", "secret-key")).toBe(false);
  });

  it("cycles custom provider loading labels through three dot frames", () => {
    expect([0, 1, 2, 3].map(customProviderFetchingModelsText)).toEqual([
      "Fetching models.",
      "Fetching models..",
      "Fetching models...",
      "Fetching models."
    ]);
    expect([0, 1, 2, 3].map(customProviderEndpointLoadingText)).toEqual([
      "Calling endpoint.",
      "Calling endpoint..",
      "Calling endpoint...",
      "Calling endpoint."
    ]);
  });

  it("keeps custom provider input cursor offsets stable across rebuilds", () => {
    expect(customProviderCursorOffset("https://api.example.com/v1", undefined)).toBe(26);
    expect(customProviderCursorOffset("https://api.example.com/v1", 8)).toBe(8);
    expect(customProviderCursorOffset("short", 99)).toBe(5);
    expect(customProviderCursorOffset("short", -3)).toBe(0);
  });

  it("refreshes custom provider discovery only when the model panel is focused", () => {
    expect(shouldRefreshCustomProviderDiscoveryPanel("providerAuth", "custom", 4)).toBe(true);
    expect(shouldRefreshCustomProviderDiscoveryPanel("providerAuth", "custom", 2)).toBe(false);
    expect(shouldRefreshCustomProviderDiscoveryPanel("providerAuth", "openai", 4)).toBe(false);
    expect(shouldRefreshCustomProviderDiscoveryPanel("models", "custom", 4)).toBe(false);
  });

  it("submits prompt text when input sends a line", async () => {
    const outputData = await runScriptedTui(["hello", "/exit"]);

    expect(outputData).toContain("hello");
    expect(outputData).toContain("Mock response: hello");
    expectBounded(outputData);
  });

  it("treats removed slash commands as unknown", async () => {
    const outputData = await runScriptedTui(["/commands diff", "/themes", "/plugins", "/whichkey", "/diff", "/approve", "/pick", "/paste", "/sessions", "/status", "/toast", "/new", "/help", "/exit"]);

    expect(outputData).toContain("Unknown command: /commands diff");
    expect(outputData).toContain("Unknown command: /themes");
    expect(outputData).toContain("Unknown command: /plugins");
    expect(outputData).toContain("Unknown command: /whichkey");
    expect(outputData).toContain("Unknown command: /diff");
    expect(outputData).toContain("Unknown command: /approve");
    expect(outputData).toContain("Unknown command: /pick");
    expect(outputData).toContain("Unknown command: /paste");
    expect(outputData).toContain("Unknown command: /sessions");
    expect(outputData).toContain("Unknown command: /status");
    expect(outputData).toContain("Unknown command: /toast");
    expect(outputData).toContain("Unknown command: /new");
    expect(outputData).toContain("StrongCode commands");
    expect(outputData).toContain("Ctrl+H / F1");
  });

  it("prints available model list for the model command aliases in fallback mode", async () => {
    const outputData = await runScriptedTui(["/model", "/models", "/exit"]);

    expect(outputData).toContain("Models");
    expect(outputData).toContain("> Mock · mock");
    expect(outputData).not.toContain("Unknown command: /model");
    expect(outputData).not.toContain("Unknown command: /models");
    expectBounded(outputData);
  });

  it("persists /model selections for a specific agent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-tui-model-select-"));
    await writeFile(path.join(root, "strongcode.config.yaml"), `version: 1
workspace: "."
dataDir: ".strongcode"
defaultAgent: default
providers:
  mock:
    type: mock
    displayName: Mock
    enabled: true
agents:
  default:
    model: mock
    tools: []
  newton:
    model: mock
    tools: []
models:
  mock:
    provider: mock
    model: mock
    displayName: Mock
    enabled: true
  fast:
    provider: mock
    model: fast
    displayName: Fast Test Model
    enabled: true
permissions:
  tools: {}
`, "utf8");

    const outputData = await runScriptedTuiInDirectory(root, ["/model newton fast", "/exit"]);
    const loaded = await loadConfigInDirectory(root);
    if (!loaded.ok) throw loaded.error;

    expect(outputData).toContain("Model updated: Newton → Fast Test Model");
    expect(loaded.value.config.agents.default.model).toBe("mock");
    expect(loaded.value.config.agents.newton.model).toBe("fast");
  });

  it("prints the session summary command in fallback mode", async () => {
    const outputData = await runScriptedTui(["hello", "/summary", "/exit"]);

    expect(outputData).toContain("Session Summary");
    expect(outputData).toContain("Usage");
    expect(outputData).toContain("Latest turn");
    expect(outputData).toContain("Finished · Tesla");
    expect(outputData).toContain("model");
    expect(outputData).not.toContain("Unknown command: /summary");
    expectBounded(outputData);
  });

  it("compacts fallback context without submitting a normal turn", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-tui-compact-"));
    await writeFile(path.join(root, "strongcode.config.yaml"), `version: 1
workspace: "."
dataDir: ".strongcode"
defaultAgent: default
providers:
  mock:
    type: mock
    displayName: Mock
    enabled: true
agents:
  default:
    model: mock
    tools: []
models:
  mock:
    provider: mock
    model: mock
    enabled: true
permissions:
  tools: {}
`, "utf8");
    const outputData = await runScriptedTuiInDirectory(root, ["/compact", "/exit"]);
    const sessionsDir = path.join(root, ".strongcode", "sessions");
    const files = await readdir(sessionsDir);
    expect(files).toHaveLength(1);
    const session = await readFile(path.join(sessionsDir, files[0] ?? "missing"), "utf8");
    const events = session.trim().split("\n").map(line => JSON.parse(line));

    expect(outputData).toContain("Compacting active context...");
    expect(outputData).toContain("Context compacted. Retained user items: 0.");
    expect(outputData).not.toContain("Mock response: /compact");
    expect(outputData).not.toContain("Mock response: You are performing a context checkpoint compaction");
    expect(outputData).not.toContain("Unknown command: /compact");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "compaction_checkpoint" });
  });

  it("prints editable JSON catalog models for /models in fallback mode", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-tui-model-catalog-"));
    await writeFile(path.join(root, "strongcode.config.yaml"), `version: 1
workspace: "."
dataDir: ".strongcode"
defaultAgent: default
providers:
  mock:
    type: mock
    displayName: Mock
    enabled: true
agents:
  default:
    model: mock
    tools: []
models:
  mock:
    provider: mock
    model: mock
    enabled: true
permissions:
  tools: {}
`, "utf8");
    await mkdir(path.join(root, ".strongcode"));
    await writeFile(path.join(root, ".strongcode", "models.json"), JSON.stringify({
      providers: {
        kimi: {
          name: "Kimi",
          env: ["MOONSHOT_API_KEY"],
          api: "https://api.moonshot.ai/v1",
          models: {
            "kimi-k2": { name: "Kimi K2", id: "kimi-k2" }
          }
        },
        openai: {
          name: "GPT / OpenAI",
          env: ["OPENAI_API_KEY"],
          api: "https://api.openai.com/v1",
          models: {
            "gpt-4.1": { name: "GPT-4.1", id: "gpt-4.1" }
          }
        }
      }
    }), "utf8");

    const outputData = await runScriptedTuiInDirectory(root, ["/models", "/exit"]);

    expect(outputData).toContain("Kimi · Kimi K2 (kimi-k2)");
    expect(outputData).toContain("GPT / OpenAI · GPT-4.1 (gpt-4.1)");
    expect(outputData).not.toContain("sk-");
    expectBounded(outputData);
  });

  it("renders all configured model names instead of only the active provider", () => {
    const state = {
      provider: "mock",
      model: "mock",
      defaultAgent: "default",
      configPath: "strongcode.config.yaml",
      configMissing: false,
      workspace: ".",
      dataDir: ".strongcode"
    };
    const output = renderAllModelList({
      version: 1,
      workspace: ".",
      dataDir: ".strongcode",
      defaultAgent: "default",
      providers: {
        mock: { type: "mock", displayName: "Mock", apiKeyEnv: undefined, baseUrl: undefined, modelsEndpoint: undefined, enabled: true },
        kimi: { type: "openai-compatible", displayName: "Kimi", apiKeyEnv: "MOONSHOT_API_KEY", baseUrl: "https://api.moonshot.ai/v1", modelsEndpoint: "/models", enabled: true },
        openai: { type: "openai", displayName: "GPT / OpenAI", apiKeyEnv: "OPENAI_API_KEY", baseUrl: "https://api.openai.com/v1", modelsEndpoint: "/models", enabled: true }
      },
      agents: { default: { model: "mock", tools: [] } },
      models: {
        mock: { provider: "mock", model: "mock", displayName: undefined, enabled: true, source: undefined, options: undefined },
        "kimi-k2": { provider: "kimi", model: "kimi-k2", displayName: "kimi-k2", enabled: true, source: "discovered", options: undefined },
        "gpt-4.1": { provider: "openai", model: "gpt-4.1", displayName: "gpt-4.1", enabled: true, source: "discovered", options: undefined }
      },
      permissions: { tools: {} }
    }, state, true);

    expect(output).toContain("Mock · mock");
    expect(output).toContain("Kimi · kimi-k2");
    expect(output).toContain("GPT / OpenAI · gpt-4.1");
    expectBounded(output);
  });

  it("sanitizes unknown command text before terminal output", async () => {
    const outputData = await runScriptedTui(["/bad\u001b]52;c;steal\u0007\u001b[31mred", "/exit"]);

    expect(outputData).toContain("/badred");
    expect(outputData).not.toContain("steal");
    expectNoControlSequences(outputData.replace(/\x1b\[[0-9;]*m/g, ""));
    expectBounded(outputData);
  });

  it("removes bidi spoofing controls from unknown fallback commands", async () => {
    const outputData = await runScriptedTui(["/bad\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069command", "/exit"]);

    expect(outputData).toContain("Unknown command: /badcommand");
    expectNoBidiSpoofingControls(outputData);
    expectBounded(outputData);
  });
});

