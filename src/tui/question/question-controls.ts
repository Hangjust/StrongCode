import type * as OpenTuiCore from "@opentui/core";
import type { TuiThemeConfig } from "../config/tui";
import type { QuestionSurfaceActions } from "./interaction";
import type { QuestionState } from "./state";

type Core = typeof OpenTuiCore;
type Renderer = InstanceType<Core["CliRenderer"]>;
export type QuestionRenderable = NonNullable<Renderer["currentFocusedRenderable"]>;
type TextParent = InstanceType<Core["BoxRenderable"]> | InstanceType<Core["ScrollBoxRenderable"]>;

export interface QuestionControlContext {
  readonly core: Core;
  readonly renderer: Renderer;
  readonly theme: TuiThemeConfig;
}

interface TextOptions {
  readonly content: string;
  readonly muted?: boolean;
  readonly id?: string;
  readonly color?: string;
  readonly wrapMode?: "word" | "none";
}

interface ActionOptions {
  readonly id: string;
  readonly label: string;
  readonly highlighted: boolean;
  readonly disabled: boolean;
  readonly compact: boolean;
  readonly grow?: number;
  readonly trailingMargin?: number;
  readonly onClick: () => void;
}

export const COMPACT_QUESTION_FOOTER = "U/D move  L/R tabs  Tab focus  Enter/Spc act  Esc back";

export function addQuestionText(context: QuestionControlContext, parent: TextParent, options: TextOptions): void {
  const { core, renderer, theme } = context;
  parent.add(new core.TextRenderable(renderer, {
    id: options.id,
    content: options.content,
    fg: options.color ?? (options.muted ? theme.muted : theme.text),
    bg: theme.panel,
    width: "100%",
    height: "auto",
    wrapMode: options.wrapMode ?? "word"
  }));
}

export function addQuestionAction(
  context: QuestionControlContext,
  parent: InstanceType<Core["BoxRenderable"]>,
  options: ActionOptions,
): QuestionRenderable {
  const { core, renderer, theme } = context;
  const background = options.highlighted ? theme.element : theme.panel;
  const action = new core.TextRenderable(renderer, {
    id: options.id,
    content: options.label,
    fg: options.highlighted ? theme.primary : options.disabled ? theme.muted : theme.text,
    bg: background,
    height: 1,
    width: "auto",
    flexShrink: 0,
    flexGrow: options.grow ?? 0,
    marginRight: options.trailingMargin ?? 0,
    paddingLeft: options.compact ? 0 : 1,
    paddingRight: options.compact ? 0 : 1,
    wrapMode: "none",
    onMouseDown: event => { if (event.button === 0) options.onClick(); }
  });
  parent.add(action);
  return action;
}

export function addQuestionTabs(
  context: QuestionControlContext,
  parent: InstanceType<Core["BoxRenderable"]>,
  state: QuestionState,
  actions: QuestionSurfaceActions,
): void {
  if (state.mode !== "tabbed") return;
  const { core, renderer, theme } = context;
  const tabs = new core.BoxRenderable(renderer, {
    width: "100%",
    height: 1,
    flexDirection: "row",
    gap: 1,
    backgroundColor: theme.panel,
    overflow: "hidden"
  });
  parent.add(tabs);
  state.original.questions.forEach((question, index) => {
    const active = state.activeTabIndex === index;
    const label = renderer.width < 80 ? `Q${index + 1}` : `${index + 1}. ${question.header}`;
    addQuestionAction(context, tabs, {
      id: `question-tab-${index}`,
      label: `${active ? ">" : " "} ${label}`,
      highlighted: active,
      disabled: false,
      compact: true,
      grow: active ? 4 : 0,
      trailingMargin: active ? 1 : 0,
      onClick: () => actions.selectTab(index)
    });
  });
  addQuestionAction(context, tabs, {
    id: "question-confirm",
    label: state.activeTabIndex === state.original.questions.length ? "> Confirm" : "Confirm",
    highlighted: state.activeTabIndex === state.original.questions.length,
    disabled: false,
    compact: true,
    grow: 1,
    onClick: () => actions.selectTab(state.original.questions.length)
  });
}

export function questionFooter(state: QuestionState, width: number): string {
  if (width < 80) return COMPACT_QUESTION_FOOTER;
  return state.mode === "tabbed"
    ? "Up/Down move  Left/Right tabs  Enter select  Ctrl+Enter submit  Esc cancel"
    : "Up/Down move  Enter select  F3 simplify  Esc cancel";
}
