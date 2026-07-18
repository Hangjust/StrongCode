import * as core from "@opentui/core";
import { createTestRenderer, MouseButtons } from "@opentui/core/testing";
import { appendMessage } from "../../src/tui/app";
import type { TuiState } from "../../src/tui/render";

function key(name: string): InstanceType<typeof core.KeyEvent> {
  return new core.KeyEvent({
    name,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    sequence: name === "return" ? "\r" : name === "space" ? " " : "",
    number: false,
    raw: "",
    eventType: "press",
    source: "raw"
  });
}

function disclosureHeaders(root: core.Renderable): core.BoxRenderable[] {
  const nested = root.getChildren().flatMap(disclosureHeaders);
  return root instanceof core.BoxRenderable && root.id.startsWith("assistant-reasoning-disclosure-")
    ? [root, ...nested]
    : nested;
}

function labelFor(header: core.BoxRenderable): core.TextRenderable {
  const label = header.getChildren().find(child => child instanceof core.TextRenderable);
  if (!(label instanceof core.TextRenderable)) throw new Error("Missing reasoning disclosure label");
  return label;
}

function isColor(label: core.TextRenderable, color: string): boolean {
  return label.fg.equals(core.RGBA.fromHex(color));
}

function isPanelColor(panel: core.BoxRenderable, color: string): boolean {
  return panel.backgroundColor.equals(core.RGBA.fromHex(color));
}

async function main(): Promise<void> {
  const setup = await createTestRenderer({ width: 72, height: 16, exitOnCtrlC: false, useMouse: true, enableMouseMovement: true });
  const state = {
    provider: "mock",
    model: "mock",
    modelDisplayName: "Mock",
    defaultAgent: "Tesla",
    configPath: "strongcode.config.yaml",
    configMissing: false
  } satisfies TuiState;
  const scroll = new core.ScrollBoxRenderable(setup.renderer, { width: "100%", height: "100%", flexDirection: "column", scrollY: true });
  setup.renderer.root.add(scroll);

  try {
    const firstMessage = appendMessage(
      core,
      setup.renderer,
      scroll,
      "assistant",
      "Final answer stays visible.",
      state,
      { status: "finished", agent: "Tesla", model: "Mock", durationMs: 1, toolCalls: 0 },
      "Private reasoning\nsecond line\x1b[2J"
    );
    const otherControl = new core.BoxRenderable(setup.renderer, { id: "unrelated-control", width: "100%", height: 1, focusable: true });
    scroll.add(otherControl);
    await setup.flush();
    const initial = setup.captureCharFrame();
    const headers = disclosureHeaders(setup.renderer.root);
    const firstHeader = headers[0];
    if (!firstHeader) throw new Error("Missing reasoning disclosure header");
    const firstLabel = labelFor(firstHeader);
    const reasoningPanel = firstHeader.parent;
    if (!(reasoningPanel instanceof core.BoxRenderable)) throw new Error("Missing reasoning disclosure panel");
    const finalAnswer = firstMessage.getChildren().find(child => child instanceof core.TextRenderable && child.plainText === "Final answer stays visible.");
    const reasoningPanelUsesBorderAndPanel = Array.isArray(reasoningPanel.border)
      && reasoningPanel.border.length === 1
      && reasoningPanel.border[0] === "left"
      && reasoningPanel.borderColor.equals(core.RGBA.fromHex("#5c4d40"))
      && isPanelColor(reasoningPanel, "#171411");
    const initialIdleLabelMutedOnPanel = isColor(firstLabel, "#9a9184")
      && isPanelColor(firstHeader, "#171411")
      && firstLabel.bg.equals(core.RGBA.fromHex("#171411"));
    const finalAnswerOutsideReasoningPanel = finalAnswer?.parent === firstMessage;

    firstHeader.focus();
    setup.renderer.focusRenderable(firstHeader);
    await setup.flush();
    const collapsedFocusedPrimary = isColor(firstLabel, "#ffb870");

    firstHeader.blur();
    const blurRestoresMuted = isColor(firstLabel, "#9a9184");
    otherControl.focus();
    setup.renderer.focusRenderable(otherControl);
    await setup.flush();
    const collapsedBlurredMuted = isColor(firstLabel, "#9a9184");

    const headerX = firstHeader.x === 0 ? firstHeader.screenX : firstHeader.x;
    const headerY = firstHeader.y === 0 ? firstHeader.screenY : firstHeader.y;
    await setup.mockMouse.moveTo(headerX + 1, headerY);
    await setup.flush();
    const hoveredCollapsedTextOnElement = isColor(firstLabel, "#f2eee6")
      && isPanelColor(firstHeader, "#221d19")
      && firstLabel.bg.equals(core.RGBA.fromHex("#221d19"));
    const hoverDoesNotFocusOrToggle = setup.renderer.currentFocusedRenderable === otherControl
      && !setup.captureCharFrame().includes("Private reasoning");
    await setup.mockMouse.moveTo(setup.renderer.width - 1, setup.renderer.height - 1);
    await setup.flush();
    const pointerExitRestoresIdle = isColor(firstLabel, "#9a9184")
      && isPanelColor(firstHeader, "#171411")
      && firstLabel.bg.equals(core.RGBA.fromHex("#171411"));

    setup.renderer.keyInput.emit("keypress", key("return"));
    setup.renderer.keyInput.emit("keypress", key("space"));
    await setup.flush();
    const unfocusedKeyboardIgnored = !setup.captureCharFrame().includes("Private reasoning");

    await setup.mockMouse.click(headerX + 1, headerY, MouseButtons.LEFT);
    await setup.flush();
    const expandedByMouse = setup.captureCharFrame();

    await setup.mockMouse.click(headerX + 1, headerY, MouseButtons.LEFT);
    await setup.flush();
    const collapsedByMouse = setup.captureCharFrame();

    firstHeader.focus();
    setup.renderer.focusRenderable(firstHeader);
    setup.renderer.keyInput.emit("keypress", key("return"));
    await setup.flush();
    const expandedByEnter = setup.captureCharFrame();

    otherControl.focus();
    setup.renderer.focusRenderable(otherControl);
    await setup.flush();
    const expandedBlurredPrimaryOnPanel = isColor(firstLabel, "#ffb870")
      && isPanelColor(firstHeader, "#171411")
      && firstLabel.bg.equals(core.RGBA.fromHex("#171411"));

    firstHeader.focus();
    setup.renderer.focusRenderable(firstHeader);
    setup.renderer.keyInput.emit("keypress", key("space"));
    await setup.flush();
    const collapsedBySpace = setup.captureCharFrame();

    appendMessage(
      core,
      setup.renderer,
      scroll,
      "assistant",
      "Second final answer stays visible.",
      state,
      { status: "finished", agent: "Tesla", model: "Mock", durationMs: 1, toolCalls: 0 },
      "Second private reasoning"
    );
    await setup.flush();
    const allHeaders = disclosureHeaders(setup.renderer.root);
    const secondHeader = allHeaders[1];
    if (!secondHeader) throw new Error("Missing second reasoning disclosure header");
    const secondLabel = labelFor(secondHeader);
    const secondCollapsedBlurredMuted = isColor(secondLabel, "#9a9184");
    const secondHeaderX = secondHeader.x === 0 ? secondHeader.screenX : secondHeader.x;
    const secondHeaderY = secondHeader.y === 0 ? secondHeader.screenY : secondHeader.y;
    await setup.mockMouse.click(secondHeaderX + 1, secondHeaderY, MouseButtons.LEFT);
    await setup.flush();
    const secondExpanded = setup.captureCharFrame();

    const includeFrames = process.argv.includes("--frames");
    process.stdout.write(JSON.stringify({
      initialCollapsed: initial.includes("[+] Reasoning"),
      initialFinalAnswer: initial.includes("Final answer stays visible."),
      initialReasoningHidden: !initial.includes("Private reasoning") && !initial.includes("second line"),
      reasoningPanelUsesBorderAndPanel,
      initialIdleLabelMutedOnPanel,
      hoveredCollapsedTextOnElement,
      hoverDoesNotFocusOrToggle,
      pointerExitRestoresIdle,
      expandedBlurredPrimaryOnPanel,
      finalAnswerOutsideReasoningPanel,
      disclosureIdsAreUnique: new Set(allHeaders.map(header => header.id)).size === allHeaders.length,
      disclosureIdsUsePrefix: allHeaders.every(header => header.id.startsWith("assistant-reasoning-disclosure-")),
      collapsedBlurredMuted: secondCollapsedBlurredMuted && collapsedBlurredMuted,
      collapsedFocusedPrimary,
      blurRestoresMuted,
      unfocusedKeyboardIgnored,
      mouseExpanded: expandedByMouse.includes("[-] Reasoning") && expandedByMouse.includes("Private reasoning") && expandedByMouse.includes("second line"),
      mouseExpansionSanitized: !expandedByMouse.includes("\x1b"),
      mouseCollapsed: collapsedByMouse.includes("[+] Reasoning") && !collapsedByMouse.includes("Private reasoning"),
      enterExpanded: expandedByEnter.includes("[-] Reasoning") && expandedByEnter.includes("Private reasoning"),
      spaceCollapsed: collapsedBySpace.includes("[+] Reasoning") && !collapsedBySpace.includes("Private reasoning"),
      disclosuresToggleIndependently: secondExpanded.includes("Second private reasoning") && !secondExpanded.includes("Private reasoning\nsecond line"),
      finalAnswerAlwaysVisible: [initial, expandedByMouse, collapsedByMouse, expandedByEnter, collapsedBySpace].every(frame => frame.includes("Final answer stays visible.")),
      ...(includeFrames ? { initialFrame: initial, expandedFrame: expandedByMouse } : {})
    }) + "\n");
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy();
  }
}

void main();
