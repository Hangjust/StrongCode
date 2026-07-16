export type QuestionKeyLayer = {
  readonly priority: number;
  readonly commands: readonly { readonly name: string; readonly desc: string; readonly run: () => boolean }[];
  readonly bindings: readonly { readonly key: string; readonly cmd: string }[];
};

export interface QuestionKeymap {
  registerLayer(layer: QuestionKeyLayer): () => void;
}

export interface QuestionKeyActions {
  readonly previous: () => boolean;
  readonly next: () => boolean;
  readonly previousPage: () => boolean;
  readonly nextPage: () => boolean;
  readonly previousFocus: () => boolean;
  readonly nextFocus: () => boolean;
  readonly activate: () => boolean;
  readonly submit: () => boolean;
  readonly simplify: () => boolean;
  readonly dismiss: () => boolean;
}

export function registerQuestionKeyLayer(keymap: QuestionKeymap, actions: QuestionKeyActions): () => void {
  return keymap.registerLayer({
    priority: 500,
    commands: [
      { name: "question.previous", desc: "Previous option", run: actions.previous },
      { name: "question.next", desc: "Next option", run: actions.next },
      { name: "question.previous-page", desc: "Previous question", run: actions.previousPage },
      { name: "question.next-page", desc: "Next question", run: actions.nextPage },
      { name: "question.previous-focus", desc: "Previous focus", run: actions.previousFocus },
      { name: "question.next-focus", desc: "Next focus", run: actions.nextFocus },
      { name: "question.activate", desc: "Activate focused target", run: actions.activate },
      { name: "question.enter", desc: "Activate focused target", run: actions.activate },
      { name: "question.submit", desc: "Submit answers", run: actions.submit },
      { name: "question.simplify", desc: "Simplify questions", run: actions.simplify },
      { name: "question.dismiss", desc: "Dismiss questions", run: actions.dismiss }
    ],
    bindings: [
      { key: "up", cmd: "question.previous" }, { key: "down", cmd: "question.next" },
      { key: "left", cmd: "question.previous-page" }, { key: "right", cmd: "question.next-page" },
      { key: "tab", cmd: "question.next-focus" }, { key: "shift+tab", cmd: "question.previous-focus" },
      { key: "return", cmd: "question.activate" }, { key: "enter", cmd: "question.activate" },
      { key: "space", cmd: "question.activate" }, { key: "ctrl+enter", cmd: "question.submit" },
      { key: "f3", cmd: "question.simplify" }, { key: "escape", cmd: "question.dismiss" }
    ]
  });
}
