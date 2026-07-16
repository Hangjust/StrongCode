import { describe, expect, it } from "vitest";
import { snapshotFocusedActivationInput } from "../src/agents/focused-activation-input";
import { testConfig } from "./helpers";

const packet = {
  goal: "Snapshot authority.",
  expectedOutcome: "Immutable focused activation.",
  scope: ["src/agents"],
  requiredChecks: ["Run tests."],
  prohibitions: ["No delegation."],
  relevantPaths: [],
  artifacts: []
};

function validInput() {
  return {
    authority: {
      config: testConfig(process.cwd()),
      activeAgentId: "tesla",
      approvedPlanExecution: false,
      categories: {
        deep: {
          tools: ["read_file"],
          skills: ["focus"],
          fallbackModels: ["mock"]
        }
      }
    },
    task: {
      categoryId: "deep",
      taskPacket: packet,
      requestedSkills: ["focus"]
    }
  };
}

describe("focused activation input snapshot", () => {
  it("copies and deeply freezes nested authority and task arrays", () => {
    const input = validInput();

    const snapshot = snapshotFocusedActivationInput(input);
    input.authority.categories.deep.tools.push("write_file");
    input.task.requestedSkills.push("forged");
    input.task.taskPacket.scope.push("forged");

    expect(snapshot.authority.categories.deep?.tools).toEqual(["read_file"]);
    expect(snapshot.task.requestedSkills).toEqual(["focus"]);
    expect(snapshot.task.packet.scope).toEqual(["src/agents"]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.authority.config.models)).toBe(true);
    expect(Object.isFrozen(snapshot.authority.categories.deep?.tools)).toBe(true);
    expect(Object.isFrozen(snapshot.task.packet.scope)).toBe(true);
  });

  it("captures approved capability leaves by identity without freezing them", () => {
    const modelFetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [] }), text: async () => "{}" });
    const chatGptFetch = async () => new Response("{}", { status: 200 });
    const authStore = { get: async () => undefined, all: async () => ({}) };
    const input = validInput();
    const authority = { ...input.authority, modelFetch, chatGptFetch, authStore };

    const snapshot = snapshotFocusedActivationInput({ ...input, authority });

    expect(snapshot.authority.modelFetch).toBe(modelFetch);
    expect(snapshot.authority.chatGptFetch).toBe(chatGptFetch);
    expect(snapshot.authority.authStore).toBe(authStore);
    expect(Object.isFrozen(authStore)).toBe(false);
  });

  it("rejects an approval accessor without invoking it", () => {
    let invocations = 0;
    const input = validInput();
    Object.defineProperty(input.authority, "approvedPlanExecution", {
      enumerable: true,
      get() {
        invocations += 1;
        return true;
      }
    });

    expect(() => snapshotFocusedActivationInput(input)).toThrowError(
      expect.objectContaining({ code: "CATEGORY_POLICY_DENIED" })
    );
    expect(invocations).toBe(0);
  });

  it("rejects a nested config accessor without invoking it", () => {
    let invocations = 0;
    const input = validInput();
    Object.defineProperty(input.authority.config.models, "stateful", {
      enumerable: true,
      get() {
        invocations += 1;
        return { provider: "mock", enabled: true };
      }
    });

    expect(() => snapshotFocusedActivationInput(input)).toThrowError(
      expect.objectContaining({ code: "CATEGORY_POLICY_DENIED" })
    );
    expect(invocations).toBe(0);
  });

  it("rejects a category accessor without invoking it", () => {
    let invocations = 0;
    const input = validInput();
    Object.defineProperty(input.authority.categories, "deep", {
      enumerable: true,
      get() {
        invocations += 1;
        return { tools: ["write_file"] };
      }
    });

    expect(() => snapshotFocusedActivationInput(input)).toThrowError(
      expect.objectContaining({ code: "CATEGORY_POLICY_DENIED" })
    );
    expect(invocations).toBe(0);
  });

  it("rejects toJSON functions without invoking them", () => {
    let invocations = 0;
    const input = validInput();
    Object.defineProperty(input.authority.categories.deep, "toJSON", {
      enumerable: true,
      value() {
        invocations += 1;
        return { tools: ["write_file"] };
      }
    });

    expect(() => snapshotFocusedActivationInput(input)).toThrowError(
      expect.objectContaining({ code: "CATEGORY_POLICY_DENIED" })
    );
    expect(invocations).toBe(0);
  });

  it.each([
    {
      label: "symbol properties",
      mutate(input: ReturnType<typeof validInput>) {
        Object.defineProperty(input.authority.categories, Symbol("hidden"), { value: true });
      }
    },
    {
      label: "unexpected non-enumerables",
      mutate(input: ReturnType<typeof validInput>) {
        Object.defineProperty(input.authority.categories.deep, "hidden", { value: true });
      }
    },
    {
      label: "custom prototypes",
      mutate(input: ReturnType<typeof validInput>) {
        class CustomCategory {
          readonly tools = ["read_file"];
        }
        Object.defineProperty(input.authority.categories, "deep", {
          value: new CustomCategory(),
          enumerable: true,
          configurable: true
        });
      }
    },
    {
      label: "cycles",
      mutate(input: ReturnType<typeof validInput>) {
        const cycle: Record<string, unknown> = {};
        cycle.self = cycle;
        input.authority.config.models.cycle = { provider: "mock", options: cycle };
      }
    },
    {
      label: "unapproved nested functions",
      mutate(input: ReturnType<typeof validInput>) {
        input.authority.config.models.callback = { provider: "mock", options: { callback() { return true; } } };
      }
    }
  ])("rejects $label", ({ mutate }) => {
    const input = validInput();
    mutate(input);

    expect(() => snapshotFocusedActivationInput(input)).toThrowError(
      expect.objectContaining({ code: "CATEGORY_POLICY_DENIED" })
    );
  });

  it.each([
    { homeRoot: "attacker-home" },
    { projectRoot: "attacker-project" },
    { trustedProjectInstructions: true },
    { skillOptions: { homeRoot: "attacker-home" } }
  ])("rejects task-controlled skill trust field %#", injected => {
    const input = validInput();

    expect(() => snapshotFocusedActivationInput({
      ...input,
      task: { ...input.task, ...injected }
    })).toThrowError(expect.objectContaining({ code: "CATEGORY_POLICY_DENIED" }));
  });
});
