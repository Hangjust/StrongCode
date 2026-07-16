import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as core from "@opentui/core";
import { createTestRenderer, MouseButtons } from "@opentui/core/testing";
import { SessionStore } from "../../src/sessions/session-store";
import { projectSessionTelemetry } from "../../src/tui/ui/session-summary";

const width = Number.parseInt(process.argv[2] ?? "110", 10);
const prompt = "  Exact 日本語 e\u0301 👩‍💻\x1b[2J\nsecond line  ";

function key(name: string): InstanceType<typeof core.KeyEvent> {
  return new core.KeyEvent({
    name,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    sequence: name === "return" ? "\r" : "",
    number: false,
    raw: "",
    eventType: "press",
    source: "raw"
  });
}

async function waitForFrame(
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
  predicate: (frame: string) => boolean
): Promise<string> {
  const initial = setup.captureCharFrame();
  if (predicate(initial)) return initial;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      setup.renderer.off(core.CliRenderEvents.FRAME, onFrame);
      reject(new Error("Timed out waiting for expected OpenTUI frame"));
    }, 5_000);
    const onFrame = (): void => {
      const frame = setup.captureCharFrame();
      if (!predicate(frame)) return;
      clearTimeout(timeout);
      setup.renderer.off(core.CliRenderEvents.FRAME, onFrame);
      resolve(frame);
    };
    setup.renderer.on(core.CliRenderEvents.FRAME, onFrame);
    setup.renderer.requestRender();
  });
}

async function main(): Promise<void> {
  const originalCwd = process.cwd();
  const root = await mkdtemp(path.join(tmpdir(), "strongcode-preflight-tui-"));
  const setup = await createTestRenderer({
    width,
    height: 30,
    exitOnCtrlC: false,
    useMouse: true,
    enableMouseMovement: true
  });
  const fixedNow = 1_721_088_000_000;
  const sessionId = `session-${fixedNow}`;
  const config = `version: 1
workspace: "."
dataDir: ".strongcode"
defaultAgent: primary
providers:
  mock:
    type: mock
    displayName: Mock
    enabled: true
agents:
  primary:
    model: mock
    tools: []
models:
  mock:
    provider: mock
    model: mock
    enabled: true
preflight:
  enabled: true
  summary:
    model: mock
permissions:
  tools: {}
`;
  await writeFile(path.join(root, "strongcode.config.yaml"), config, "utf8");
  process.chdir(root);
  process.env.STRONGCODE_HOME = path.join(root, "home");
  process.env.STRONGCODE_TRUST_PROJECT_CONFIG = "1";
  process.env.STRONGCODE_TUI_BUN = "1";
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  const originalNow = Date.now;
  Date.now = () => fixedNow;
  let running: Promise<void> | undefined;

  try {
    const { runTui } = await import("../../src/tui/app");
    running = runTui(process.stdin, process.stdout, async () => setup.renderer);
    await waitForFrame(setup, frame => frame.includes("Ready when you are"));
    const homeTextarea = setup.renderer.currentFocusedRenderable;
    if (!(homeTextarea instanceof core.TextareaRenderable)) throw new Error("Home textarea is not focused");
    homeTextarea.setText(prompt);
    setup.renderer.keyInput.emit("keypress", key("return"));
    const session = await waitForFrame(setup, frame => frame.includes("Mock response:"));
    const sessionTextarea = setup.renderer.currentFocusedRenderable;
    if (!(sessionTextarea instanceof core.TextareaRenderable)) throw new Error("Session textarea is not focused");

    setup.renderer.keyInput.emit("keypress", key("f2"));
    const f2Frame = await waitForFrame(setup, frame => frame.includes("FIRST REQUEST"));
    const f2Opened = setup.renderer.root.getRenderable("summary-layer") !== undefined;
    setup.renderer.keyInput.emit("keypress", key("escape"));
    await waitForFrame(setup, frame => !frame.includes("FIRST REQUEST"));
    const escapeRestored = setup.renderer.currentFocusedRenderable === sessionTextarea;

    sessionTextarea.setText("  /summary  ");
    setup.renderer.keyInput.emit("keypress", key("return"));
    await waitForFrame(setup, frame => frame.includes("FIRST REQUEST"));
    const enterOpened = setup.renderer.root.getRenderable("summary-layer") !== undefined;
    setup.renderer.keyInput.emit("keypress", key("escape"));
    await waitForFrame(setup, frame => !frame.includes("FIRST REQUEST"));

    let mouseOpened = false;
    if (width >= 110) {
      await setup.mockMouse.click(width - 29, 7, MouseButtons.LEFT);
      await waitForFrame(setup, frame => frame.includes("FIRST REQUEST"));
      mouseOpened = setup.renderer.root.getRenderable("summary-layer") !== undefined;
      setup.renderer.keyInput.emit("keypress", key("escape"));
      await waitForFrame(setup, frame => !frame.includes("FIRST REQUEST"));
    }

    const sessions = new SessionStore(path.join(root, ".strongcode"));
    const beforeUnknown = await sessions.read(sessionId);
    if (!beforeUnknown.ok) throw beforeUnknown.error;
    sessionTextarea.setText("  /unknown  ");
    setup.renderer.keyInput.emit("keypress", key("return"));
    await waitForFrame(setup, frame => frame.includes("Unknown command: /unknown"));
    const stored = await sessions.read(sessionId);
    if (!stored.ok) throw stored.error;
    const storedPrompt = projectSessionTelemetry(stored.value.events).summary?.originalPrompt;
    const combined = `${session}\n${f2Frame}`;
    const rail = setup.renderer.root.findDescendantById("session-summary-rail");
    const sourceRevision = spawnSync("git", ["-C", originalCwd, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    process.stdout.write(JSON.stringify({
      capturedAt: new Date().toISOString(),
      sourceRevision,
      bunVersion: process.versions.bun ?? null,
      width,
      railVisible: session.includes("SESSION SUMMARY"),
      mouseOpened,
      f2Opened,
      enterOpened,
      escapeRestored,
      unknownDidNotDispatch: stored.value.events.length === beforeUnknown.value.events.length,
      storedPromptExact: storedPrompt === prompt,
      visiblePromptParts: ["Exact 日本語", "e\u0301", "👩‍💻", "second line"].every(part => f2Frame.includes(part)),
      terminalControlVisible: combined.includes("\x1b"),
      railFound: rail instanceof core.BoxRenderable,
      railWidth: rail?.width,
      railVisibleState: rail?.visible,
      frameSha256: createHash("sha256").update(combined).digest("hex")
    }) + "\n");
    setup.renderer.destroy();
    await running;
    running = undefined;
  } finally {
    Date.now = originalNow;
    if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    if (running) await running.catch(() => undefined);
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
}

void main();
