import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { StrongCodeError } from "../core/errors";
import { mkdir } from "node:fs/promises";
import { buildCodexProcessEnv } from "./delegated-environment";
import { prepareDelegatedSpawn, resolveDelegatedExecutable } from "./delegated-executable";
import path from "node:path";

export type CodexLoginMode = "browser" | "device-code";

export interface CodexModel {
  id: string;
  displayName: string;
  isDefault: boolean;
}

export interface CodexCommandOptions {
  command?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stdio?: "inherit" | "pipe";
}

export async function runCodexLogin(mode: CodexLoginMode, options: CodexCommandOptions = {}): Promise<void> {
  const args = mode === "device-code" ? ["login", "--device-auth"] : ["login"];
  const env = buildCodexProcessEnv(options.env);
  if (env.CODEX_HOME) await mkdir(env.CODEX_HOME, { recursive: true, mode: 0o700 });
  const cwd = options.cwd ?? (env.CODEX_HOME ? path.join(env.CODEX_HOME, "workspace") : process.cwd());
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const resolvedCommand = await resolveDelegatedExecutable("codex", { command: options.command, env, cwd });
  const launch = prepareDelegatedSpawn(resolvedCommand, args);
  await new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(launch.executable, launch.args, {
        cwd,
        env: launch.env,
        stdio: options.stdio ?? "inherit",
        windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
        shell: false
      });
    } catch (error) {
      reject(new StrongCodeError("CONFIG_ERROR", `Could not start the official Codex login flow: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    child.once("error", error => reject(new StrongCodeError("CONFIG_ERROR", `Could not start the official Codex login flow: ${error.message}`)));
    child.once("exit", code => {
      if (code === 0) resolve();
      else reject(new StrongCodeError("CONFIG_ERROR", `Official Codex login exited with code ${code ?? "unknown"}`));
    });
  });
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Query the supported Codex app-server model catalog without reading its auth cache. */
export async function listCodexModels(options: CodexCommandOptions = {}): Promise<CodexModel[]> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const env = buildCodexProcessEnv(options.env);
  if (env.CODEX_HOME) await mkdir(env.CODEX_HOME, { recursive: true, mode: 0o700 });
  const cwd = options.cwd ?? (env.CODEX_HOME ? path.join(env.CODEX_HOME, "workspace") : process.cwd());
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const resolvedCommand = await resolveDelegatedExecutable("codex", { command: options.command, env, cwd });
  const launch = prepareDelegatedSpawn(resolvedCommand, ["app-server", "--listen", "stdio://"]);
  const child = (() => {
    try {
      return spawn(launch.executable, launch.args, {
        cwd,
        env: launch.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
        shell: false
      });
    } catch (error) {
      throw new StrongCodeError("MODEL_ERROR", `Could not start the official Codex model catalog: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();
  const pending = new Map<number, PendingRequest>();
  let requestId = 0;
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => {
    if (stderr.length < 8_192) stderr += String(chunk).slice(0, 8_192 - stderr.length);
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", line => {
    let message: Record<string, unknown> | undefined;
    try {
      message = asRecord(JSON.parse(line));
    } catch {
      return;
    }
    if (typeof message?.id !== "number") return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    const error = asRecord(message.error);
    if (error) request.reject(new StrongCodeError("MODEL_ERROR", typeof error.message === "string" ? error.message : "Codex app-server request failed"));
    else request.resolve(message.result);
  });
  const request = (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, error => {
        if (!error) return;
        pending.delete(id);
        reject(error);
      });
    });
  };
  const timeout = setTimeout(() => {
    for (const item of pending.values()) item.reject(new StrongCodeError("MODEL_ERROR", "Timed out while querying the Codex model catalog"));
    pending.clear();
    child.kill();
  }, timeoutMs);
  try {
    await request("initialize", { clientInfo: { name: "strongcode", title: "StrongCode", version: "0.1.0" } });
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    const models: CodexModel[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const result = asRecord(await request("model/list", { limit: 200, includeHidden: false, ...(cursor ? { cursor } : {}) }));
      const data = Array.isArray(result?.data) ? result.data : [];
      for (const item of data) {
        const model = asRecord(item);
        const id = typeof model?.id === "string" ? model.id : typeof model?.model === "string" ? model.model : undefined;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        models.push({
          id,
          displayName: typeof model?.displayName === "string" ? model.displayName : id,
          isDefault: model?.isDefault === true
        });
      }
      const nextCursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }
    return models;
  } catch (error) {
    if (error instanceof StrongCodeError) throw error;
    const detail = stderr.trim() ? `: ${stderr.trim().split(/\r?\n/).at(-1)}` : "";
    throw new StrongCodeError("MODEL_ERROR", `Could not query the official Codex model catalog${detail}`);
  } finally {
    clearTimeout(timeout);
    lines.close();
    child.stdin.end();
    child.kill();
  }
}
