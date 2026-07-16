import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(__dirname, "..");
const designContract = () => {
  const contract = readFileSync(path.join(projectRoot, "DESIGN.md"), "utf8");
  if (process.env.STRONGCODE_DESIGN_CONTRACT_FIXTURE === "without-bounded-rows") {
    return contract.replace(/, bounded to\s+the rail or scrollable detail/i, "");
  }
  if (process.env.STRONGCODE_DESIGN_CONTRACT_FIXTURE !== "task-6-required-failures") return contract;
  return contract
    .replace(/At 109 columns and below, the narrow fallback hides the rail[^\n]*/i, "")
    .replace(/Escape focus restoration returns to the prior composer or control\./i, "")
    .replace(/Dynamic display text is terminal control sanitization at render time only;[^\n]*/i, "")
    .replace(/In `failed-open` or cancelled states,[^\n]*/i, "");
};
const tuiSource = readFileSync(path.join(projectRoot, "src", "tui", "app.ts"), "utf8");
const chromeSource = readFileSync(path.join(projectRoot, "src", "tui", "ui", "session-chrome.ts"), "utf8");
const sourceOrderedRows = /source-ordered\s+requested-item\/decomposition rows/i;
const requestedItemsPlacement = /requested items beneath `Summary ->`/i;
const boundedRowRendering = /bounded to\s+the rail or scrollable detail/i;
const requiredSections = [
  "## 1. Atmosphere & Identity",
  "## 2. Color",
  "## 3. Typography",
  "## 4. Spacing & Layout",
  "## 5. Components",
  "## 6. Motion & Interaction",
  "## 7. Depth & Surface",
  "## 8. Accessibility Constraints & Accepted Debt"
] as const;

describe("terminal design contract", () => {
  it("documents the current dark terminal palette and chrome geometry", () => {
    // Given: the OpenTUI source remains the current visual implementation.
    expect(tuiSource).toMatch(/background: "#0c0a08"/);
    expect(tuiSource).toMatch(/primary: "#ffb870"/);
    expect(tuiSource).toMatch(/width: 32/);
    expect(tuiSource).toMatch(/renderer\.width >= 110/);

    // When: the root design contract is read.
    const contract = designContract();

    // Then: it names the existing tokens and dimensional rules rather than a new visual system.
    for (const section of requiredSections) expect(contract).toContain(section);
    expect(contract).toMatch(/#0c0a08/);
    expect(contract).toMatch(/#ffb870/);
    expect(contract).toMatch(/32-column rail/);
    expect(contract).toMatch(/110 columns/);
    expect(contract).toMatch(/header.*3 rows/i);
  });

  it("documents terminal-native hierarchy, bounded layout, and summary access", () => {
    // Given: the current source exposes the session rail, responsive header, and F2 summary path.
    expect(tuiSource).toContain("SESSION SUMMARY");
    expect(tuiSource).toMatch(/inputKey === "f2"/);
    expect(tuiSource).toMatch(/onMouseDown/);

    // When: the root design contract is read.
    const contract = designContract();

    // Then: it preserves terminal-native hierarchy and responsive fallback behavior.
    expect(contract).toMatch(/## 3\. Typography/);
    expect(contract).toMatch(/monospace/i);
    expect(contract).toMatch(/ASCII/i);
    expect(contract).toMatch(/bounded wrapping/i);
    expect(contract).toMatch(/F2 summary overlay/i);
    expect(contract).toMatch(/narrow fallback/i);
  });

  it("requires keyboard, mouse, focus, and terminal-safety constraints", () => {
    // Given: the live TUI focuses overlay content and restores the previous input target.
    expect(tuiSource).toMatch(/focusBeforeSummary/);
    expect(tuiSource).toMatch(/renderer\.focusRenderable\(target\)/);
    expect(chromeSource).toMatch(/sanitizeChromeText/);

    // When: the root design contract is read.
    const contract = designContract();

    // Then: every documented interaction path remains reachable and safe for terminal rendering.
    expect(contract).toMatch(/full keyboard reachability/i);
    expect(contract).toMatch(/visible selected\/focus state/i);
    expect(contract).toMatch(/click parity/i);
    expect(contract).toMatch(/Escape focus restoration/i);
    expect(contract).toMatch(/terminal control sanitization/i);
    expect(contract).toMatch(/prompt-injection/i);
  });

  it("maps live Help and Summary overlay borders to their source roles", () => {
    // Given: the current overlay implementations own different border colors.
    expect(tuiSource).toMatch(/function addHelpOverlay[\s\S]*?borderColor: COLORS\.primary/);
    expect(tuiSource).toMatch(/function addSummaryOverlay[\s\S]*?borderColor: COLORS\.secondary/);

    // When: the root design contract is read.
    const contract = designContract();

    // Then: it assigns each current border color without an ambiguous shared order.
    expect(contract).toMatch(/Help overlay uses the primary border/i);
    expect(contract).toMatch(/Summary overlay uses the secondary\s+border/i);
  });

  it("requires Summary context percentage to use reported current context and its snapshotted window", () => {
    // Given: Todo 9 will project provider-reported context without summing child contexts.
    const contract = designContract();

    // When: the context percentage requirement is read.
    // Then: its numerator and denominator are explicit.
    expect(contract).toMatch(/context percentage\s+uses reported current-context\/input tokens divided by the\s+snapshotted configured window/i);
    expect(contract).toMatch(/never sum child contexts/i);
  });

  it("requires Summary spend to distinguish reported values from explicitly labeled estimates", () => {
    // Given: unknown monetary data must not become a fabricated number.
    const contract = designContract();

    // When: the spend requirement is read.
    // Then: its provenance is visible to the user.
    expect(contract).toMatch(/reported spend\s+or an explicitly labeled estimate/i);
  });

  it("requires source order, Summary placement, and bounded rendering for requested-item rows", () => {
    // Given: the first prompt owns the approved Summary decomposition.
    const contract = designContract();

    // When: the requested-item requirement is read.
    // Then: removing any one of these distinct rendering constraints fails the contract.
    expect(contract).toMatch(sourceOrderedRows);
    expect(contract).toMatch(requestedItemsPlacement);
    expect(contract).toMatch(boundedRowRendering);
  });

  it("locks the approved future Summary hierarchy without claiming it is rendered today", () => {
    // Given: Todo 9 will project immutable first-request Summary data into the existing chrome.
    const contract = designContract();

    // When: the Summary hierarchy is specified.
    const titleIndex = contract.search(/generated title and general summary\s+first/i);
    const requestedItemsIndex = contract.indexOf("requested items beneath `Summary ->`");

    // Then: the hierarchy, exact-prompt interaction, and failure mode are explicit.
    expect(titleIndex).toBeGreaterThanOrEqual(0);
    expect(requestedItemsIndex).toBeGreaterThan(titleIndex);
    expect(contract).toMatch(/clicking Summary\s+or pressing F2 opens the exact first\s+non-empty prompt/i);
    expect(contract).toMatch(/failed-open/i);
    expect(contract).toMatch(/Todo 9/i);
  });

  it.each([
    ["narrow fallback", /narrow fallback/i],
    ["Escape focus restoration", /Escape focus restoration/i],
    ["terminal control sanitization", /terminal control sanitization/i],
    ["failed-open", /failed-open/i]
  ] as const)("requires the %s contract clause", (_name, clause) => {
    expect(designContract()).toMatch(clause);
  });
});
