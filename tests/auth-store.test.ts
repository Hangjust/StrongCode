import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProviderAuthStore } from "../src/models/auth-store";

describe("provider auth store", () => {
  it("rejects symlinked auth files before writing secrets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-auth-store-"));
    const target = path.join(root, "target.json");
    await writeFile(target, "{}", "utf8");
    const store = new ProviderAuthStore(root);

    try {
      await symlink(target, store.filePath);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error.code === "EPERM" || error.code === "ENOTSUP")) return;
      throw error;
    }

    await expect(store.set("custom", { type: "api", key: "secret" })).rejects.toThrow("symlinked auth file");
  });

  it("round-trips OAuth auth with account id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-auth-store-oauth-"));
    const store = new ProviderAuthStore(root);

    await store.set("openai", {
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: 1234,
      accountId: "account-123",
      metadata: { issuer: "https://auth.openai.com" }
    });

    await expect(store.get("openai")).resolves.toEqual({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: 1234,
      accountId: "account-123",
      metadata: { issuer: "https://auth.openai.com" }
    });
  });
});
