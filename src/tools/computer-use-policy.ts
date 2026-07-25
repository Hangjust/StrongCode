import type { AgentRuntimeRole } from "../agents/agent";
import { StrongCodeError } from "../core/errors";
import { err, ok, type Result } from "../core/result";
import type { ToolInvocationContext } from "../runtime/context";

export const OPEN_COMPUTER_USE_SERVER_ID = "open_computer_use";
export const OPEN_COMPUTER_USE_TOOL_PREFIX = "mcp__open_computer_use__";

const COMPUTER_USE_DIRECTIVE = /^\/computer\s+use(?:\s|$)/i;
const COMPUTER_REQUEST = /^(?:please\s+)?(?:use|control|operate|navigate)\s+(?:my\s+|the\s+|this\s+)?(?:computer|desktop)(?=\s+(?:to|and)\b|[.!?,;:]|$)/i;
const POLITE_COMPUTER_REQUEST = /^(?:please\s+)?(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:use|control|operate|navigate|interact\s+with)\s+(?:my\s+|the\s+|this\s+)?(?:computer|desktop)(?=\s+(?:to|and)\b|[.!?,;:]|$)/i;
const NEGATED_COMPUTER_REQUEST = /\b(?:do\s+not|don't|dont|never|avoid|without)\b[^.!?\n]{0,80}\b(?:use|control|operate|navigate|interact\s+with)?\s*(?:my\s+|the\s+|this\s+)?(?:computer|desktop|computer[\s-]+use)\b/i;
const EXPLANATION_ONLY_REQUEST = /\b(?:explain|describe|document|discuss|research|review)\b[^.!?\n]{0,80}\bcomputer[\s-]+use\b/i;

export function computerUseRequested(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (COMPUTER_USE_DIRECTIVE.test(trimmed)) return true;
  if (NEGATED_COMPUTER_REQUEST.test(trimmed) || EXPLANATION_ONLY_REQUEST.test(trimmed)) return false;
  return COMPUTER_REQUEST.test(trimmed)
    || POLITE_COMPUTER_REQUEST.test(trimmed);
}

export function computerUseEnabled(context: ToolInvocationContext): boolean {
  return context.computerUse === "explicit-user-request";
}

export function withComputerUseEnabled(context: ToolInvocationContext): ToolInvocationContext {
  return { ...context, computerUse: "explicit-user-request" };
}

export function deriveComputerUseTurnContext(
  context: ToolInvocationContext,
  runtimeRole: AgentRuntimeRole,
  prompt: string
): ToolInvocationContext {
  const { computerUse: _computerUse, ...contextWithoutComputerUse } = context;
  return runtimeRole === "primary"
    && context.taskId === undefined
    && computerUseRequested(prompt)
    ? withComputerUseEnabled(contextWithoutComputerUse)
    : contextWithoutComputerUse;
}

export function isOpenComputerUseTool(toolName: string): boolean {
  return toolName.startsWith(OPEN_COMPUTER_USE_TOOL_PREFIX);
}

export function assertComputerUseEnabled(
  context: ToolInvocationContext
): Result<void> {
  return computerUseEnabled(context)
    ? ok(undefined)
    : err(new StrongCodeError(
      "PERMISSION_DENIED",
      "Open Computer Use requires an explicit request in the current user turn or /computer use"
    ));
}
