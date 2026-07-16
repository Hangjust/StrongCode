import { spawn } from "node:child_process";
import { StrongCodeError } from "../core/errors";
import { modelRequestItems, type ModelProvider, type ModelRequest, type ModelResponse } from "./provider";
import path from "node:path";
import { resolveStrongCodeHome } from "../config/paths";
import { buildCodexProcessEnv } from "./delegated-environment";
import { prepareDelegatedSpawn, resolveDelegatedExecutable } from "./delegated-executable";
import { mkdir } from "node:fs/promises";
import { parseCodexCliReportedUsage } from "./native-provider-usage";
import { parseJson } from "./native-provider-utils";
import { parseExternalRecord } from "./provider-usage";

export interface CodexCliProviderOptions {
  providerId: string;
  modelId: string;
  modelConfig: { model?: string };
  command?: string;
  cwd?: string;
  timeoutMs?: number;
}

function responsePrompt(request: ModelRequest): string {
  const items = modelRequestItems(request);
  const transcript = items
    .filter(item => item.type === "text" && item.content.trim().length > 0)
    .map(item => item.type === "text" ? `${item.role}: ${item.content}` : "")
    .join("\n\n");
  const prompt = request.prompt.trim();
  const promptAlreadyPresent = items.some(item =>
    item.type === "text" && item.role === "user" && item.content.trim() === prompt
  );
  const content = transcript && prompt.length > 0 && !promptAlreadyPresent
    ? `${transcript}\n\nuser: ${prompt}`
    : transcript || request.prompt;
  return request.systemPrompt ? `System instructions:\n${request.systemPrompt}\n\nConversation:\n${content}` : content;
}

function agentMessage(event: Readonly<Record<string, unknown>>): string | undefined {
  const item = parseExternalRecord(event.item);
  if (event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") return item.text;
  if (event.type === "agent_message" && typeof event.message === "string") return event.message;
  return undefined;
}

function completedReasoning(event: Readonly<Record<string, unknown>>): string | undefined {
  const item = parseExternalRecord(event.item);
  if (
    event.type !== "item.completed" ||
    item?.type !== "reasoning" ||
    typeof item.text !== "string"
  ) {
    return undefined;
  }

  const text = item.text.trim();
  return text.length > 0 ? text : undefined;
}

/** Supported ChatGPT transport: delegate inference to the installed official Codex CLI. */
export class CodexCliModelProvider implements ModelProvider {
  readonly name: string;

  constructor(private readonly options: CodexCliProviderOptions) {
    this.name = options.providerId;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const codexHome = path.join(resolveStrongCodeHome(), "credentials", "codex");
    const cwd = this.options.cwd ?? path.join(codexHome, "workspace");
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const env = buildCodexProcessEnv({ CODEX_HOME: codexHome });
    const resolvedCommand = await resolveDelegatedExecutable("codex", { command: this.options.command, env, cwd });
    const model = this.options.modelConfig.model ?? this.options.modelId;
    const args = ["exec", "-", "--json", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only"];
    if (model && model !== "default" && model !== "codex-default") {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(model)) {
        throw new StrongCodeError("CONFIG_ERROR", "Codex model ID contains unsupported characters");
      }
      args.push("--model", model);
    }
    const timeoutMs = this.options.timeoutMs ?? 10 * 60_000;
    const launch = prepareDelegatedSpawn(resolvedCommand, args);
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
        throw new StrongCodeError("MODEL_ERROR", `Could not start the official Codex CLI: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();

    return new Promise<ModelResponse>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (error?: Error, response?: ModelResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(response ?? { message: "", toolCalls: [] });
      };
      const timeout = setTimeout(() => {
        child.kill();
        finish(new StrongCodeError("MODEL_ERROR", "Official Codex execution timed out"));
      }, timeoutMs);
      child.once("error", error => finish(new StrongCodeError("MODEL_ERROR", `Could not start the official Codex CLI: ${error.message}`)));
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => {
        stdout += String(chunk);
        if (stdout.length > 10 * 1024 * 1024) {
          child.kill();
          finish(new StrongCodeError("MODEL_ERROR", "Official Codex output exceeded the 10 MB safety limit"));
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", chunk => {
        if (stderr.length < 32_768) stderr += String(chunk).slice(0, 32_768 - stderr.length);
      });
        child.once("exit", code => {
        if (settled) return;
        if (code !== 0) {
          const detail = stderr.trim().split(/\r?\n/).at(-1) || "Codex execution failed";
          finish(new StrongCodeError("MODEL_ERROR", `Official Codex CLI exited with code ${code ?? "unknown"}: ${detail}`));
          return;
        }
        let message: string | undefined;
        const reasoning: string[] = [];
        let reportedUsage: ReturnType<typeof parseCodexCliReportedUsage>;
        for (const line of stdout.split(/\r?\n/)) {
          const event = parseExternalRecord(parseJson(line));
          if (!event) continue;
          message = agentMessage(event) ?? message;
          const reasoningText = completedReasoning(event);
          if (reasoningText !== undefined) reasoning.push(reasoningText);
          if (event.type === "turn.completed") {
            const candidate = parseCodexCliReportedUsage(event.usage);
            if (candidate !== undefined) reportedUsage = candidate;
          }
        }
        if (!message) finish(new StrongCodeError("MODEL_ERROR", "Official Codex CLI returned no agent message"));
        else finish(undefined, {
          message,
          toolCalls: [],
          ...(reasoning.length > 0 ? { reasoning: reasoning.join("\n\n") } : {}),
          ...(reportedUsage?.usage ? { usage: reportedUsage.usage } : {}),
          ...(reportedUsage ? { providerUsage: reportedUsage.providerUsage } : {})
        });
      });
      child.stdin.end(responsePrompt(request));
    });
  }
}
