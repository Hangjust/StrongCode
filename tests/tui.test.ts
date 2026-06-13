import { renderAllModelList, renderHome, renderSessionLayout, renderStatus, renderHints } from "../src/tui/render";
import { activeCustomProviderModelRows, apiKeyEnvForProviderId, connectCommandForProviderAuthMethod, customProviderCursorOffset, customProviderEndpointLoadingText, customProviderFetchingModelsText, draftHomeCommandOverlay, exactHomeCommandOverlay, isProviderPopupOverlay, isValidCustomProviderId, navigationKeyName, nextSelectionIndex, promptDraftAfterEscape, providerAuthOverlayForMethods, providerDialogRowCount, providerDialogSelectedRowIndex, providerDialogTitle, providerPickerDescription, providerPickerPriority, runTui, scrollTopForSelectedRow, selectedCustomProviderModels, selectedSlashCommand, selectedTextForClipboard, shouldAutoDiscoverCustomProviderModels, shouldCopySelectionForInput, shouldCopySelectionForMouse, shouldRefreshCustomProviderDiscoveryPanel, shouldSubmitHomePrompt, shouldSubmitHomeValue, slashOverlayTop, toggleCustomProviderSelectedModel } from "../src/tui/app";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

function countOccurrences(output: string, value: string): number {
  return output.split(value).length - 1;
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

async function runScriptedTuiInDirectory(directory: string, lines: string[]): Promise<string> {
  const originalCwd = process.cwd();
  process.chdir(directory);
  try {
    return await runScriptedTui(lines);
  } finally {
    process.chdir(originalCwd);
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
     
    expect(home).toContain("██████ ██████ █████");
    expect(home).toContain("Strong Code · GPT-5.5");
    expect(home).toContain("Ask anything...");
    expect(countOccurrences(home, "Strong Code ·")).toBe(1);
    const logoLine = home.split("\n").find(line => line.includes("██████ ██████ █████"));
    const promptLine = home.split("\n").find(line => line.includes("Ask anything..."));
    expect(logoLine).toBeDefined();
    expect(promptLine).toBeDefined();
    expect(promptLine?.indexOf("┃")).toBeGreaterThanOrEqual(logoLine?.search(/\S/) ?? 0);
    expect(home).not.toContain("LOCAL AGENT FORGE");
    expect(home).not.toContain("TUI OPERATIONS CONSOLE");
    expect(home).not.toContain("it says");
    expect(home).not.toContain("ctrl+x agents");
    expect(home).not.toContain("ctrl+x commands");
    expect(home).not.toContain("N/A");
    expect(home).not.toContain("▀");
    expect(home).toContain("/connect");
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
    expect(keybinds.command_palette).toEqual(["p"]);
    expect(keybinds.app_exit).toEqual([]);
    expect(descriptions.join("\n")).toContain("command_palette");
    expect(palette.list().map(command => command.slash)).toEqual(["/connect", "/model", "/models", "/exit"]);
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
    palette.select(1);

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
    expect(output).toContain("Connect a provider");
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

  it("refreshes provider status after connect in the same scripted TUI session", async () => {
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

    const outputData = await runScriptedTuiInDirectory(root, ["/connect custom same-session-key", "/exit"]);

    expect(outputData).toContain("Connected custom; credentials saved in auth.json");
    expect(outputData).not.toContain("same-session-key");
    expectBounded(outputData);
  });

  it("registers the supported startup slash suggestions", async () => {
    const palette = createDefaultPalette();

    expect(palette.list().map(command => command.slash)).toEqual(["/connect", "/model", "/models", "/exit"]);
    expect(palette.find("/connect")?.title).toBe("Connect");
    expect(palette.find("/model")?.title).toBe("Model");
    expect(palette.find("/exit")?.title).toBe("Exit");
    expect(palette.find("/providers")).toBeUndefined();
  });

  it("resolves partial slash input through the selected suggestion", () => {
    const palette = createDefaultPalette();
    const connectSuggestions = palette.search("con").sort((left, right) => left.slash.localeCompare(right.slash));

    expect(selectedSlashCommand(connectSuggestions, 0)?.slash).toBe("/connect");
    expect(selectedSlashCommand([], 0)).toBeUndefined();
  });

  it("routes exact home provider and model commands to picker overlays", () => {
    expect(exactHomeCommandOverlay("/provider")).toBeUndefined();
    expect(exactHomeCommandOverlay("/connect")).toBe("providers");
    expect(exactHomeCommandOverlay("/providers")).toBeUndefined();
    expect(exactHomeCommandOverlay("/model")).toBe("models");
    expect(exactHomeCommandOverlay("/models")).toBe("models");
    expect(exactHomeCommandOverlay("/provider list")).toBeUndefined();
    expect(exactHomeCommandOverlay("hello")).toBeUndefined();
    expect(shouldSubmitHomePrompt("none")).toBe(true);
    expect(shouldSubmitHomePrompt("providers")).toBe(false);
    expect(shouldSubmitHomePrompt("providerAuthMethod")).toBe(false);
    expect(shouldSubmitHomePrompt("models")).toBe(false);
    expect(shouldSubmitHomePrompt("slashCommands")).toBe(false);
    expect(shouldSubmitHomeValue("slashCommands", "/connect")).toBe(true);
    expect(shouldSubmitHomeValue("slashCommands", "/providers")).toBe(false);
    expect(shouldSubmitHomeValue("slashCommands", "/model")).toBe(true);
    expect(shouldSubmitHomeValue("slashCommands", "/models")).toBe(true);
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
    const openAiMethods = [{ type: "oauth" as const, label: "ChatGPT Plus/Pro" }, { type: "api" as const, label: "Manually enter API Key" }];
    const apiOnlyMethods = [{ type: "api" as const, label: "API key" }];

    expect(providerAuthOverlayForMethods(openAiMethods)).toBe("providerAuthMethod");
    expect(providerAuthOverlayForMethods(apiOnlyMethods)).toBe("providerAuth");
    expect(connectCommandForProviderAuthMethod("openai", openAiMethods[0])).toBe("/connect openai chatgpt-browser");
    expect(connectCommandForProviderAuthMethod("openai", openAiMethods[1])).toBeUndefined();
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
    expect(providerPickerPriority("custom")).toBeGreaterThan(providerPickerPriority("openai"));
    expect(providerPickerPriority("custom")).toBeLessThan(providerPickerPriority("kimi"));
  });

  it("validates custom provider form IDs and derives API-key env names", () => {
    expect(isValidCustomProviderId("myprovider")).toBe(true);
    expect(isValidCustomProviderId("my-provider_2")).toBe(true);
    expect(isValidCustomProviderId("MyProvider")).toBe(false);
    expect(isValidCustomProviderId("my.provider")).toBe(false);
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
    expect(outputData).toContain("Unknown command: /help");
  });

  it("prints available model list for the model command aliases in fallback mode", async () => {
    const outputData = await runScriptedTui(["/model", "/models", "/exit"]);

    expect(outputData).toContain("Models");
    expect(outputData).toContain("> Mock · mock");
    expect(outputData).not.toContain("Unknown command: /model");
    expect(outputData).not.toContain("Unknown command: /models");
    expectBounded(outputData);
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
});

