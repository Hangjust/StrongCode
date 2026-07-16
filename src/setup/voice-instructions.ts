import { lstat, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { StrongCodeError } from "../core/errors";
import { DEFAULT_GLOBAL_AGENT_INSTRUCTIONS, DEFAULT_VOICE_TO_TEXT_INSTRUCTIONS } from "../config/bundled-instructions";
import type { VoiceToTextChoice } from "./types";

export const VOICE_TO_TEXT_INSTRUCTIONS = DEFAULT_VOICE_TO_TEXT_INSTRUCTIONS;

export const VOICE_BLOCK_START = "<!-- strongcode:voice-to-text:start -->";
export const VOICE_BLOCK_END = "<!-- strongcode:voice-to-text:end -->";

const LEGACY_GLOBAL_INSTRUCTIONS = `# StrongCode Global Instructions

Put user-wide StrongCode instructions here. Project instructions remain with each project and may override these defaults.

Do not place API keys, access tokens, passwords, or private credentials in instruction files.`;

function managedBlock(): string {
  return `${VOICE_BLOCK_START}\n${VOICE_TO_TEXT_INSTRUCTIONS}\n${VOICE_BLOCK_END}`;
}

function replaceManagedBlock(source: string, replacement: string): string {
  const start = source.indexOf(VOICE_BLOCK_START);
  const end = source.indexOf(VOICE_BLOCK_END);
  if (start < 0 && end < 0) return replacement ? `${source.trimEnd()}\n\n${replacement}\n` : source;
  if (start < 0 || end < start) throw new StrongCodeError("CONFIG_ERROR", "AGENTS.md contains an incomplete StrongCode voice-to-text managed block");
  const afterEnd = end + VOICE_BLOCK_END.length;
  const next = `${source.slice(0, start).trimEnd()}${replacement ? `\n\n${replacement}` : ""}${source.slice(afterEnd)}`;
  return `${next.trimEnd()}\n`;
}

function upgradeLegacyBase(source: string): string {
  const withoutVoice = replaceManagedBlock(source, "").trim();
  if (withoutVoice !== LEGACY_GLOBAL_INSTRUCTIONS) return source;
  const hasVoice = source.includes(VOICE_BLOCK_START) && source.includes(VOICE_BLOCK_END);
  return `${DEFAULT_GLOBAL_AGENT_INSTRUCTIONS}${hasVoice ? `\n\n${managedBlock()}` : ""}\n`;
}

async function assertRegularFileOrMissing(filePath: string): Promise<void> {
  try {
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) throw new StrongCodeError("CONFIG_ERROR", `Refusing to update non-regular AGENTS.md: ${filePath}`);
  } catch (error) {
    if (error instanceof StrongCodeError) throw error;
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

export async function applyVoiceToTextInstructions(agentsPath: string, choice: VoiceToTextChoice): Promise<boolean> {
  const resolved = path.resolve(agentsPath);
  await assertRegularFileOrMissing(resolved);
  let source = `${DEFAULT_GLOBAL_AGENT_INSTRUCTIONS}\n`;
  try {
    source = await readFile(resolved, "utf8");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  const next = replaceManagedBlock(upgradeLegacyBase(source), choice === "yes" ? managedBlock() : "");
  if (next === source) return false;
  const tempPath = path.join(path.dirname(resolved), `.AGENTS.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(tempPath, next, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await rename(tempPath, resolved);
  return true;
}
