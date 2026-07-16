import type { Result } from "../../core/result";
import type { PreflightTerminalOutcome } from "./scheduler-types";

export type PreflightRunIdentity = Readonly<{
  sourceMessageId: string;
  originalPrompt: string;
}>;

export type PreflightLiveRun = Readonly<{
  runId: string;
  reservationId: string;
  logicalOperationId: string;
  identity: PreflightRunIdentity;
  done: Promise<Result<PreflightTerminalOutcome>>;
}>;

export type PreflightRegistryAdmission =
  | Readonly<{ kind: "created"; entry: PreflightLiveRun }>
  | Readonly<{ kind: "joined"; entry: PreflightLiveRun }>
  | Readonly<{ kind: "conflict"; entry: PreflightLiveRun }>;

function sameIdentity(left: PreflightRunIdentity, right: PreflightRunIdentity): boolean {
  return left.sourceMessageId === right.sourceMessageId && left.originalPrompt === right.originalPrompt;
}

export class PreflightRunRegistry {
  private readonly entries = new Map<string, PreflightLiveRun>();
  private readonly admissionTails = new Map<string, Promise<void>>();

  get size(): number {
    return this.entries.size;
  }

  get(operationKey: string): PreflightLiveRun | undefined {
    return this.entries.get(operationKey);
  }

  async admit(
    operationKey: string,
    identity: PreflightRunIdentity,
    create: () => PreflightLiveRun | Promise<PreflightLiveRun>
  ): Promise<PreflightRegistryAdmission> {
    return this.serialize(operationKey, async () => {
      const existing = this.entries.get(operationKey);
      if (existing !== undefined) {
        return sameIdentity(existing.identity, identity)
          ? { kind: "joined", entry: existing }
          : { kind: "conflict", entry: existing };
      }
      const entry = Object.freeze(await create());
      this.entries.set(operationKey, entry);
      void entry.done.finally(() => this.remove(operationKey, entry.runId));
      return { kind: "created", entry };
    });
  }

  remove(operationKey: string, runId: string): boolean {
    const existing = this.entries.get(operationKey);
    if (existing?.runId !== runId) return false;
    return this.entries.delete(operationKey);
  }

  private async serialize<T>(operationKey: string, action: () => Promise<T>): Promise<T> {
    const previous = this.admissionTails.get(operationKey) ?? Promise.resolve();
    let release = (): void => undefined;
    const barrier = new Promise<void>(resolve => {
      release = resolve;
    });
    const tail = previous.then(() => barrier);
    this.admissionTails.set(operationKey, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.admissionTails.get(operationKey) === tail) this.admissionTails.delete(operationKey);
    }
  }
}
