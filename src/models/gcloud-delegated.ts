import { spawn } from "node:child_process";
import { StrongCodeError } from "../core/errors";
import { buildGcloudProcessEnv } from "./delegated-environment";
import { prepareDelegatedSpawn, resolveDelegatedExecutable } from "./delegated-executable";

export type GoogleAdcLoginMode = "browser" | "headless";

export interface GcloudCommandOptions {
  command?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  stdio?: "inherit" | "pipe";
}

export async function runGoogleAdcLogin(mode: GoogleAdcLoginMode, options: GcloudCommandOptions = {}): Promise<void> {
  const args = ["auth", "application-default", "login"];
  if (mode === "headless") args.push("--no-launch-browser");
  const env = buildGcloudProcessEnv(options.env);
  const cwd = options.cwd ?? process.cwd();
  const resolvedCommand = await resolveDelegatedExecutable("gcloud", { command: options.command, env, cwd });
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
      reject(new StrongCodeError("CONFIG_ERROR", `Could not start Google Application Default Credentials login: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    child.once("error", error => reject(new StrongCodeError("CONFIG_ERROR", `Could not start Google Application Default Credentials login: ${error.message}`)));
    child.once("exit", code => code === 0 ? resolve() : reject(new StrongCodeError("CONFIG_ERROR", `Google ADC login exited with code ${code ?? "unknown"}`)));
  });
}

export async function getGoogleAdcAccessToken(options: GcloudCommandOptions = {}): Promise<string> {
  const env = buildGcloudProcessEnv(options.env);
  const cwd = options.cwd ?? process.cwd();
  const resolvedCommand = await resolveDelegatedExecutable("gcloud", { command: options.command, env, cwd });
  const launch = prepareDelegatedSpawn(resolvedCommand, ["auth", "application-default", "print-access-token"]);
  const child = (() => {
    try {
      return spawn(launch.executable, launch.args, {
        cwd,
        env: launch.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
        shell: false
      });
    } catch (error) {
      throw new StrongCodeError("MODEL_ERROR", `Could not start gcloud for Google credentials: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();
  return new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new StrongCodeError("MODEL_ERROR", "Timed out while refreshing Google Application Default Credentials"));
    }, options.timeoutMs ?? 15_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      if (stdout.length < 16_384) stdout += String(chunk).slice(0, 16_384 - stdout.length);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => {
      if (stderr.length < 8_192) stderr += String(chunk).slice(0, 8_192 - stderr.length);
    });
    child.once("error", error => {
      clearTimeout(timeout);
      reject(new StrongCodeError("MODEL_ERROR", `Could not start gcloud for Google credentials: ${error.message}`));
    });
    child.once("exit", code => {
      clearTimeout(timeout);
      const token = stdout.trim();
      if (code === 0 && token) resolve(token);
      else reject(new StrongCodeError("MODEL_ERROR", `Google credential refresh failed${stderr.trim() ? `: ${stderr.trim().split(/\r?\n/).at(-1)}` : ""}`));
    });
  });
}
