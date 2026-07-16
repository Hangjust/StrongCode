import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_GLOBAL_AGENT_INSTRUCTIONS } from "../src/config/bundled-instructions";
import {
  applyVoiceToTextInstructions,
  VOICE_BLOCK_START,
  VOICE_TO_TEXT_INSTRUCTIONS
} from "../src/setup/voice-instructions";

const LEGACY = `# StrongCode Global Instructions

Put user-wide StrongCode instructions here. Project instructions remain with each project and may override these defaults.

Do not place API keys, access tokens, passwords, or private credentials in instruction files.
`;

describe("voice-to-text AGENTS.md management", () => {
  it("adds the supplied voice script to the supplied default instructions only for yes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-voice-yes-"));
    const agentsPath = path.join(root, "AGENTS.md");
    await writeFile(agentsPath, `${DEFAULT_GLOBAL_AGENT_INSTRUCTIONS}\n`, "utf8");

    await applyVoiceToTextInstructions(agentsPath, "yes");
    const content = await readFile(agentsPath, "utf8");

    expect(content).toContain(DEFAULT_GLOBAL_AGENT_INSTRUCTIONS);
    expect(content).toContain(VOICE_TO_TEXT_INSTRUCTIONS);
    expect(content.match(new RegExp(VOICE_BLOCK_START, "g"))).toHaveLength(1);
  });

  it("does not add the voice script for no or maybe", async () => {
    for (const choice of ["no", "maybe"] as const) {
      const root = await mkdtemp(path.join(tmpdir(), `strongcode-voice-${choice}-`));
      const agentsPath = path.join(root, "AGENTS.md");
      await writeFile(agentsPath, `${DEFAULT_GLOBAL_AGENT_INSTRUCTIONS}\n`, "utf8");

      await applyVoiceToTextInstructions(agentsPath, choice);
      const content = await readFile(agentsPath, "utf8");
      expect(content).toBe(`${DEFAULT_GLOBAL_AGENT_INSTRUCTIONS}\n`);
      expect(content).not.toContain(VOICE_BLOCK_START);
    }
  });

  it("upgrades the old generated placeholder while preserving an enabled voice block", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-voice-migrate-"));
    const agentsPath = path.join(root, "AGENTS.md");
    await writeFile(agentsPath, `${LEGACY}\n${VOICE_BLOCK_START}\n${VOICE_TO_TEXT_INSTRUCTIONS}\n<!-- strongcode:voice-to-text:end -->\n`, "utf8");

    await applyVoiceToTextInstructions(agentsPath, "yes");
    const content = await readFile(agentsPath, "utf8");

    expect(content).toContain(DEFAULT_GLOBAL_AGENT_INSTRUCTIONS);
    expect(content).not.toContain("Put user-wide StrongCode instructions here");
    expect(content.match(new RegExp(VOICE_BLOCK_START, "g"))).toHaveLength(1);
  });

  it("never replaces genuinely customized instructions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-voice-custom-"));
    const agentsPath = path.join(root, "AGENTS.md");
    await writeFile(agentsPath, "# My instructions\n\nKeep this custom rule.\n", "utf8");

    await applyVoiceToTextInstructions(agentsPath, "yes");
    const content = await readFile(agentsPath, "utf8");

    expect(content).toContain("Keep this custom rule.");
    expect(content).toContain(VOICE_TO_TEXT_INSTRUCTIONS);
  });
});
