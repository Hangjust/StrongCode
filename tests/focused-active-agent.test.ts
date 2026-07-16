import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { activateFocusedAgent } from "../src/agents/focused-active-agent";
import { parseTaskPacket, renderTaskPacket } from "../src/agents/task-packet";
import { strongCodeConfigSchema } from "../src/config/schema";
import { testConfig } from "./helpers";

const roots: string[] = [];

const packet = {
  goal: "Implement the bounded focused change.",
  expectedOutcome: "A verified focused result.",
  scope: ["src/agents"],
  requiredChecks: ["Run focused tests."],
  prohibitions: ["Do not delegate."],
  relevantPaths: ["src/agents/task-packet.ts"],
  artifacts: ["test receipt"]
};

describe("focused active agent activation", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  it("parses and renders an immutable bounded packet as user content", () => {
    const parsed = parseTaskPacket(packet);
    const rendered = renderTaskPacket(parsed);

    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.scope)).toBe(true);
    expect(rendered).toContain(packet.goal);
    for (const field of ["authority", "attachment", "media", "script"]) {
      expect(() => parseTaskPacket({ ...packet, [field]: "system" })).toThrowError(/Task packet/i);
    }
  });

  it("retains Tesla while applying category reductions without creating a task", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "strongcode-focused-selection-"));
    roots.push(root);
    const config = testConfig(root);
    config.dataDir = ".selection";
    config.agents.default.tools = ["list_files", "read_file", "write_file"];

    const activated = await activateFocusedAgent({
      authority: {
        config,
        activeAgentId: "tesla",
        categories: { deep: { tools: ["read_file"] } }
      },
      task: { categoryId: "deep", taskPacket: packet }
    });

    expect(activated.activeAgentId).toBe("tesla");
    expect(activated.agent.name).toBe("tesla");
    expect(activated.agent.runtimeRole).toBe("primary");
    expect(activated.policy.tools).toEqual(["read_file"]);
    expect(activated.agent.config.tools).toEqual(["read_file"]);
    expect(activated.task.role).toBe("user");
    expect(activated.task.content).toContain(packet.goal);
    expect(activated.agent.systemPrompt).not.toContain(packet.goal);
    await expect(access(path.join(root, ".selection", "tasks"))).rejects.toThrow();
  });

  it("keeps unapproved Bob read-only and rejects category elevation", async () => {
    const config = testConfig(process.cwd());
    config.agents.default.tools = ["read_file", "write_file"];

    const readOnly = await activateFocusedAgent({
      authority: { config, activeAgentId: "bob-the-builder" },
      task: { taskPacket: packet }
    });
    const denied = activateFocusedAgent({
      authority: {
        config,
        activeAgentId: "bob-the-builder",
        categories: { deep: { tools: ["read_file"] } }
      },
      task: { categoryId: "deep", taskPacket: packet }
    });

    expect(readOnly.agent.name).toBe("bob-the-builder");
    expect(readOnly.agent.toolPolicy).toBe("read-only");
    await expect(denied).rejects.toMatchObject({ code: "CATEGORY_POLICY_DENIED" });
  });

  it("preserves explicitly approved Bob identity while reducing tools", async () => {
    const config = testConfig(process.cwd());
    config.agents.default.tools = ["read_file", "write_file"];

    const activated = await activateFocusedAgent({
      authority: {
        config,
        activeAgentId: "bob-the-builder",
        approvedPlanExecution: true,
        categories: { deep: { tools: ["read_file"] } }
      },
      task: { categoryId: "deep", taskPacket: packet }
    });

    expect(activated.agent.name).toBe("bob-the-builder");
    expect(activated.agent.toolPolicy).toBe("standard");
    expect(activated.agent.config.tools).toEqual(["read_file"]);
  });

  it("rejects wrong identities, hidden-agent payloads, and tool expansion", async () => {
    const config = testConfig(process.cwd());
    config.agents.default.tools = ["read_file"];
    const task = { categoryId: "deep", taskPacket: packet };
    const hiddenCategories = { deep: {} };
    Object.defineProperty(hiddenCategories.deep, "agent", {
      value: "strongcode-worker",
      enumerable: true
    });

    const wrongAgent = activateFocusedAgent({
      authority: { config, activeAgentId: "newton", categories: { deep: {} } },
      task
    });
    const hiddenAgent = activateFocusedAgent({
      authority: { config, activeAgentId: "tesla", categories: hiddenCategories },
      task
    });
    const expansion = activateFocusedAgent({
      authority: { config, activeAgentId: "tesla", categories: { deep: { tools: ["write_file"] } } },
      task
    });

    await expect(wrongAgent).rejects.toMatchObject({ code: "CATEGORY_POLICY_DENIED" });
    await expect(hiddenAgent).rejects.toMatchObject({ code: "CATEGORY_POLICY_DENIED" });
    await expect(expansion).rejects.toMatchObject({ code: "CATEGORY_POLICY_DENIED" });
  });

  it("persists canonical skill receipts as prompt-only system guidance", async () => {
    const homeRoot = await mkdtemp(path.join(tmpdir(), "strongcode-focused-skill-"));
    roots.push(homeRoot);
    await mkdir(path.join(homeRoot, "skills", "focus"), { recursive: true });
    await writeFile(path.join(homeRoot, "skills.mcps.json"), "{\"version\":1,\"skills\":{\"directory\":\"skills\",\"manifestName\":\"SKILL.md\",\"autoDiscover\":true,\"enabled\":[],\"disabled\":[]}}\n", "utf8");
    await writeFile(path.join(homeRoot, "skills", "focus", "SKILL.md"), "---\nagent: tesla\n---\nSKILL_MARKDOWN\n", "utf8");

    const activated = await activateFocusedAgent({
      authority: {
        config: testConfig(process.cwd()),
        activeAgentId: "tesla",
        categories: { deep: { skills: ["focus"] } },
        skillOptions: { homeRoot }
      },
      task: { categoryId: "deep", taskPacket: packet }
    });

    expect(activated.skillReceipts).toHaveLength(1);
    expect(activated.skillReceipts[0]?.id).toBe("focus");
    expect(Object.isFrozen(activated.skillReceipts[0])).toBe(true);
    expect(activated.agent.systemPrompt).toContain("SKILL_MARKDOWN");
    expect(activated.agent.systemPrompt).not.toContain(packet.goal);
  });

  it("accepts only executable category profile fields", () => {
    const config = testConfig(process.cwd());
    const parsed = strongCodeConfigSchema.safeParse({
      ...config,
      categories: { deep: { model: "mock", tools: ["read_file"], skills: ["focus"] } }
    });
    const elevated = strongCodeConfigSchema.safeParse({
      ...config,
      categories: { deep: { delegation: "allow" } }
    });

    expect(parsed.success).toBe(true);
    expect(elevated.success).toBe(false);
  });
});
