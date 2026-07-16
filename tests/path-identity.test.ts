import type { BigIntStats, PathLike } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  rename,
  symlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PathIdentityError,
  inspectPath,
  readVerifiedRegularFile,
  revalidatePath,
  verifyOpenFile
} from "../src/core/path-identity";
import { tempWorkspace } from "./helpers";
type IdentityFault = "grow-during-read" | "none" | "post-read-change" | "unavailable-dev" | "unavailable-ino";
const lstatControl = vi.hoisted((): {
  fault: IdentityFault;
  targetPath: string;
  targetCalls: number;
  unboundedReads: number;
} => ({ fault: "none", targetPath: "", targetCalls: 0, unboundedReads: 0 }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (target: PathLike, options?: { readonly bigint?: boolean }) => {
      const stats = await actual.lstat(target, options);
      if (options?.bigint !== true || typeof stats.dev !== "bigint") return stats;
      if (path.resolve(String(target)) !== lstatControl.targetPath) return stats;
      lstatControl.targetCalls += 1;
      const changed = lstatControl.fault === "post-read-change" && lstatControl.targetCalls >= 3;
      const unavailableDev = lstatControl.fault === "unavailable-dev";
      const unavailableIno = lstatControl.fault === "unavailable-ino";
      if (!unavailableDev && !unavailableIno && !changed) return stats;
      return new Proxy(stats, {
        get(value: BigIntStats, property: string | symbol, receiver: object) {
          if ((property === "dev" && unavailableDev) || (property === "ino" && unavailableIno)) return 0n;
          if ((property === "dev" || property === "ino") && changed) return Reflect.get(value, property, receiver) + 1n;
          return Reflect.get(value, property, receiver);
        }
      });
    },
    open: async (target: PathLike, flags: string) => {
      const handle = await actual.open(target, flags);
      if (lstatControl.fault !== "grow-during-read"
        || path.resolve(String(target)) !== lstatControl.targetPath) return handle;
      let grew = false;
      const grow = async (): Promise<void> => {
        if (grew) return;
        grew = true;
        await actual.appendFile(target, "overflow", "utf8");
      };
      return {
        close: () => handle.close(),
        stat: (options: { readonly bigint: true }) => handle.stat(options),
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          await grow();
          return await handle.read(buffer, offset, length, position);
        },
        readFile: async () => {
          lstatControl.unboundedReads += 1;
          await grow();
          return await handle.readFile();
        }
      };
    }
  };
});
async function regularFileFixture(): Promise<{
  readonly root: string;
  readonly directory: string;
  readonly filePath: string;
}> {
  const workspace = await tempWorkspace();
  const directory = path.join(workspace.root, "trusted");
  const filePath = path.join(directory, "config.json");
  await mkdir(directory);
  await writeFile(filePath, "trusted bytes", "utf8");
  return { root: workspace.root, directory, filePath };
}
beforeEach(() => {
  lstatControl.fault = "none";
  lstatControl.targetPath = "";
  lstatControl.targetCalls = 0;
  lstatControl.unboundedReads = 0;
});
describe("component-wise path identity", () => {
  it("receipts and reads a safe regular file from the filesystem root", async () => {
    // Given
    const fixture = await regularFileFixture();
    // When
    const receipt = await inspectPath(fixture.filePath, { finalKind: "regular-file" });
    const bytes = await readVerifiedRegularFile(fixture.filePath);
    // Then
    expect(receipt.components[0]?.path).toBe(path.parse(fixture.filePath).root);
    expect(receipt.existingPrefix).toBe(fixture.filePath);
    expect(receipt.missingSuffix).toEqual([]);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.components)).toBe(true);
    expect(bytes.toString("utf8")).toBe("trusted bytes");
  });

  it("records the verified existing prefix and missing suffix", async () => {
    // Given
    const fixture = await regularFileFixture();
    const missing = path.join(fixture.directory, "new", "settings.json");
    // When
    const receipt = await inspectPath(missing, { allowMissing: true, finalKind: "regular-file" });
    // Then
    expect(receipt.existingPrefix).toBe(fixture.directory);
    expect(receipt.missingSuffix).toEqual(["new", "settings.json"]);
    await expect(revalidatePath(receipt)).resolves.toBeUndefined();
  });

  it("rejects a Windows junction or POSIX symlink in an ancestor", async () => {
    // Given
    const fixture = await regularFileFixture();
    const external = path.join(fixture.root, "external");
    const linked = path.join(fixture.root, "linked");
    await mkdir(external);
    await writeFile(path.join(external, "payload.txt"), "external", "utf8");
    await symlink(external, linked, process.platform === "win32" ? "junction" : "dir");
    // When
    const inspected = inspectPath(path.join(linked, "payload.txt"), { finalKind: "regular-file" });
    // Then
    await expect(inspected).rejects.toMatchObject({ reason: "linked-component", componentPath: linked });
  });

  it("rejects a linked final directory", async () => {
    // Given
    const fixture = await regularFileFixture();
    const external = path.join(fixture.root, "external-final");
    const linked = path.join(fixture.root, "linked-final");
    await mkdir(external);
    await symlink(external, linked, process.platform === "win32" ? "junction" : "dir");
    // When
    const inspected = inspectPath(linked, { finalKind: "directory" });
    // Then
    await expect(inspected).rejects.toBeInstanceOf(PathIdentityError);
    await expect(inspected).rejects.toMatchObject({ reason: "linked-component", componentPath: linked });
  });

  it("rejects a non-directory ancestor", async () => {
    // Given
    const fixture = await regularFileFixture();
    // When
    const inspected = inspectPath(path.join(fixture.filePath, "child"), { allowMissing: true });
    // Then
    await expect(inspected).rejects.toMatchObject({ reason: "non-directory-ancestor" });
  });

  it("optionally rejects a hardlinked regular file with nlink two", async () => {
    // Given
    const fixture = await regularFileFixture();
    const hardlink = path.join(fixture.directory, "hardlink.json");
    await link(fixture.filePath, hardlink);
    expect((await lstat(hardlink, { bigint: true })).nlink).toBe(2n);
    // When
    const inspected = inspectPath(hardlink, { finalKind: "regular-file", requireSingleLink: true });
    // Then
    await expect(inspected).rejects.toMatchObject({ reason: "multiple-links", componentPath: hardlink });
  });

  it("rejects an opened handle after its pathname is replaced", async () => {
    // Given
    const fixture = await regularFileFixture();
    const receipt = await inspectPath(fixture.filePath, { finalKind: "regular-file" });
    const handle = await open(fixture.filePath, "r");
    try {
      await rename(fixture.filePath, path.join(fixture.directory, "original.json"));
      await writeFile(fixture.filePath, "replacement", "utf8");

      // When / Then
      await expect(verifyOpenFile(handle, receipt)).rejects.toMatchObject({ reason: "identity-changed" });
    } finally {
      await handle.close();
    }
  });

  it("rejects a replaced path component", async () => {
    // Given
    const fixture = await regularFileFixture();
    const receipt = await inspectPath(fixture.filePath, { finalKind: "regular-file" });
    const displaced = path.join(fixture.root, "trusted-original");
    await rename(fixture.directory, displaced);
    await mkdir(fixture.directory);
    await writeFile(fixture.filePath, "trusted bytes", "utf8");

    // When
    const revalidated = revalidatePath(receipt);

    // Then
    await expect(revalidated).rejects.toMatchObject({ reason: "identity-changed", componentPath: fixture.directory });
  });

  it.each(["dev", "ino"] as const)("fails closed when %s identity is unavailable", async field => {
    // Given
    const fixture = await regularFileFixture();
    lstatControl.fault = field === "dev" ? "unavailable-dev" : "unavailable-ino";
    lstatControl.targetPath = fixture.filePath;

    // When
    const inspected = inspectPath(fixture.filePath, { finalKind: "regular-file" });

    // Then
    await expect(inspected).rejects.toMatchObject({ reason: "identity-unavailable" });
  });

  it("does not use an unbounded read when a size-limited file grows", async () => {
    const fixture = await regularFileFixture();
    lstatControl.fault = "grow-during-read";
    lstatControl.targetPath = fixture.filePath;

    await expect(readVerifiedRegularFile(fixture.filePath, { maxBytes: 13n }))
      .rejects.toMatchObject({ reason: "identity-changed" });
    expect(lstatControl.unboundedReads).toBe(0);
  });

  it("discards bytes when identity changes after the handle read", async () => {
    // Given
    const fixture = await regularFileFixture();
    lstatControl.fault = "post-read-change";
    lstatControl.targetPath = fixture.filePath;

    // When
    const read = readVerifiedRegularFile(fixture.filePath);

    // Then
    await expect(read).rejects.toMatchObject({ reason: "identity-changed" });
    expect(lstatControl.targetCalls).toBeGreaterThanOrEqual(3);
  });
});
