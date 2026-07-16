import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureStrongCodeHome } from "../src/config/home";

const CALLERS_PER_ROUND = 12;
const STRESS_ROUNDS = 8;

describe("StrongCode home concurrent publication", () => {
  it("publishes every starter without conflicts across repeated twelve-caller rounds", async () => {
    const rounds = await Promise.all(Array.from({ length: STRESS_ROUNDS }, async (_, round) => {
      const homePath = path.join(await mkdtemp(path.join(tmpdir(), `strongcode-home-stress-${round}-`)), "home");
      const results = await Promise.all(Array.from(
        { length: CALLERS_PER_ROUND },
        () => ensureStrongCodeHome({ homePath })
      ));
      return results.flatMap(result => result.conflicts.map(conflict => ({ round, ...conflict })));
    }));

    expect(rounds.flat()).toEqual([]);
  }, 60_000);

  it("preserves an existing customized artifact under concurrent bootstrap", async () => {
    const homePath = await mkdtemp(path.join(tmpdir(), "strongcode-home-stress-custom-"));
    const readmePath = path.join(homePath, "README.md");
    const customized = "# Exact customized bytes\n";
    await writeFile(readmePath, customized, "utf8");

    const results = await Promise.all(Array.from(
      { length: CALLERS_PER_ROUND },
      () => ensureStrongCodeHome({ homePath })
    ));

    expect(results.flatMap(result => result.conflicts)).toEqual([]);
    expect(await readFile(readmePath, "utf8")).toBe(customized);
    expect((await readdir(homePath)).some(name => name.endsWith(".tmp"))).toBe(false);
  }, 30_000);
});
