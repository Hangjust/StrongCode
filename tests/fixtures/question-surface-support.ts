import * as core from "@opentui/core";
import { createTestRenderer, MouseButtons } from "@opentui/core/testing";
import { QuestionBroker } from "../../src/questions/broker";
import { parseQuestionRequest, type QuestionRequest } from "../../src/questions/schema";
import { defaultTuiConfig } from "../../src/tui/config/tui";
import { mountQuestionSurface, type QuestionKeymap, type QuestionSimplifier, type QuestionSurfaceController } from "../../src/tui/question/surface";

export type QuestionSurfaceFixtureSetup = Awaited<ReturnType<typeof createTestRenderer>>;

export interface QuestionSurfaceHarness {
  readonly setup: QuestionSurfaceFixtureSetup;
  readonly broker: QuestionBroker;
  readonly testKeymap: { readonly keymap: QuestionKeymap; readonly dispatch: (name: string) => boolean };
  readonly controller: QuestionSurfaceController;
  readonly preMountListenerCount: number;
  readonly preMountResizeListenerCount: number;
  readonly simplifyCalls: () => number;
  readonly simplifierInputs: () => readonly QuestionRequest[];
  readonly aborted: () => boolean;
  readonly destroy: () => void;
}

export interface QuestionSurfaceHarnessOptions {
  readonly preMount?: (setup: QuestionSurfaceFixtureSetup) => void;
}

export function request(count: number, customIndexes: readonly number[] = [2]): QuestionRequest {
  const parsed = parseQuestionRequest({
    questions: Array.from({ length: count }, (_, index) => ({
      id: `question-${index + 1}`,
      header: `Topic ${index + 1}`,
      question: `Which plan fits topic ${index + 1}?`,
      multiple: false,
      allowCustom: customIndexes.includes(index),
      options: [
        { id: `option-${index + 1}-a`, label: "Basic plan", description: "Choose the smaller plan." },
        { id: `option-${index + 1}-b`, label: "Advanced plan", description: "Choose the broader plan." }
      ]
    }))
  });
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

export function maxLine(frame: string): number {
  return Math.max(...frame.trimEnd().split(/\r?\n/).map(line => line.length));
}

export async function settled<T>(value: Promise<T>, setup: QuestionSurfaceFixtureSetup): Promise<T> {
  return await Promise.race([
    value,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(setup.captureCharFrame())), 500))
  ]);
}

export async function click(setup: QuestionSurfaceFixtureSetup, id: string): Promise<void> {
  const row = setup.renderer.root.findDescendantById(id);
  if (!row) throw new Error(`missing ${id}`);
  const x = row.x === 0 ? row.screenX : row.x;
  const y = row.y === 0 ? row.screenY : row.y;
  await setup.mockMouse.moveTo(x + 1, y);
  await setup.flush();
  await setup.mockMouse.click(x + 1, y, MouseButtons.LEFT);
  await setup.flush();
}

function rewritten(original: QuestionRequest): QuestionRequest {
  const parsed = parseQuestionRequest({
    questions: original.questions.map(question => ({
      ...question,
      question: `Simple: ${question.question}`,
      options: question.options.map(option => ({ ...option, label: `Simple ${option.label}` }))
    }))
  });
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

function simplifier(run: (original: QuestionRequest, signal: AbortSignal) => Promise<QuestionRequest>): QuestionSimplifier {
  return { simplify: run };
}

function createKeymap(renderer: InstanceType<typeof core.CliRenderer>): { readonly keymap: QuestionKeymap; readonly dispatch: (name: string) => boolean } {
  let commands: readonly { readonly name: string; readonly run: () => boolean }[] = [];
  return {
    keymap: {
      registerLayer(layer) {
        commands = layer.commands;
        const listener = (event: InstanceType<typeof core.KeyEvent>): void => {
          const name = event.name.toLowerCase();
          const key = event.ctrl && (name === "return" || name === "enter") ? "ctrl+enter" : name;
          const binding = layer.bindings.find(candidate => candidate.key === key);
          const command = binding ? layer.commands.find(candidate => candidate.name === binding.cmd) : undefined;
          if (command?.run()) {
            event.preventDefault();
            event.stopPropagation();
          }
        };
        renderer.keyInput.on("keypress", listener);
        return () => renderer.keyInput.off("keypress", listener);
      }
    },
    dispatch(name) { return commands.find(command => command.name === name)?.run() ?? false; }
  };
}

export async function createQuestionSurfaceHarness(mode: string, options: QuestionSurfaceHarnessOptions = {}): Promise<QuestionSurfaceHarness> {
  const setup = await createTestRenderer({ width: 80, height: 28, exitOnCtrlC: false, useMouse: true, enableMouseMovement: true });
  const broker = new QuestionBroker();
  const testKeymap = createKeymap(setup.renderer);
  const preMountListenerCount = setup.renderer.listenerCount("selection");
  const preMountResizeListenerCount = setup.renderer.listenerCount("resize");
  let simplifyCalls = 0;
  let aborted = false;
  const simplifierInputs: QuestionRequest[] = [];
  const simplifierConfig = mode === "unavailable" ? {} : {
    simplifier: simplifier(async (original, signal) => {
      simplifyCalls += 1;
      simplifierInputs.push(original);
      if (mode === "error") throw new Error("DeepSeek is unavailable");
      if (mode === "lifecycle" || mode === "loading") {
        return await new Promise<QuestionRequest>((_resolve, reject) => {
          signal.addEventListener("abort", () => { aborted = true; reject(new DOMException("cancelled", "AbortError")); }, { once: true });
        });
      }
      return rewritten(original);
    })
  };
  options.preMount?.(setup);
  const controller = mountQuestionSurface({
    core,
    renderer: setup.renderer,
    keymap: testKeymap.keymap,
    theme: defaultTuiConfig().theme,
    broker,
    ...simplifierConfig
  });

  return {
    setup,
    broker,
    testKeymap,
    controller,
    preMountListenerCount,
    preMountResizeListenerCount,
    simplifyCalls: () => simplifyCalls,
    simplifierInputs: () => simplifierInputs,
    aborted: () => aborted,
    destroy() {
      controller.destroy();
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    }
  };
}
