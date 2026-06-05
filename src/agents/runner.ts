import { AgentRunResult, ToolExecution } from "../core/types";
import { ModelResponse } from "../models/provider";
import { StrongCodeError } from "../core/errors";
import { err, ok, Result } from "../core/result";
import { createRuntimeEvent, RuntimeEventSink } from "../runtime/events";
import { SessionStore } from "../sessions/session-store";
import { eventsToMessages, messageEvent, toolEvent } from "../sessions/session";
import { assertToolAllowed } from "../tools/permissions";
import { ToolRegistry } from "../tools/registry";
import { Agent } from "./agent";
import { RuntimeContext } from "../runtime/context";

export interface AgentRunnerOptions {
  maxToolCalls: number;
  emit?: RuntimeEventSink;
}

export class AgentRunner {
  private readonly maxToolCalls: number;
  private readonly emit: RuntimeEventSink;

  constructor(
    private readonly context: RuntimeContext,
    private readonly sessions: SessionStore,
    private readonly tools: ToolRegistry,
    options: AgentRunnerOptions = { maxToolCalls: 4 }
  ) {
    this.maxToolCalls = options.maxToolCalls;
    this.emit = options.emit ?? context.emit;
  }

  async run(agent: Agent, prompt: string, sessionId: string): Promise<Result<AgentRunResult>> {
    this.emit(createRuntimeEvent("run_started", `Starting session ${sessionId}`));

    const beforeSession = await this.sessions.readOrEmpty(sessionId);
    if (!beforeSession.ok) {
      return beforeSession;
    }

    const userEvent = messageEvent("user", prompt);
    const appendedUser = await this.sessions.append(sessionId, userEvent);
    if (!appendedUser.ok) {
      return appendedUser;
    }

    let modelResponse: ModelResponse;
    try {
      modelResponse = await agent.model.complete({
        prompt,
        sessionId,
        messages: eventsToMessages([...beforeSession.value.events, userEvent]),
        tools: agent.config.tools
      });
    } catch (error) {
      return err(error instanceof StrongCodeError ? error : new StrongCodeError("MODEL_ERROR", error instanceof Error ? error.message : String(error)));
    }

    if (modelResponse.toolCalls.length > this.maxToolCalls) {
      return err(new StrongCodeError("MODEL_ERROR", `Model requested ${modelResponse.toolCalls.length} tools, limit is ${this.maxToolCalls}`));
    }

    const toolExecutions: ToolExecution[] = [];
    for (const toolCall of modelResponse.toolCalls) {
      if (!agent.config.tools.includes(toolCall.name)) {
        return err(new StrongCodeError("PERMISSION_DENIED", `Tool '${toolCall.name}' is not enabled for agent '${agent.name}'`));
      }

      const allowed = assertToolAllowed(this.context.config, toolCall.name);
      if (!allowed.ok) {
        return allowed;
      }

      const tool = this.tools.get(toolCall.name);
      if (!tool) {
        return err(new StrongCodeError("TOOL_NOT_FOUND", `Tool not found: ${toolCall.name}`));
      }

      this.emit(createRuntimeEvent("tool_started", `Running ${tool.name}`));
      const result = await tool.execute(toolCall.input, this.context);
      if (!result.ok) {
        return result;
      }

      const execution: ToolExecution = {
        tool: tool.name,
        input: toolCall.input,
        output: result.value.content
      };
      toolExecutions.push(execution);
      const appendedTool = await this.sessions.append(sessionId, toolEvent(execution));
      if (!appendedTool.ok) {
        return appendedTool;
      }
      this.emit(createRuntimeEvent("tool_finished", `Finished ${tool.name}`));
    }

    const assistantMessage = [
      modelResponse.message,
      ...toolExecutions.map(execution => `\n${execution.tool}:\n${execution.output}`)
    ].join("").trim();

    const appendedAssistant = await this.sessions.append(sessionId, messageEvent("assistant", assistantMessage));
    if (!appendedAssistant.ok) {
      return appendedAssistant;
    }

    this.emit(createRuntimeEvent("run_finished", `Finished session ${sessionId}`));
    return ok({
      sessionId,
      response: assistantMessage,
      toolExecutions
    });
  }
}
