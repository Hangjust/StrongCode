import type * as OpenTuiCore from "@opentui/core";
import type { QuestionBroker, PendingQuestion } from "../../questions/broker";
import type { QuestionRequest } from "../../questions/schema";
import type { TuiThemeConfig } from "../config/tui";
import { applySimplifiedDisplay, buildResult, canSubmit, createQuestionState, failSimplification, selectDisplayedRequest, startSimplification, type QuestionState } from "./state";
import { renderQuestionSurface } from "./view";
import { createQuestionSurfaceInteraction } from "./interaction";
import { registerQuestionKeyLayer, type QuestionKeymap } from "./keymap";

export type { QuestionKeymap } from "./keymap";

type Core = typeof OpenTuiCore;
type Renderer = InstanceType<Core["CliRenderer"]>;
type Renderable = NonNullable<Renderer["currentFocusedRenderable"]>;

export interface QuestionSimplifier {
  simplify(original: QuestionRequest, signal: AbortSignal): Promise<QuestionRequest>;
}

export interface QuestionSurfaceOptions {
  readonly core: Core;
  readonly renderer: Renderer;
  readonly keymap: QuestionKeymap;
  readonly theme: TuiThemeConfig;
  readonly broker: QuestionBroker;
  readonly simplifier?: QuestionSimplifier;
}

export interface QuestionSurfaceController {
  destroy(): void;
}

export function mountQuestionSurface(options: QuestionSurfaceOptions): QuestionSurfaceController {
  let pending: PendingQuestion | undefined;
  let state: QuestionState | undefined;
  let previousFocus: Renderable | undefined;
  let generation = 0;
  let simplification: AbortController | undefined;
  let destroyed = false;
  let unregister = (): void => undefined;

  const destroyOverlay = (): void => {
    for (const id of ["question-layer", "question-backdrop"]) {
      const renderable = options.renderer.root.getRenderable(id);
      if (renderable) renderable.destroyRecursively();
    }
    options.renderer.requestRender();
  };

  const restorePreviousFocus = (): void => {
    const saved = previousFocus;
    previousFocus = undefined;
    if (!saved || saved.isDestroyed) return;
    saved.focus();
    options.renderer.focusRenderable(saved);
  };

  const abortSimplification = (): void => {
    generation += 1;
    simplification?.abort();
    simplification = undefined;
  };

  function rerender(): void {
    if (!pending || !state || destroyed) return;
    destroyOverlay();
    const view = renderQuestionSurface({
      core: options.core,
      renderer: options.renderer,
      theme: options.theme,
      state,
      focus: interaction.focus(),
      actions: interaction.actions
    });
    view.focusable.focus();
    options.renderer.focusRenderable(view.focusable);
    options.renderer.requestRender();
  }

  function closeCurrent(): PendingQuestion | undefined {
    const active = pending;
    abortSimplification();
    pending = undefined;
    state = undefined;
    destroyOverlay();
    restorePreviousFocus();
    return active;
  }

  function settleDismissal(): void {
    const active = closeCurrent();
    if (active) options.broker.dismiss(active.token);
  }

  function settleAnswer(): void {
    if (!pending || !state || !canSubmit(state) || state.simplification.kind === "loading") return;
    const result = buildResult(state);
    if (!result.ok) return;
    const active = closeCurrent();
    if (active) options.broker.answer(active.token, result.value);
  }

  async function simplify(): Promise<void> {
    if (!pending || !state || state.simplification.kind === "loading") return;
    if (!options.simplifier) {
      state = failSimplification(state, "Connect DeepSeek to simplify these questions.");
      rerender();
      return;
    }
    const input = selectDisplayedRequest(state);
    abortSimplification();
    const requestGeneration = generation;
    const controller = new AbortController();
    simplification = controller;
    state = startSimplification(state);
    rerender();
    try {
      const display = await options.simplifier.simplify(input, controller.signal);
      if (destroyed || requestGeneration !== generation || controller.signal.aborted || !state) return;
      state = applySimplifiedDisplay(state, display);
    } catch (error) {
      if (destroyed || requestGeneration !== generation || controller.signal.aborted || !state) return;
      state = failSimplification(state, error instanceof Error ? error.message : "DeepSeek could not simplify the questions");
    }
    if (!destroyed && requestGeneration === generation) rerender();
  }

  const interaction = createQuestionSurfaceInteraction({
    currentState: () => state,
    replaceState(next) { state = next; },
    rerender,
    settleAnswer,
    settleDismissal,
    simplify,
    hasPending: () => Boolean(pending)
  });
  const resize = (): void => rerender();
  options.renderer.on("resize", resize);

  const unsubscribe = options.broker.subscribe(next => {
    if (destroyed) return;
    if (next?.token === pending?.token) return;
    if (pending) closeCurrent();
    if (!next) return;
    pending = next;
    state = createQuestionState(next.request);
    interaction.resetFocus();
    previousFocus = options.renderer.currentFocusedRenderable ?? undefined;
    rerender();
  });

  unregister = registerQuestionKeyLayer(options.keymap, interaction.keyActions);

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubscribe();
      unregister();
      options.renderer.off("resize", resize);
      const active = closeCurrent();
      if (active) options.broker.dismiss(active.token);
    }
  };
}
