import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProgram } from "../src/cli";
import { ensureStrongCodeHome } from "../src/config/home";

function restoreEnvironment(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

describe("strongcode home --expand", () => {
  it("names preserved customized starter files without changing their bytes", async () => {
    // Given
    const homePath = await mkdtemp(path.join(tmpdir(), "strongcode-cli-home-expand-"));
    const previousHome = process.env.STRONGCODE_HOME;
    const originalLog = console.log;
    const output: string[] = [];
    process.env.STRONGCODE_HOME = homePath;

    try {
      await ensureStrongCodeHome();
      const customized = new Map<string, Buffer>();
      for (const fileName of ["mcp.json", "strongcode.config.yaml"] as const) {
        const filePath = path.join(homePath, fileName);
        const content = Buffer.concat([await readFile(filePath), Buffer.from(`\n# customized ${fileName}\n`)]);
        await writeFile(filePath, content);
        customized.set(fileName, content);
      }
      console.log = (message?: unknown) => output.push(String(message ?? ""));

      // When
      await createProgram().parseAsync(["node", "strongcode", "home", "--expand"]);

      // Then
      expect(output).toContain(
        "Created 0 directories and 0 files; upgraded 0 untouched starter files; preserved customized starter files: mcp.json, strongcode.config.yaml."
      );
      for (const [fileName, content] of customized) {
        await expect(readFile(path.join(homePath, fileName))).resolves.toEqual(content);
      }
    } finally {
      console.log = originalLog;
      restoreEnvironment("STRONGCODE_HOME", previousHome);
      await rm(homePath, { recursive: true, force: true });
    }
  });
});
