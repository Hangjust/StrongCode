import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as core from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

function key(name: string, ctrl = false): InstanceType<typeof core.KeyEvent> {
  return new core.KeyEvent({
    name,
    ctrl,
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

function disclosureHeaders(root: core.Renderable): core.BoxRenderable[] {
  const nested = root.getChildren().flatMap(disclosureHeaders);
  return root instanceof core.BoxRenderable && root.id.startsWith("assistant-reasoning-disclosure-")
    ? [root, ...nested]
    : nested;
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

async function startReasoningProvider(): Promise<{ readonly baseUrl: string; close(): Promise<void> }> {
  const responses = [
    { content: "Final answer one.", reasoning: "Private reasoning one." },
    { content: "Final answer two.", reasoning: "Private reasoning two." }
  ];
  let responseIndex = 0;
  const server = createServer((_request, response) => {
    const message = responses[responseIndex] ?? responses[responses.length - 1];
    responseIndex += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Reasoning fixture provider did not expose a TCP address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  };
}

async function main(): Promise<void> {
  const originalCwd = process.cwd();
  const originalHome = process.env.STRONGCODE_HOME;
  const originalTrust = process.env.STRONGCODE_TRUST_PROJECT_CONFIG;
  const originalBun = process.env.STRONGCODE_TUI_BUN;
  const originalApiKey = process.env.FIXTURE_OPENAI_API_KEY;
  const root = await mkdtemp(path.join(tmpdir(), "strongcode-reasoning-navigation-"));
  const setup = await createTestRenderer({ width: 72, height: 24, exitOnCtrlC: false, useMouse: true, enableMouseMovement: true });
  const provider = await startReasoningProvider();
  let running: Promise<void> | undefined;

  try {
    await writeFile(path.join(root, "strongcode.config.yaml"), `version: 1
workspace: "."
dataDir: ".strongcode"
defaultAgent: primary
providers:
  fixture:
    type: openai-compatible
    displayName: Fixture
    apiKeyEnv: FIXTURE_OPENAI_API_KEY
    baseUrl: ${provider.baseUrl}
    enabled: true
agents:
  primary:
    model: fixture
    tools: []
models:
  fixture:
    provider: fixture
    model: fixture-model
    enabled: true
permissions:
  tools: {}
`, "utf8");
    process.chdir(root);
    process.env.STRONGCODE_HOME = path.join(root, "home");
    process.env.STRONGCODE_TRUST_PROJECT_CONFIG = "1";
    process.env.STRONGCODE_TUI_BUN = "1";
    process.env.FIXTURE_OPENAI_API_KEY = "fixture-key";
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });

    const { runTui } = await import("../../src/tui/app");
    running = runTui(process.stdin, process.stdout, async () => setup.renderer);
    await waitForFrame(setup, frame => frame.includes("Ask anything"));
    const homeTextarea = setup.renderer.currentFocusedRenderable;
    if (!(homeTextarea instanceof core.TextareaRenderable)) throw new Error("Home textarea is not focused");
    homeTextarea.setText("first response");
    setup.renderer.keyInput.emit("keypress", key("return"));
    await waitForFrame(setup, frame => frame.includes("Final answer one."));
    const sessionTextarea = setup.renderer.currentFocusedRenderable;
    if (!(sessionTextarea instanceof core.TextareaRenderable)) throw new Error("Session textarea is not focused after the first response");

    setup.renderer.keyInput.emit("keypress", key("r", true));
    await setup.flush();
    const firstDisclosure = setup.renderer.currentFocusedRenderable;
    const firstFocusedFromTextarea = firstDisclosure?.id.startsWith("assistant-reasoning-disclosure-") ?? false;

    setup.renderer.keyInput.emit("keypress", key("escape"));
    await setup.flush();
    sessionTextarea.setText("second response");
    setup.renderer.keyInput.emit("keypress", key("return"));
    await waitForFrame(setup, frame => frame.includes("Final answer two."));
    const headers = disclosureHeaders(setup.renderer.root);
    const newestHeader = headers[headers.length - 1];
    const olderHeader = headers[0];
    if (!newestHeader || !olderHeader) throw new Error("Expected two completed reasoning disclosures");

    setup.renderer.keyInput.emit("keypress", key("r", true));
    await setup.flush();
    const newestFocused = setup.renderer.currentFocusedRenderable === newestHeader;
    setup.renderer.keyInput.emit("keypress", key("r", true));
    await setup.flush();
    const repeatedCommandCycles = setup.renderer.currentFocusedRenderable === olderHeader;
    setup.renderer.keyInput.emit("keypress", key("escape"));
    await setup.flush();

    process.stdout.write(JSON.stringify({
      firstFocusedFromTextarea,
      newestFocused,
      repeatedCommandCycles,
      escapeRestoresTextarea: setup.renderer.currentFocusedRenderable === sessionTextarea,
      distinctDisclosureIds: new Set(headers.map(header => header.id)).size === headers.length
    }) + "\n");
    setup.renderer.destroy();
    await running;
    running = undefined;
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    if (running) await running.catch(() => undefined);
    await provider.close();
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.STRONGCODE_HOME;
    else process.env.STRONGCODE_HOME = originalHome;
    if (originalTrust === undefined) delete process.env.STRONGCODE_TRUST_PROJECT_CONFIG;
    else process.env.STRONGCODE_TRUST_PROJECT_CONFIG = originalTrust;
    if (originalBun === undefined) delete process.env.STRONGCODE_TUI_BUN;
    else process.env.STRONGCODE_TUI_BUN = originalBun;
    if (originalApiKey === undefined) delete process.env.FIXTURE_OPENAI_API_KEY;
    else process.env.FIXTURE_OPENAI_API_KEY = originalApiKey;
    await rm(root, { recursive: true, force: true });
  }
}

void main();
