import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

async function runPython(args: readonly string[]): Promise<{ readonly code: number | null; readonly output: string }> {
  const command = process.platform === "win32" ? "py" : "python3.11";
  const prefix = process.platform === "win32" ? ["-3.11"] : [];
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...prefix, "-B", "-I", ...args], {
      cwd: process.cwd(),
      shell: false,
      windowsHide: true
    });
    let output = "";
    const timeout = setTimeout(() => child.kill(), 20_000);
    child.stdout.on("data", chunk => { output += String(chunk); });
    child.stderr.on("data", chunk => { output += String(chunk); });
    child.once("error", error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", code => {
      clearTimeout(timeout);
      resolve({ code, output });
    });
  });
}

describe("bundled Blender Python assets", () => {
  it("pass their CPython 3.11 unittest suite", async () => {
    const result = await runPython([
      "-m", "unittest", "discover", "-s", path.join("tests", "blender-python"),
      "-p", "test_*.py", "-v"
    ]);

    expect(result.code, result.output).toBe(0);
  });

  it("emits the setup-compatible exact wrapper self-test", async () => {
    const result = await runPython([
      path.join("assets", "blender-mcp", "runtime-wrapper", "strongcode-blender-wrapper.py"),
      "--self-test"
    ]);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toBe(
      '__STRONGCODE_BLENDER_TOOLS_V1__["get_scene_info","get_object_info",' +
      '"get_viewport_screenshot","execute_blender_code"]' +
      (process.platform === "win32" ? "\r\n" : "\n")
    );
  });

  it("keeps installer wrapper assets in a focused directory", async () => {
    const wrapperAssetsPath = path.join("assets", "blender-mcp", "runtime-wrapper");

    expect((await readdir(wrapperAssetsPath)).sort()).toEqual([
      "strongcode-blender-wrapper.py",
      "wrapper"
    ]);
    expect(await readdir(path.join(wrapperAssetsPath, "wrapper"))).toContain("server.py");
  });
});
