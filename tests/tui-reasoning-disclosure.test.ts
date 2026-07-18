import { execFile, spawnSync } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rendererIt = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0 ? it : it.skip;

describe("completed reasoning disclosure", () => {
  rendererIt("keeps final text visible while mouse and keyboard toggle sanitized completed reasoning", async () => {
    // Given: a completed assistant message with final-only response text and private reasoning.
    const fixture = path.resolve(__dirname, "fixtures", "render-reasoning-disclosure.ts");

    // When: a real OpenTUI renderer drives the disclosure through mouse, Enter, and Space.
    const { stdout, stderr } = await execFileAsync("bun", [fixture], { cwd: path.resolve(__dirname, "..") });

    // Then: the collapsed and expanded frames expose only the requested state and final answer.
    expect(stdout).toContain('"initialCollapsed":true');
    expect(stdout).toContain('"initialFinalAnswer":true');
    expect(stdout).toContain('"initialReasoningHidden":true');
    expect(stdout).toContain('"reasoningPanelUsesBorderAndPanel":true');
    expect(stdout).toContain('"initialIdleLabelMutedOnPanel":true');
    expect(stdout).toContain('"hoveredCollapsedTextOnElement":true');
    expect(stdout).toContain('"hoverDoesNotFocusOrToggle":true');
    expect(stdout).toContain('"pointerExitRestoresIdle":true');
    expect(stdout).toContain('"expandedBlurredPrimaryOnPanel":true');
    expect(stdout).toContain('"finalAnswerOutsideReasoningPanel":true');
    expect(stdout).toContain('"mouseExpanded":true');
    expect(stdout).toContain('"mouseExpansionSanitized":true');
    expect(stdout).toContain('"mouseCollapsed":true');
    expect(stdout).toContain('"enterExpanded":true');
    expect(stdout).toContain('"spaceCollapsed":true');
    expect(stdout).toContain('"finalAnswerAlwaysVisible":true');
    expect(stderr).toBe("");
    expect(stdout).toContain('"collapsedBlurredMuted":true');
    expect(stdout).toContain('"collapsedFocusedPrimary":true');
    expect(stdout).toContain('"blurRestoresMuted":true');
  });

  rendererIt("reaches and cycles completed reasoning disclosures from the session textarea", async () => {
    // Given: a full TUI session receiving two provider responses with separate reasoning.
    const fixture = path.resolve(__dirname, "fixtures", "tui-reasoning-disclosure-navigation.ts");

    // When: the configured Ctrl+R command is emitted from the real session textarea.
    const { stdout } = await execFileAsync("bun", [fixture], { cwd: path.resolve(__dirname, "..") });

    // Then: disclosure focus is reachable, cycles, and Escape restores the textarea.
    expect(stdout).toContain('"firstFocusedFromTextarea":true');
    expect(stdout).toContain('"newestFocused":true');
    expect(stdout).toContain('"repeatedCommandCycles":true');
    expect(stdout).toContain('"escapeRestoresTextarea":true');
    expect(stdout).toContain('"distinctDisclosureIds":true');
    expect(stdout).toContain('"mouseExpanded":true');
    expect(stdout).toContain('"textareaFocusPreservedAfterMouse":true');
    expect(stdout).toContain('"textareaTypedAfterMouse":true');
  });
});
