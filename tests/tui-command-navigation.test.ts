import { execFile, spawnSync } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const mouseIt = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0 ? it : it.skip;

describe("slash command navigation", () => {
  mouseIt("notifies slash overlay synchronization only for textarea edits", async () => {
    // Given: a prompt whose content callback synchronizes the slash-command overlay.
    const fixture = path.resolve(__dirname, "fixtures", "prompt-content-change.ts");

    // When: its deferred mount layout, one real edit, and a resize layout complete.
    const { stdout } = await execFileAsync("bun", [fixture], { cwd: path.resolve(__dirname, "..") });

    // Then: only the real textarea edit invokes the callback.
    expect(stdout.trim()).toBe('{"mount":0,"afterEdit":1,"afterResize":1}');
  });

  mouseIt("makes slash rows hoverable and clickable with the mouse", async () => {
    const fixture = path.resolve(__dirname, "fixtures", "slash-mouse.ts");
    const { stdout } = await execFileAsync("bun", [fixture], { cwd: path.resolve(__dirname, "..") });
    const result = JSON.parse(stdout) as { connectIndex: number; focused: number[]; selected: number[]; providerSelected: number[] };

    expect(result.focused).toContain(result.connectIndex);
    expect(result.selected).toEqual([result.connectIndex]);
    expect(result.providerSelected).toHaveLength(1);
  });

  mouseIt("keeps the active session mounted across provider popup refreshes", async () => {
    const fixture = path.resolve(__dirname, "fixtures", "provider-popup-lifecycle.ts");
    const { stdout } = await execFileAsync("bun", [fixture], { cwd: path.resolve(__dirname, "..") });
    const result = JSON.parse(stdout) as Record<string, boolean>;

    expect(result).toEqual({
      connectOpened: true,
      onePopupPair: true,
      scrollSame: true,
      transcriptSurvived: true,
      pendingSurvived: true,
      focusRestored: true,
      popupRemoved: true
    });
  });
});
