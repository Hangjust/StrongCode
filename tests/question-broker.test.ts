import { StrongCodeError } from "../src/core/errors";
import { QuestionBroker, type PendingQuestion } from "../src/questions/broker";
import { parseQuestionRequest, type QuestionRequest } from "../src/questions/schema";

function request(id: string, questionText = "Which scope should we use?"): QuestionRequest {
  const parsed = parseQuestionRequest({
    questions: [{
      id,
      header: "Build scope",
      question: questionText,
      options: [
        { id: "small", label: "Small change", description: "Change only this part." },
        { id: "wide", label: "Wide change", description: "Change related parts too." }
      ]
    }]
  });
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

function answered(questionId: string, questionText = "Rewritten question?") {
  return {
    outcome: "answered",
    answers: [{
      questionId,
      question: questionText,
      selections: [{ optionId: "small", optionLabel: "Rewritten label" }]
    }]
  };
}

describe("QuestionBroker", () => {
  it("shows one active request, replays it to late subscribers, and advances FIFO", async () => {
    const broker = new QuestionBroker();
    const observed: Array<PendingQuestion | undefined> = [];
    broker.subscribe(pending => observed.push(pending));

    const firstResult = broker.ask(request("first"));
    const secondResult = broker.ask(request("second", "Which release should we use?"));
    const firstPending = observed.at(-1);
    const replayed: Array<PendingQuestion | undefined> = [];
    broker.subscribe(pending => replayed.push(pending));

    expect(firstPending?.request.questions[0].id).toBe("first");
    expect(replayed).toEqual([firstPending]);
    expect(broker.answer(firstPending?.token, answered("first")).ok).toBe(true);
    expect(observed.at(-1)?.request.questions[0].id).toBe("second");
    expect(broker.dismiss(observed.at(-1)?.token).ok).toBe(true);
    expect(await firstResult).toEqual({
      outcome: "answered",
      answers: [{
        questionId: "first",
        question: "Which scope should we use?",
        selections: [{ optionId: "small", optionLabel: "Small change" }]
      }]
    });
    expect(await secondResult).toEqual({ outcome: "dismissed" });
  });

  it("unsubscribes observers", () => {
    const broker = new QuestionBroker();
    const observed: Array<PendingQuestion | undefined> = [];
    const unsubscribe = broker.subscribe(pending => observed.push(pending));

    unsubscribe();
    void broker.ask(request("hidden"));

    expect(observed).toEqual([undefined]);
    broker.close();
  });

  it("rejects invalid, duplicate, and unknown settlements with typed errors", async () => {
    const broker = new QuestionBroker();
    const otherBroker = new QuestionBroker();
    let active: PendingQuestion | undefined;
    let otherActive: PendingQuestion | undefined;
    broker.subscribe(pending => { active = pending; });
    otherBroker.subscribe(pending => { otherActive = pending; });
    const result = broker.ask(request("active"));
    void otherBroker.ask(request("other"));

    const invalid = broker.answer(active?.token, { outcome: "answered", answers: [] });
    const unknown = broker.dismiss(otherActive?.token);
    const settled = broker.dismiss(active?.token);
    const duplicate = broker.dismiss(active?.token);

    expect(invalid.ok).toBe(false);
    expect(unknown.ok).toBe(false);
    expect(settled.ok).toBe(true);
    expect(duplicate.ok).toBe(false);
    for (const failure of [invalid, unknown, duplicate]) {
      if (!failure.ok) expect(failure.error).toBeInstanceOf(StrongCodeError);
    }
    if (!invalid.ok) expect(invalid.error.code).toBe("VALIDATION_ERROR");
    if (!unknown.ok) expect(unknown.error.code).toBe("SESSION_ERROR");
    if (!duplicate.ok) expect(duplicate.error.code).toBe("SESSION_ERROR");
    expect(await result).toEqual({ outcome: "dismissed" });
    otherBroker.close();
  });

  it("closes idempotently, dismisses every waiter, and never queues after close", async () => {
    const broker = new QuestionBroker();
    const observed: Array<PendingQuestion | undefined> = [];
    broker.subscribe(pending => observed.push(pending));
    const first = broker.ask(request("first"));
    const second = broker.ask(request("second"));

    broker.close();
    broker.close();
    const afterClose = broker.ask(request("late"));

    expect(await Promise.all([first, second, afterClose])).toEqual([
      { outcome: "dismissed" },
      { outcome: "dismissed" },
      { outcome: "dismissed" }
    ]);
    expect(observed.at(-1)).toBeUndefined();
  });
});
