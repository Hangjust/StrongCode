import { execFile, spawnSync } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rendererIt = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0 ? it : it.skip;

async function runLayoutFixture(mode: string): Promise<Record<string, unknown>> {
  const fixture = path.resolve(__dirname, "fixtures", "question-surface.ts");
  const { stdout } = await execFileAsync("bun", [fixture, mode], { cwd: path.resolve(__dirname, "..") });
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("question surface layout", () => {
  rendererIt("keeps all compact actions and the keyboard footer visible at 60 columns", async () => {
    // Given: a two-question compact surface resized to 60 columns.
    const result = await runLayoutFixture("layout");

    // When: the real renderer lays out actions and footer.
    // Then: labels share one visible row with nonoverlapping bounds and a compact footer.
    expect(result.actionLine).toContain("F3 Simplify");
    expect(result.actionLine).toContain("Next");
    expect(result.actionLine).toContain("Submit");
    expect(result.actionLine).toContain("Cancel");
    expect(result.actionsRow).toMatchObject({ height: 1 });
    expect(result.actionsShareRow).toBe(true);
    expect(result.actionsNonOverlapping).toBe(true);
    expect(result.footer).toMatchObject({
      text: "U/D move  L/R tabs  Tab focus  Enter/Spc act  Esc back",
      bounds: { height: 1 }
    });
  });

  rendererIt("renders warning IDs, text, and warning tone", async () => {
    // Given: simplification and validation failures driven through the real surface.
    const result = await runLayoutFixture("warning");

    // When: each failure reaches the view.
    // Then: stable warning nodes render exact text in the warning color.
    expect(result.simplificationError).toEqual({ text: "DeepSeek is unavailable", warningTone: true });
    expect(result.validationError).toEqual({ text: "Custom answers must be one line.", warningTone: true });
  });

  rendererIt("allocates CJK and emoji tabs by cell geometry without clipping Confirm", async () => {
    // Given: CJK headers and emoji option labels at 80 columns.
    const result = await runLayoutFixture("wide");

    // When: public geometry and captured span widths are inspected.
    // Then: tab cells, Confirm, and option markers remain aligned without replacement glyphs.
    expect(result.cjkTabSpanWidth).toBeGreaterThan(0);
    expect(result.cjkTabFits).toBe(true);
    expect(result.tabsNonOverlapping).toBe(true);
    expect(result.confirmFits).toBe(true);
    expect(result.confirmVisible).toBe(true);
    expect(result.optionMarkersAligned).toBe(true);
    expect(result.hasReplacementGlyph).toBe(false);
  });
});
