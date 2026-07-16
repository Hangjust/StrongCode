import { err, ok } from "../../core/result";
import type { QuestionBroker } from "../../questions/broker";
import {
  parseQuestionRequest,
  parseQuestionResult,
  questionRequestJsonSchema,
  questionRequestSchema
} from "../../questions/schema";
import type { Tool } from "../tool";

const DESCRIPTION = "Use this tool whenever user input would materially affect the work. Ask 1-6 questions in very easy English. Use common words and short descriptions, preserve exact technical terms, and prefer one batched request instead of serial questions.";

export function createQuestionTool(broker: QuestionBroker) {
  return {
  name: "question",
  description: DESCRIPTION,
  effect: "interaction",
    inputSchema: questionRequestSchema,
    inputJsonSchema: questionRequestJsonSchema,
    readOnly: true,
    async execute(input: unknown) {
      const request = parseQuestionRequest(input);
      if (!request.ok) return err(request.error);

      const hostResult = await broker.ask(request.value);
      const result = parseQuestionResult(hostResult);
      if (!result.ok) return err(result.error);
      return ok({ content: JSON.stringify(result.value) });
    }
  } satisfies Tool;
}
