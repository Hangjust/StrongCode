import type {
  AttemptCreatedEvent,
  AttemptLifecycleEvent,
  AttemptUsageEvent
} from "./session-ledger-events";
import { LedgerProjectionError } from "./session-ledger-errors";
import type { AttemptStatus } from "./session-ledger-projection";

export type MutableAttempt = {
  created: AttemptCreatedEvent;
  status: AttemptStatus;
  started: boolean;
  usage?: AttemptUsageEvent;
};

export type ProviderIdentityOwners = Readonly<{
  requests: Map<string, string>;
  responses: Map<string, string>;
}>;

function assertNever(value: never): never {
  throw new LedgerProjectionError("semantic-conflict", `Unexpected attempt transition: ${JSON.stringify(value)}`);
}

export function applyLifecycle(attempt: MutableAttempt, event: AttemptLifecycleEvent): void {
  const transition = event.transition;
  switch (transition.kind) {
    case "started":
      if (attempt.status.kind !== "created") throw new LedgerProjectionError("invalid-transition", "Attempt cannot start from its current state");
      attempt.status = { kind: "started" };
      attempt.started = true;
      return;
    case "validation_failed":
      if (attempt.status.kind !== "started") throw new LedgerProjectionError("invalid-transition", "Validation failure requires a started attempt");
      attempt.status = { kind: "validation-failed", code: transition.code };
      return;
    case "cancelled":
      if (attempt.status.kind !== "created" && attempt.status.kind !== "started") {
        throw new LedgerProjectionError("invalid-transition", "Attempt cannot be cancelled from its current state");
      }
      attempt.status = { kind: "cancelled", code: transition.code };
      return;
    case "ended":
      if (attempt.status.kind !== "started") throw new LedgerProjectionError("invalid-transition", "Attempt end requires a started attempt");
      attempt.status = transition.outcome === "succeeded"
        ? { kind: "succeeded" }
        : { kind: "failed", code: transition.code };
      return;
    default: return assertNever(transition);
  }
}

function identityKey(providerRef: string, identity: string): string {
  return `${providerRef}\u0000${identity}`;
}

function assertIdentityAvailable(
  owners: ReadonlyMap<string, string>,
  providerRef: string,
  identity: string | undefined,
  attemptId: string
): void {
  if (identity === undefined) return;
  const owner = owners.get(identityKey(providerRef, identity));
  if (owner !== undefined && owner !== attemptId) {
    throw new LedgerProjectionError("semantic-conflict", "Provider identity is already owned by another attempt");
  }
}

export function applyUsage(
  attempt: MutableAttempt,
  usage: AttemptUsageEvent,
  identities: ProviderIdentityOwners
): void {
  if (usage.providerRef !== attempt.created.model.providerRef || usage.modelRef !== attempt.created.model.modelRef) {
    throw new LedgerProjectionError("semantic-conflict", "Usage provider/model identity differs from attempt creation");
  }
  if (usage.cost?.kind === "estimated") {
    const pricing = attempt.created.model.pricing;
    if (pricing === undefined || pricing.version !== usage.cost.pricingVersion || pricing.currency !== usage.cost.currency) {
      throw new LedgerProjectionError("semantic-conflict", "Estimated cost does not match the stored pricing snapshot");
    }
  }
  assertIdentityAvailable(identities.requests, usage.providerRef, usage.providerRequestId, usage.attemptId);
  assertIdentityAvailable(identities.responses, usage.providerRef, usage.providerResponseId, usage.attemptId);
  if (usage.providerRequestId !== undefined) {
    identities.requests.set(identityKey(usage.providerRef, usage.providerRequestId), usage.attemptId);
  }
  if (usage.providerResponseId !== undefined) {
    identities.responses.set(identityKey(usage.providerRef, usage.providerResponseId), usage.attemptId);
  }
  attempt.usage = usage;
}
