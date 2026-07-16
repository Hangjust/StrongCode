import { execFile, spawnSync } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const rendererIt = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0 ? it : it.skip;

describe("question model continuation flow", () => {
  rendererIt("continues only after a real tabbed OpenTUI answer is submitted", async () => {
    // Given
    const fixture = path.resolve(__dirname, "fixtures", "question-flow.ts");

    // When
    const { stdout } = await execFileAsync("bun", [fixture], { cwd: path.resolve(__dirname, "..") });
    const result = JSON.parse(stdout) as {
      readonly initialFrame: string;
      readonly requestCountBeforeAnswer: number;
      readonly requests: readonly {
        readonly prompt: string;
        readonly tools: readonly string[];
        readonly toolDefinitions?: readonly { readonly name: string }[];
        readonly messages: readonly { readonly role: string; readonly content: string }[];
      }[];
      readonly run: {
        readonly response: string;
        readonly toolExecutions: readonly { readonly tool: string; readonly output: string }[];
      };
      readonly sessionEvents: readonly Record<string, unknown>[];
      readonly timeline: readonly string[];
    };

    // Then
    const toolResult = "{\"outcome\":\"answered\",\"answers\":[{\"questionId\":\"command-style\",\"question\":\"Which command style should we use?\",\"selections\":[{\"optionId\":\"current\",\"optionLabel\":\"Keep current names\"}]},{\"questionId\":\"output-format\",\"question\":\"Which output format should we use?\",\"selections\":[{\"optionId\":\"json\",\"optionLabel\":\"JSON output\"}]},{\"questionId\":\"error-style\",\"question\":\"Which error style should we use?\",\"selections\":[{\"optionId\":\"detailed\",\"optionLabel\":\"Detailed errors\"}]}],\"guidance\":\"Keep the current command names.\"}";

    expect(result.initialFrame).toContain("1. Command style");
    expect(result.initialFrame).toContain("2. Output format");
    expect(result.initialFrame).toContain("3. Error style");
    expect(result.initialFrame).toContain("Confirm");
    expect(result.requestCountBeforeAnswer).toBe(1);
    expect(result.requests).toHaveLength(2);
    expect(result.requests[0]?.tools).toEqual(["question"]);
    expect(result.requests[0]?.toolDefinitions?.map(definition => definition.name)).toEqual(["question"]);
    expect(result.requests[1]?.prompt).toBe("");
    expect(result.requests[1]?.messages.filter(message => message.role === "tool")).toEqual([
      { role: "tool", content: toolResult }
    ]);
    expect(result.run.response).toBe("I will follow those choices.");
    expect(result.run.toolExecutions).toEqual([
      expect.objectContaining({ tool: "question", output: toolResult })
    ]);
    const conversationEvents = result.sessionEvents.filter(event => event.type === "message" || event.type === "conversation_item");
    const primaryAttempts = result.sessionEvents.filter(event => event.type === "attempt_created" && event.role === "primary");
    expect(primaryAttempts).toHaveLength(2);
    expect(conversationEvents).toEqual([
      expect.objectContaining({ type: "message", role: "user", content: "Choose a safe command style." }),
      expect.objectContaining({ type: "message", role: "assistant", content: "I need three choices." }),
      expect.objectContaining({ type: "conversation_item", item: expect.objectContaining({ type: "tool_call", callId: "call-question-flow" }) }),
      expect.objectContaining({ type: "conversation_item", item: expect.objectContaining({ type: "tool_result", callId: "call-question-flow", content: toolResult }) }),
      expect.objectContaining({ type: "message", role: "assistant", content: "I will follow those choices." })
    ]);
    expect(result.timeline).toEqual([
      "runtime:run_started",
      "session:user",
      "model:1",
      "session:assistant:I need three choices.",
      "session:call:question",
      "runtime:tool_started",
      "session:result:call-question-flow",
      "runtime:tool_finished",
      "model:2",
      "session:assistant:I will follow those choices.",
      "runtime:run_finished"
    ]);
  });
});
