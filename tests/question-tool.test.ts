import { StrongCodeError } from "../src/core/errors";
import { QuestionBroker, type PendingQuestion } from "../src/questions/broker";
import { questionRequestJsonSchema, questionRequestSchema } from "../src/questions/schema";
import { createQuestionTool } from "../src/tools/builtin/question";

function input() {
  return {
    questions: [{
      id: "runtime",
      header: "  Runtime choice  ",
      question: "  Which runtime should we use?  ",
      options: [
        { id: "node", label: "Node.js 22", description: "Use the current LTS." },
        { id: "bun", label: "Bun 1.2", description: "Use the fast runtime." }
      ]
    }]
  };
}

describe("createQuestionTool", () => {
  it("exposes a read-only question tool with the explicit strict input schema", () => {
    const tool = createQuestionTool(new QuestionBroker());

    expect(tool.name).toBe("question");
    expect(tool.readOnly).toBe(true);
    expect(tool.inputSchema).toBe(questionRequestSchema);
    expect(tool.inputJsonSchema).toBe(questionRequestJsonSchema);
    expect(tool.inputJsonSchema).toMatchObject({
      type: "object",
      required: ["questions"],
      additionalProperties: false,
      properties: { questions: { minItems: 1, maxItems: 6 } }
    });
  });

  it("strongly instructs agents when and how to ask", () => {
    const description = createQuestionTool(new QuestionBroker()).description.toLowerCase();

    expect(description).toContain("whenever user input would materially affect the work");
    expect(description).toContain("1-6 questions");
    expect(description).toContain("very easy english");
    expect(description).toContain("common words");
    expect(description).toContain("short descriptions");
    expect(description).toContain("exact technical terms");
    expect(description).toContain("one batched request");
    expect(description).toContain("serial questions");
  });

  it("parses input, waits for the host, and returns compact strict QuestionResult JSON", async () => {
    const broker = new QuestionBroker();
    const tool = createQuestionTool(broker);
    let pending: PendingQuestion | undefined;
    broker.subscribe(next => { pending = next; });

    let completed = false;
    const execution = tool.execute(input()).then(result => {
      completed = true;
      return result;
    });
    await Promise.resolve();

    expect(completed).toBe(false);
    expect(pending?.request.questions[0]).toMatchObject({
      id: "runtime",
      header: "Runtime choice",
      question: "Which runtime should we use?",
      multiple: false,
      allowCustom: true
    });
    const settlement = broker.answer(pending?.token, {
      outcome: "answered",
      answers: [{
        questionId: "runtime",
        question: "Which runtime should we use?",
        selections: [{ optionId: "node", optionLabel: "Node.js 22" }]
      }],
      guidance: "Keep package scripts unchanged."
    });
    expect(settlement.ok).toBe(true);

    const result = await execution;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe(JSON.stringify({
        outcome: "answered",
        answers: [{
          questionId: "runtime",
          question: "Which runtime should we use?",
          selections: [{ optionId: "node", optionLabel: "Node.js 22" }]
        }],
        guidance: "Keep package scripts unchanged."
      }));
    }
  });

  it("returns typed validation failures without opening a pending question", async () => {
    const broker = new QuestionBroker();
    const tool = createQuestionTool(broker);
    const observed: Array<PendingQuestion | undefined> = [];
    broker.subscribe(pending => observed.push(pending));

    const result = await tool.execute({ questions: [] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(StrongCodeError);
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
    expect(observed).toEqual([undefined]);
    broker.close();
  });

  it("serializes host dismissal as the exact QuestionResult contract", async () => {
    const broker = new QuestionBroker();
    const tool = createQuestionTool(broker);
    let pending: PendingQuestion | undefined;
    broker.subscribe(next => { pending = next; });
    const execution = tool.execute(input());

    expect(broker.dismiss(pending?.token).ok).toBe(true);

    const result = await execution;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.content).toBe('{"outcome":"dismissed"}');
  });
});
