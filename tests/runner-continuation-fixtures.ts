import { z } from "zod";
import type { Agent } from "../src/agents/agent";
import { StrongCodeError } from "../src/core/errors";
import { err, ok, type Result } from "../src/core/result";
import type { ModelProvider, ModelRequest, ModelResponse } from "../src/models/provider";
import { QuestionBroker, type PendingQuestion } from "../src/questions/broker";
import type { ToolInvocationContext } from "../src/runtime/context";
import type { ConversationSessionEvent } from "../src/sessions/session";
import { SessionStore } from "../src/sessions/session-store";
import { ToolRegistry } from "../src/tools/registry";
import type { Tool } from "../src/tools/tool";
import { tempWorkspace } from "./helpers";

export const QUESTION_INPUT = {
  questions: [{
    id: "scope",
    header: "Build scope",
    question: "Which scope should we use?",
    options: [
      { id: "small", label: "Small change" },
      { id: "wide", label: "Wide change" }
    ]
  }]
} as const;

export async function createContinuationHarness(toolNames: readonly string[]): Promise<{
  readonly context: ToolInvocationContext;
  readonly config: Agent["config"];
  readonly sessions: SessionStore;
  readonly registry: ToolRegistry;
}> {
  const workspace = await tempWorkspace();
  const config = {
    ...workspace.config,
    agents: {
      ...workspace.config.agents,
      default: { ...workspace.config.agents.default, tools: [...toolNames] }
    },
    permissions: {
      tools: Object.fromEntries(toolNames.map(name => [name, "allow" as const]))
    }
  };
  return {
    context: { ...workspace.context, config },
    config: config.agents.default,
    sessions: new SessionStore(workspace.context.dataDir),
    registry: new ToolRegistry()
  };
}

type AppendFaultOptions = {
  readonly failAt: number;
  readonly message: string;
  readonly afterSuccessfulAppend?: (attempt: {
    readonly invocation: number;
    readonly event: ConversationSessionEvent;
  }) => void;
};

export class OneShotAppendFaultSessionStore extends SessionStore {
  private readonly observedAppends: ConversationSessionEvent[] = [];

  constructor(dataDir: string, private readonly fault: AppendFaultOptions) {
    super(dataDir);
  }

  get appendAttempts(): readonly ConversationSessionEvent[] {
    return this.observedAppends;
  }

  override async append(sessionId: string, event: ConversationSessionEvent): Promise<Result<void>> {
    const invocation = this.observedAppends.push(event);
    if (invocation === this.fault.failAt) {
      return err(new StrongCodeError("SESSION_ERROR", this.fault.message));
    }
    const appended = await super.append(sessionId, event);
    if (appended.ok) this.fault.afterSuccessfulAppend?.({ invocation, event });
    return appended;
  }
}

export function scriptedProvider(responses: readonly ModelResponse[], requests: ModelRequest[]): ModelProvider {
  const remaining = [...responses];
  return {
    name: "scripted",
    async complete(request) {
      requests.push(request);
      const response = remaining.shift();
      if (response === undefined) throw new StrongCodeError("MODEL_ERROR", "Scripted model exhausted");
      return response;
    }
  };
}

export function continuationAgent(config: Agent["config"], model: ModelProvider): Agent {
  return { name: "default", config, model, systemPrompt: "Trusted system instructions." };
}

export function continuationTool(name: string, content: string, executions: string[]): Tool {
  return {
    name,
    description: `${name} test tool`,
    effect: "unclassified",
    inputSchema: z.unknown(),
    async execute() {
      executions.push(name);
      return ok({ content });
    }
  };
}

export function nextQuestion(broker: QuestionBroker): Promise<PendingQuestion> {
  return new Promise(resolve => {
    broker.subscribe(pending => {
      if (pending !== undefined) resolve(pending);
    });
  });
}
