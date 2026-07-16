import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntimeAuthReader, ProviderAuthStore, resolveRuntimeAuthDataDir } from "../src/models/auth-store";

describe("provider auth store", () => {
  it("keeps project credential vaults outside repositories and isolated by config path", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "strongcode-auth-vault-home-"));
    const project = await mkdtemp(path.join(tmpdir(), "strongcode-auth-vault-project-"));
    const first = resolveRuntimeAuthDataDir(path.join(project, "strongcode.config.yaml"), path.join(project, ".strongcode"), home);
    const second = resolveRuntimeAuthDataDir(path.join(project, "other.config.yaml"), path.join(project, ".strongcode"), home);

    expect(first.startsWith(path.join(home, "project-auth"))).toBe(true);
    expect(first.startsWith(project)).toBe(false);
    expect(second).not.toBe(first);
    expect(resolveRuntimeAuthDataDir(path.join(home, "strongcode.config.yaml"), home, home)).toBe(home);
  });

  it("treats a missing credential directory as an empty store", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-auth-store-missing-"));
    await expect(new ProviderAuthStore(path.join(root, "not-created")).all()).resolves.toEqual({});
  });

  it("rejects non-directory and symlinked credential store paths before reading", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-auth-store-directory-"));
    const filePath = path.join(root, "credentials-file");
    await writeFile(filePath, "not a directory", "utf8");
    await expect(new ProviderAuthStore(filePath).all()).rejects.toThrow("non-directory credential store");

    const target = path.join(root, "credentials-target");
    const link = path.join(root, "credentials-link");
    await mkdir(target);
    try {
      await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error.code === "EPERM" || error.code === "ENOTSUP")) return;
      throw error;
    }
    await expect(new ProviderAuthStore(link).all()).rejects.toThrow("non-directory credential store");
  });

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

  it("round-trips legacy OAuth records for explicit migration errors", async () => {
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

  it("serializes concurrent provider updates without losing credentials", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-auth-store-concurrent-"));
    const store = new ProviderAuthStore(root);

    await Promise.all([
      store.set("openai", { type: "api", key: "openai-key" }),
      store.set("anthropic", { type: "api", key: "anthropic-key" }),
      store.set("deepseek", { type: "api", key: "deepseek-key" })
    ]);

    expect(Object.keys(await store.all()).sort()).toEqual(["anthropic", "deepseek", "openai"]);
  });

  it("refuses writes while environment content shadows the file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-auth-store-shadowed-"));
    const store = new ProviderAuthStore(root);
    const previous = process.env.STRONGCODE_AUTH_CONTENT;
    process.env.STRONGCODE_AUTH_CONTENT = JSON.stringify({ openai: { type: "api", key: "environment-key" } });
    try {
      await expect(store.set("openai", { type: "api", key: "file-key" })).rejects.toThrow("writes are disabled");
    } finally {
      if (previous === undefined) delete process.env.STRONGCODE_AUTH_CONTENT;
      else process.env.STRONGCODE_AUTH_CONTENT = previous;
    }
  });

  it("does not inherit global keys into repository-local configs by default", async () => {
    const globalRoot = await mkdtemp(path.join(tmpdir(), "strongcode-auth-global-"));
    const projectRoot = await mkdtemp(path.join(tmpdir(), "strongcode-auth-project-"));
    await new ProviderAuthStore(globalRoot).set("openai", { type: "api", key: "global-key" });

    await expect(createRuntimeAuthReader(projectRoot, globalRoot).get("openai")).resolves.toBeUndefined();
    await expect(createRuntimeAuthReader(projectRoot, globalRoot, { allowGlobalFallback: true }).get("openai")).resolves.toMatchObject({ type: "api", key: "global-key" });
  });

  it("does not expose process-injected auth content to an untrusted runtime", async () => {
    const globalRoot = await mkdtemp(path.join(tmpdir(), "strongcode-auth-env-global-"));
    const projectRoot = await mkdtemp(path.join(tmpdir(), "strongcode-auth-env-project-"));
    const previous = process.env.STRONGCODE_AUTH_CONTENT;
    process.env.STRONGCODE_AUTH_CONTENT = JSON.stringify({ openai: { type: "api", key: "environment-key" } });
    try {
      await expect(createRuntimeAuthReader(projectRoot, globalRoot).get("openai")).resolves.toBeUndefined();
      await expect(createRuntimeAuthReader(globalRoot, globalRoot).get("openai")).resolves.toBeUndefined();
      await expect(createRuntimeAuthReader(globalRoot, globalRoot, { allowEnvironmentContent: true }).get("openai"))
        .resolves.toMatchObject({ type: "api", key: "environment-key" });
    } finally {
      if (previous === undefined) delete process.env.STRONGCODE_AUTH_CONTENT;
      else process.env.STRONGCODE_AUTH_CONTENT = previous;
    }
  });

  it("can write a project auth file even when ignored process auth content is present", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "strongcode-auth-env-write-"));
    const previous = process.env.STRONGCODE_AUTH_CONTENT;
    process.env.STRONGCODE_AUTH_CONTENT = JSON.stringify({ openai: { type: "api", key: "environment-key" } });
    try {
      const store = new ProviderAuthStore(projectRoot, { allowEnvironmentContent: false });
      await store.set("openai", { type: "api", key: "project-key" });
      await expect(store.get("openai")).resolves.toMatchObject({ type: "api", key: "project-key" });
    } finally {
      if (previous === undefined) delete process.env.STRONGCODE_AUTH_CONTENT;
      else process.env.STRONGCODE_AUTH_CONTENT = previous;
    }
  });
});
