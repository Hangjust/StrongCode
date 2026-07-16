import { rm } from "node:fs/promises";
import * as core from "@opentui/core";
import { createTestRenderer, MouseButtons } from "@opentui/core/testing";
import { AgentRunner } from "../../src/agents/runner";
import type { Agent } from "../../src/agents/agent";
import type { ModelProvider, ModelRequest, ModelResponse } from "../../src/models/provider";
import type { SessionEvent } from "../../src/sessions/session";
import { SessionStore } from "../../src/sessions/session-store";
import { ToolRegistry } from "../../src/tools/registry";
import { defaultTuiConfig } from "../../src/tui/config/tui";
import { installQuestionRuntime } from "../../src/tui/question/runtime";
import { mountQuestionSurface, type QuestionKeymap } from "../../src/tui/question/surface";
import { tempWorkspace } from "../helpers";

function createKeymap(renderer: InstanceType<typeof core.CliRenderer>): QuestionKeymap {
  return {
    registerLayer(layer) {
      const listener = (event: InstanceType<typeof core.KeyEvent>): void => {
        const name = event.name.toLowerCase();
        const key = event.ctrl && (name === "return" || name === "enter") ? "ctrl+enter" : name;
        const binding = layer.bindings.find(candidate => candidate.key === key);
        const command = binding ? layer.commands.find(candidate => candidate.name === binding.cmd) : undefined;
        if (!command?.run()) return;
        event.preventDefault();
        event.stopPropagation();
      };
      renderer.keyInput.on("keypress", listener);
      return () => renderer.keyInput.off("keypress", listener);
    }
  };
}

async function click(setup: Awaited<ReturnType<typeof createTestRenderer>>, id: string): Promise<void> {
  const row = setup.renderer.root.findDescendantById(id);
  if (!row) throw new Error(`Missing OpenTUI control: ${id}`);
  const x = row.x === 0 ? row.screenX : row.x;
  const y = row.y === 0 ? row.screenY : row.y;
  await setup.mockMouse.moveTo(x + 1, y);
  await setup.flush();
  await setup.mockMouse.click(x + 1, y, MouseButtons.LEFT);
  await setup.flush();
}

async function completeWithin<T>(value: Promise<T>, setup: Awaited<ReturnType<typeof createTestRenderer>>): Promise<T> {
  return await Promise.race([
    value,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(setup.captureCharFrame())), 500))
  ]);
}

async function run(): Promise<void> {
  const workspace = await tempWorkspace();
  const timeline: string[] = [];
  const config = {
    ...workspace.config,
    agents: {
      ...workspace.config.agents,
      default: { ...workspace.config.agents.default, tools: ["question"] }
    },
    permissions: { tools: { question: "allow" as const } }
  };
  const context = {
    ...workspace.context,
    config,
    emit(event: { readonly type: string }): void {
      timeline.push(`runtime:${event.type}`);
    }
  };
  const setup = await createTestRenderer({ width: 100, height: 28, exitOnCtrlC: false, useMouse: true, enableMouseMovement: true });
  const registry = new ToolRegistry();
  const runtime = installQuestionRuntime(registry, {
    context,
    authStore: { async get() { return undefined; }, async all() { return {}; } },
    allowEnvironmentCredentials: false
  });
  const controller = mountQuestionSurface({
    core,
    renderer: setup.renderer,
    keymap: createKeymap(setup.renderer),
    theme: defaultTuiConfig().theme,
    broker: runtime.broker
  });
  const sessions = new SessionStore(context.dataDir);
  const recordSessionEvent = (event: SessionEvent): void => {
    if (event.type === "message") timeline.push(`session:${event.role}${event.role === "assistant" ? `:${event.content}` : ""}`);
    if (event.type === "conversation_item" && event.item.type === "tool_call") timeline.push(`session:call:${event.item.name}`);
    if (event.type === "conversation_item" && event.item.type === "tool_result") timeline.push(`session:result:${event.item.callId}`);
  };
  const append = sessions.append.bind(sessions);
  sessions.append = async (sessionId, event) => {
    const result = await append(sessionId, event);
    if (result.ok) recordSessionEvent(event);
    return result;
  };
  const commitGuarded = sessions.commitGuarded.bind(sessions);
  sessions.commitGuarded = async (sessionId, event, guard) => {
    const result = await commitGuarded(sessionId, event, guard);
    if (result.ok && result.value.kind === "committed" && event !== undefined) recordSessionEvent(event);
    return result;
  };
  const requests: ModelRequest[] = [];
  const responses: ModelResponse[] = [
    {
      message: "I need three choices.",
      toolCalls: [{
        callId: "call-question-flow",
        name: "question",
        input: {
          questions: [
            {
              id: "command-style",
              header: "Command style",
              question: "Which command style should we use?",
              options: [
                { id: "short", label: "Use short names", description: "Use brief command names." },
                { id: "current", label: "Keep current names", description: "Keep the current command names." }
              ]
            },
            {
              id: "output-format",
              header: "Output format",
              question: "Which output format should we use?",
              options: [
                { id: "plain", label: "Plain text", description: "Show plain terminal text." },
                { id: "json", label: "JSON output", description: "Show JSON output." }
              ]
            },
            {
              id: "error-style",
              header: "Error style",
              question: "Which error style should we use?",
              options: [
                { id: "brief", label: "Brief errors", description: "Use short error messages." },
                { id: "detailed", label: "Detailed errors", description: "Show more error details." }
              ]
            }
          ]
        }
      }]
    },
    { message: "I will follow those choices.", toolCalls: [] }
  ];
  const model: ModelProvider = {
    name: "scripted-memory",
    async complete(request) {
      timeline.push(`model:${requests.length + 1}`);
      requests.push(request);
      const response = responses.shift();
      if (!response) throw new Error("Scripted model exhausted");
      return response;
    }
  };
  const agent: Agent = { name: "default", config: config.agents.default, model };
  const runner = new AgentRunner(context, sessions, registry, { maxToolCalls: 1 });

  try {
    let questionPublished: (() => void) | undefined;
    const published = new Promise<void>(resolve => { questionPublished = resolve; });
    const unsubscribe = runtime.broker.subscribe(pending => {
      if (pending) questionPublished?.();
    });
    const running = runner.run(agent, "Choose a safe command style.", "question-flow");
    await published;
    unsubscribe();
    await setup.flush();
    const initialFrame = setup.captureCharFrame();
    const requestCountBeforeAnswer = requests.length;

    await click(setup, "question-option-1");
    setup.mockInput.pressArrow("right");
    await setup.flush();
    setup.mockInput.pressEnter();
    await setup.flush();
    setup.mockInput.pressArrow("right");
    await setup.flush();
    setup.mockInput.pressEnter();
    await setup.flush();
    setup.mockInput.pressArrow("right");
    await setup.flush();
    const guidance = setup.renderer.currentFocusedRenderable;
    if (!guidance || guidance.id !== "question-guidance") throw new Error("Confirm guidance editor did not receive focus");
    await setup.mockInput.pasteBracketedText("Keep the current command names.");
    await setup.flush();
    await click(setup, "question-submit");

    const result = await completeWithin(running, setup);
    if (!result.ok) throw result.error;
    const session = await sessions.read("question-flow");
    if (!session.ok) throw session.error;
    process.stdout.write(JSON.stringify({
      initialFrame,
      requestCountBeforeAnswer,
      requests,
      run: result.value,
      sessionEvents: session.value.events,
      timeline
    }));
  } finally {
    controller.destroy();
    await runner.close();
    if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    await rm(workspace.root, { recursive: true, force: true });
  }
}

void run().then(() => process.exit(0));
