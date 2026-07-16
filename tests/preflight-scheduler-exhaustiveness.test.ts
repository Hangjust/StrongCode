import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MAPPERS = [
  "scheduler-direct.ts",
  "scheduler-children.ts",
  "scheduler-finalizer.ts",
  "scheduler-executor-support.ts"
] as const;

describe("Preflight scheduler closed-union mappings", () => {
  it("uses compile-time exhaustive fallbacks instead of silent coercion", async () => {
    for (const fileName of MAPPERS) {
      const source = await readFile(path.join(process.cwd(), "src", "agents", "preflight", fileName), "utf8");
      expect(source).not.toMatch(/default:\s*(?:return\s+)?["'](?:internal_error|provider_failed)["']/);
      expect(source).toMatch(/assertNever|unexpectedProtocolCode|childExecutionGap/);
    }
  });
});
