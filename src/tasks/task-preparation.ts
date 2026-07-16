import { createHash, randomUUID } from "node:crypto";
import { resolveSpawnTarget, type SpawnTarget } from "../agents/spawn-targets";
import type { DelegationConfig } from "../config/runtime-config";
import { StrongCodeError, toStrongCodeError } from "../core/errors";
import { err, ok, type Result } from "../core/result";
import type { ChildFactoryInput } from "../runtime/child-factory";
import type { ChildExecutionPolicy } from "../tools/child-policy";
import { boundTaskText, TASK_ERROR_MESSAGE_MAX_UNITS } from "./text-bounds";
import type { ForegroundTaskRequest, PreparedTask, TaskManagerOptions } from "./task-manager-types";
import type { TaskRecord } from "./types";

export function taskError(error: unknown): StrongCodeError {
  const converted = toStrongCodeError(error, "TASK_ERROR");
  return new StrongCodeError(converted.code, boundTaskText(converted.message, TASK_ERROR_MESSAGE_MAX_UNITS) || converted.code);
}

export function policyHash(policy: ChildExecutionPolicy): string {
  const permissions = Object.entries(policy.permissions).sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify({ permissions, tools: [...policy.tools].sort() })).digest("hex");
}

export function prepareTask(input: {
  readonly options: TaskManagerOptions;
  readonly limits: DelegationConfig;
  readonly request: ForegroundTaskRequest;
  readonly mode: "foreground" | "background";
}): Result<PreparedTask> {
  const { options, limits, request, mode } = input;
  if (!limits.enabled) return err(new StrongCodeError("TASK_ERROR", "Delegation is disabled"));
  let target: SpawnTarget;
  try {
    target = resolveSpawnTarget(request.target, request.origin);
  } catch (error) {
    return err(taskError(error instanceof Error ? error : String(error)));
  }
  const createdAt = new Date().toISOString();
  const queuedRecord: TaskRecord = {
    id: `task-${randomUUID()}`,
    childSessionId: `child-${randomUUID()}`,
    parentSessionId: request.parentSessionId,
    rootSessionId: request.rootSessionId,
    target: { class: target.kind, id: target.id },
    attempt: 1,
    depth: 1,
    mode,
    effectivePolicyHash: policyHash(request.policy),
    skillReceipts: request.skills.receipts.map(receipt => ({ id: receipt.id, path: receipt.path, hash: receipt.sha256 })),
    ownedPaths: [],
    timestamps: { createdAt, updatedAt: createdAt },
    status: "queued"
  };
  const childInput: ChildFactoryInput = {
    config: options.context.config,
    target,
    catalog: options.catalog,
    trustedInstructions: options.trustedInstructions,
    skills: request.skills,
    policy: request.policy,
    taskUserContent: request.taskUserContent,
    ...(options.providerOptions === undefined ? {} : { providerOptions: options.providerOptions })
  };
  return ok({
    target,
    queuedRecord,
    childInput,
    writePaths: Object.freeze([...request.writePaths]),
    timeoutMs: request.timeoutMs ?? limits.defaultTimeoutMs
  });
}

export function linkedController(parentSignal?: AbortSignal): {
  readonly controller: AbortController;
  readonly cleanup: () => void;
} {
  const controller = new AbortController();
  const abort = (): void => controller.abort(parentSignal?.reason);
  if (parentSignal) {
    if (parentSignal.aborted) abort();
    else parentSignal.addEventListener("abort", abort, { once: true });
  }
  return Object.freeze({ controller, cleanup: () => parentSignal?.removeEventListener("abort", abort) });
}
