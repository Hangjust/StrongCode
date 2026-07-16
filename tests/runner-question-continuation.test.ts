import { AgentRunner } from "../src/agents/runner";
import type { ModelRequest, ModelResponse } from "../src/models/provider";
import { QuestionBroker } from "../src/questions/broker";
import { createQuestionTool } from "../src/tools/builtin/question";
import {
  continuationAgent,
  continuationTool,
  createContinuationHarness,
  nextQuestion,
  QUESTION_INPUT,
  scriptedProvider
} from "./runner-continuation-fixtures";

describe("runner question continuation", () => {
  const invalidQuestionBatches: ReadonlyArray<{
    readonly label: string;
    readonly toolCalls: ModelResponse["toolCalls"];
  }> = [
    {
      label: "a question mixed with another tool",
      toolCalls: [
        { callId: "call-question-mixed", name: "question", input: QUESTION_INPUT },
        { callId: "call-alpha-mixed", name: "alpha", input: {} }
      ]
    },
    {
      label: "more than one question",
      toolCalls: [
        { callId: "call-question-first", name: "question", input: QUESTION_INPUT },
        { callId: "call-question-second", name: "question", input: QUESTION_INPUT }
      ]
    }
  ];

  it.each(invalidQuestionBatches)("rejects $label before executing the batch", async ({ toolCalls }) => {
    const harness = await createContinuationHarness(["question", "alpha"]);
    const requests: ModelRequest[] = [];
    const executions: string[] = [];
    harness.registry.register(continuationTool("question", "question result", executions));
    harness.registry.register(continuationTool("alpha", "alpha result", executions));
    const model = scriptedProvider([{ message: "Invalid question batch.", toolCalls }], requests);
    const runner = new AgentRunner(harness.context, harness.sessions, harness.registry);

    const result = await runner.run(continuationAgent(harness.config, model), "Start", `question-reject-${requests.length}`);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("MODEL_ERROR");
    expect(executions).toEqual([]);
  });

  it.each(["answered", "dismissed"] as const)("continues with a %s question result", async outcome => {
    const harness = await createContinuationHarness(["question"]);
    const requests: ModelRequest[] = [];
    const broker = new QuestionBroker();
    harness.registry.register(createQuestionTool(broker));
    const model = scriptedProvider([
      { message: "I need a decision.", toolCalls: [{ callId: `call-question-${outcome}`, name: "question", input: QUESTION_INPUT }] },
      { message: `Model received ${outcome}.`, toolCalls: [] }
    ], requests);
    const runner = new AgentRunner(harness.context, harness.sessions, harness.registry);
    const pendingQuestion = nextQuestion(broker);

    const running = runner.run(continuationAgent(harness.config, model), "Start", `question-${outcome}`);
    const pending = await pendingQuestion;
    const settled = outcome === "answered"
      ? broker.answer(pending.token, {
          outcome: "answered",
          answers: [{
            questionId: "scope",
            question: "Which scope should we use?",
            selections: [{ optionId: "small", optionLabel: "Small change" }]
          }]
        })
      : broker.dismiss(pending.token);
    expect(settled.ok).toBe(true);

    const result = await running;

    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.at(-1)).toEqual({
      role: "tool",
      content: outcome === "answered"
        ? '{"outcome":"answered","answers":[{"questionId":"scope","question":"Which scope should we use?","selections":[{"optionId":"small","optionLabel":"Small change"}]}]}'
        : '{"outcome":"dismissed"}'
    });
    broker.close();
  });

  it("closes tools once, unblocks active questions, waits for runs, and rejects later work", async () => {
    const harness = await createContinuationHarness(["question"]);
    const requests: ModelRequest[] = [];
    const broker = new QuestionBroker();
    let closeCalls = 0;
    harness.registry.register(createQuestionTool(broker));
    harness.registry.addCloser(async () => {
      closeCalls += 1;
      broker.close();
    });
    const model = scriptedProvider([{
      message: "Waiting for an answer.",
      toolCalls: [{ callId: "call-question-close", name: "question", input: QUESTION_INPUT }]
    }], requests);
    const runner = new AgentRunner(harness.context, harness.sessions, harness.registry);
    const pendingQuestion = nextQuestion(broker);
    let completedResult: Awaited<ReturnType<typeof runner.run>> | undefined;

    const running = runner.run(continuationAgent(harness.config, model), "Start", "closing").then(result => {
      completedResult = result;
      return result;
    });
    await pendingQuestion;
    await Promise.all([runner.close(), runner.close()]);

    expect(completedResult?.ok).toBe(false);
    expect(closeCalls).toBe(1);
    expect(requests).toHaveLength(1);
    const session = await harness.sessions.read("closing");
    expect(session.ok).toBe(true);
    if (session.ok) {
      expect(session.value.events.filter(event => event.type === "message" || event.type === "conversation_item")).toEqual([
        expect.objectContaining({ type: "message", role: "user", content: "Start" }),
        expect.objectContaining({ type: "message", role: "assistant", content: "Waiting for an answer." }),
        expect.objectContaining({
          type: "conversation_item",
          item: expect.objectContaining({ type: "tool_call", callId: "call-question-close" })
        })
      ]);
    }
    const afterClose = await runner.run(continuationAgent(harness.config, model), "Later", "after-close");
    expect(afterClose.ok).toBe(false);
    expect(requests).toHaveLength(1);
    expect((await harness.sessions.read("after-close")).ok).toBe(false);
    await running;
  });
});
