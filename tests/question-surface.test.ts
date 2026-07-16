import { execFile, spawnSync } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rendererIt = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0 ? it : it.skip;
const PRIVACY_DISCLOSURE = /Simplify sends the visible questions and options to DeepSeek\. Do not enter\s*\n│\s*secrets\./u;

async function runSurfaceFixture(mode: string): Promise<Record<string, unknown>> {
  const fixture = path.resolve(__dirname, "fixtures", "question-surface.ts");
  const { stdout } = await execFileAsync("bun", [fixture, mode], { cwd: path.resolve(__dirname, "..") });
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("question surface", () => {
  rendererIt("renders two questions compactly with disclosure and no Confirm tab", async () => {
    const result = await runSurfaceFixture("compact");

    expect(result.frame).toContain("Topic 2");
    expect(result.frame).toContain("Simplify sends the visible questions and options to DeepSeek.");
    expect(result.frame).not.toContain("[Confirm]");
    expect(result.answer).toMatchObject({ outcome: "answered" });
  });

  rendererIt("renders real question headers in tabs and preserves canonical answers after simplify", async () => {
    const result = await runSurfaceFixture("tabbed");

    expect(result.frame).toContain("1. Topic 1");
    expect(result.frame).toContain("2. Topic 2");
    expect(result.frame).toContain("3. Topic 3");
    expect(result.frame).toContain("Confirm");
    expect(result.frame).toContain("Simplified");
    expect(result.frame).toContain("Show original");
    expect(result.confirmFrame).toContain("Confirm answers");
    expect(result.confirmFrame).toContain("Guidance (optional)");
    expect(result.confirmFrame).toContain("Use the small change.");
    expect(result.answer).toMatchObject({
      outcome: "answered",
      guidance: "Use the small change."
    });
    expect(JSON.stringify(result.answer)).toContain("Which plan fits topic 1?");
  });

  rendererIt("keeps original display and reports a plain error when simplify fails", async () => {
    const result = await runSurfaceFixture("error");

    expect(result.frame).toContain("DeepSeek is unavailable");
    expect(result.frame).toContain("Which plan fits topic 1?");
    expect(result.simplifyCalls).toBe(1);
  });

  rendererIt("reports a visible error when DeepSeek simplification is unavailable", async () => {
    const result = await runSurfaceFixture("unavailable");

    expect(result.frame).toContain("Connect DeepSeek to simplify these questions.");
  });

  rendererIt("lets editors keep spaces, blocks newlines, and dismisses only after a second Escape", async () => {
    const result = await runSurfaceFixture("editor");

    expect(result.editedAnswer).toMatchObject({
      outcome: "answered",
      guidance: "Use small steps"
    });
    expect(JSON.stringify(result.editedAnswer)).toContain("Keep plan");
    expect(result.pendingAfterFirstEscape).toBe(true);
    expect(result.dismissed).toEqual({ outcome: "dismissed" });
  });

  rendererIt("dismisses on Escape and aborts a pending simplification when destroyed", async () => {
    const result = await runSurfaceFixture("lifecycle");

    expect(result.dismissed).toEqual({ outcome: "dismissed" });
    expect(result.aborted).toBe(true);
  });

  rendererIt("destroys replaced editor trees and releases renderer selection listeners", async () => {
    // Given: a mounted three-question surface with its third question's custom editor.
    const result = await runSurfaceFixture("resources");
    const expectedRerenderListenerCounts = Array.from({ length: 24 }, () => result.mountedListenerCount);

    // When: the editor is focused and left with Escape twelve times, then the controller is destroyed.
    // Then: every outgoing editor and its renderer listener are released back to their baselines.
    expect(result.outgoingEditorDestroyed).toEqual(Array.from({ length: 12 }, () => true));
    expect(result.rerenderListenerCounts).toEqual(expectedRerenderListenerCounts);
    expect(result.destroyedListenerCount).toBe(result.preMountListenerCount);
    expect(result.mountedResizeListenerDelta).toBe(1);
    expect(result.destroyedResizeListenerCount).toBe(result.preMountResizeListenerCount);
  });

  rendererIt("keeps every rendered line within narrow and resized viewports", async () => {
    const result = await runSurfaceFixture("width");

    expect(result.maxLine60).toBeLessThanOrEqual(60);
    expect(result.maxLine80).toBeLessThanOrEqual(80);
    expect(result.maxLine100).toBeLessThanOrEqual(100);
    expect(result.frame60).toContain("Q1");
    expect(result.frame60).toContain("Confirm");
    expect(result.frame60).toContain("Simplify sends the visible questions and options to");
    expect(result.frame60).toContain("DeepSeek. Do not enter secrets.");
    expect(result.frame80).toContain("Topic 1");
    expect(result.frame100).toContain("Topic 1");
  });

  rendererIt("uses the compact footer and separated tabs at narrow and wide widths", async () => {
    // Given: a three-question tabbed surface at its supported viewport widths.
    const result = await runSurfaceFixture("width");

    // When: the real renderer lays out the tab strip and footer.
    // Then: narrow mode uses the exact compact hint and each adjacent label is visibly separated.
    expect(result.frame60).toContain("U/D move  L/R tabs  Tab focus  Enter/Spc act  Esc back");
    expect(result.frame60).toMatch(/Q3\s+Confirm/);
    expect(result.frame80).toMatch(/3\. Topic 3\s+Confirm/);
    expect(result.frame100).toMatch(/3\. Topic 3\s+Confirm/);
  });

  rendererIt("rejects an unknown fixture mode without a success payload", () => {
    // Given: a mode outside every question-surface fixture scenario.
    const fixture = path.resolve(__dirname, "fixtures", "question-surface.ts");

    // When: the fixture entrypoint is invoked directly.
    const result = spawnSync("bun", [fixture, "__invalid__"], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" });

    // Then: it fails rather than falling through to width-mode JSON.
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("maxLine60");
  });

  rendererIt("restores the exact external focusable after question rerenders close", async () => {
    // Given: a live focusable outside the question overlay.
    const result = await runSurfaceFixture("previous-focus");

    // When: the surface rerenders for option, page, and resize changes, then closes.
    // Then: the exact external object is still alive and focused again.
    expect(result.externalAlive).toBe(true);
    expect(result.currentFocusIsExternal).toBe(true);
    expect(result.externalFocused).toBe(true);
    expect(result.dismissed).toEqual({ outcome: "dismissed" });
  });

  rendererIt("renders keyboard focus on compact options and actions through a page roundtrip", async () => {
    // Given: a keyboard-only compact two-question request with a custom answer.
    const result = await runSurfaceFixture("focus");

    // When: focus traverses every enabled target and returns across pages.
    // Then: each visible focus target is the corresponding live renderable.
    expect(result.initialId).toBe("question-option-0");
    expect(result.customId).toBe("question-custom");
    expect(result.simplifyId).toBe("question-simplify");
    expect(result.nextId).toBe("question-next");
    expect(result.submitId).toBe("question-submit");
    expect(result.cancelId).toBe("question-cancel");
    expect(result.roundTripId).toBe("question-next");
    expect(result.restoredId).toBe("question-cancel");
  });

  rendererIt("restores accepted editor values after consecutive invalid edits while retaining warnings and privacy", async () => {
    // Given: accepted 2,000-unit custom and guidance editor values.
    const result = await runSurfaceFixture("validation");

    // When: newline, bidi, C0, C1, and an overlength edit are attempted consecutively.
    // Then: every frame restores the accepted canonical value and preserves the warning, disclosure, and focus.
    expect(result.customPlainTexts).toEqual(Array.from({ length: 5 }, () => result.customAccepted));
    expect(result.customFocusIds).toEqual(Array.from({ length: 5 }, () => "question-custom"));
    expect(result.customFrames).toEqual(Array.from({ length: 5 }, () => expect.stringMatching(/Custom answers must be one line\./u)));
    expect(result.customFrames).toEqual(Array.from({ length: 5 }, () => expect.stringMatching(PRIVACY_DISCLOSURE)));
    expect(JSON.stringify(result.customFrames)).not.toMatch(/[\u0001\u0085\u202E]/u);
    expect(result.guidancePlainTexts).toEqual(Array.from({ length: 5 }, () => result.guidanceAccepted));
    expect(result.guidanceFocusIds).toEqual(Array.from({ length: 5 }, () => "question-guidance"));
    expect(result.guidanceFrames).toEqual(Array.from({ length: 5 }, () => expect.stringMatching(/Guidance must be one line\./u)));
    expect(result.guidanceFrames).toEqual(Array.from({ length: 5 }, () => expect.stringMatching(PRIVACY_DISCLOSURE)));
    expect(JSON.stringify(result.guidanceFrames)).not.toMatch(/[\u0001\u0085\u202E]/u);
  });

  rendererIt("simplifies the currently visible request without custom or guidance fields", async () => {
    // Given: three successive simplify operations around Show original.
    const result = await runSurfaceFixture("repeat-simplify");

    // When: the visible simplified display is simplified again, then original is shown.
    // Then: simplifier input follows the visible display and excludes editor-only fields.
    expect(result.questionTexts).toEqual([
      ["Which plan fits topic 1?", "Which plan fits topic 2?", "Which plan fits topic 3?"],
      ["Simple: Which plan fits topic 1?", "Simple: Which plan fits topic 2?", "Simple: Which plan fits topic 3?"],
      ["Which plan fits topic 1?", "Which plan fits topic 2?", "Which plan fits topic 3?"]
    ]);
    expect(result.noCustomOrGuidance).toBe(true);
  });

  rendererIt("keeps loading selection inert while Cancel aborts and dismisses", async () => {
    // Given: a simplification that remains loading.
    const result = await runSurfaceFixture("loading");

    // When: mouse and keyboard activation target options, then Cancel is activated.
    // Then: selections remain unchanged and Cancel aborts/dismisses the request.
    expect(result.activationResults).toEqual([false, false]);
    expect(result.selectionFrame).toContain("[ ] 1. Basic plan");
    expect(result.cancelActivated).toBe(true);
    expect(result.aborted).toBe(true);
    expect(result.dismissed).toEqual({ outcome: "dismissed" });
  });
});
