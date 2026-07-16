import { readFileSync } from "node:fs";
import path from "node:path";

function asset(name: string): string {
  return readFileSync(path.resolve(__dirname, "..", "..", "assets", name), "utf8").replace(/\r\n/g, "\n").trimEnd();
}

export const DEFAULT_GLOBAL_AGENT_INSTRUCTIONS = asset("AGENTS.md");
export const DEFAULT_VOICE_TO_TEXT_INSTRUCTIONS = asset("Voice-To-Text.txt");
