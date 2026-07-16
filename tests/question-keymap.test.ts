import { registerQuestionKeyLayer, type QuestionKeyLayer, type QuestionKeymap } from "../src/tui/question/keymap";

function captureLayer(): { readonly layer: QuestionKeyLayer; readonly calls: readonly string[] } {
  const calls: string[] = [];
  let registered: QuestionKeyLayer | undefined;
  const keymap: QuestionKeymap = {
    registerLayer(layer) {
      registered = layer;
      return () => undefined;
    }
  };
  const actions = {
    previous: () => { calls.push("previous"); return true; },
    next: () => { calls.push("next"); return true; },
    previousHorizontal: () => { calls.push("previous-page"); return true; },
    nextHorizontal: () => { calls.push("next-page"); return true; },
    previousTab: () => { calls.push("previous-focus"); return true; },
    nextTab: () => { calls.push("next-focus"); return true; },
    enter: () => { calls.push("enter"); return true; },
    space: () => { calls.push("space"); return true; },
    previousPage: () => { calls.push("previous-page"); return true; },
    nextPage: () => { calls.push("next-page"); return true; },
    previousFocus: () => { calls.push("previous-focus"); return true; },
    nextFocus: () => { calls.push("next-focus"); return true; },
    activate: () => { calls.push("activate"); return true; },
    submit: () => { calls.push("submit"); return true; },
    simplify: () => { calls.push("simplify"); return true; },
    dismiss: () => { calls.push("dismiss"); return true; }
  };

  registerQuestionKeyLayer(keymap, actions);
  if (!registered) throw new Error("question key layer was not registered");
  return { layer: registered, calls };
}

function command(layer: QuestionKeyLayer, name: string): { readonly run: () => boolean } {
  const registered = layer.commands.find(candidate => candidate.name === name);
  if (!registered) throw new Error(`missing question command ${name}`);
  return registered;
}

describe("question keymap", () => {
  it("binds page and focus traversal to semantic question commands", () => {
    // Given
    const { layer } = captureLayer();
    const bindings = new Map(layer.bindings.map(binding => [binding.key, binding.cmd]));

    // When
    const semanticBindings = {
      left: bindings.get("left"),
      right: bindings.get("right"),
      tab: bindings.get("tab"),
      shiftTab: bindings.get("shift+tab")
    };

    // Then
    expect(semanticBindings).toEqual({
      left: "question.previous-page",
      right: "question.next-page",
      tab: "question.next-focus",
      shiftTab: "question.previous-focus"
    });
  });

  it("retains focused activation and lifecycle shortcuts", () => {
    // Given
    const { layer, calls } = captureLayer();
    const bindings = new Map(layer.bindings.map(binding => [binding.key, binding.cmd]));

    // When
    const handled = [
      command(layer, bindings.get("enter") ?? "").run(),
      command(layer, bindings.get("space") ?? "").run(),
      command(layer, bindings.get("ctrl+enter") ?? "").run(),
      command(layer, bindings.get("f3") ?? "").run(),
      command(layer, bindings.get("escape") ?? "").run()
    ];

    // Then
    expect(handled).toEqual([true, true, true, true, true]);
    expect(calls).toEqual(["activate", "activate", "submit", "simplify", "dismiss"]);
  });
});
