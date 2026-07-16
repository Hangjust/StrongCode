import type { ConversationItem } from "../core/types";
import { immutableConversationItems } from "./conversation-snapshot";

const PLAN_RECEIPT = Symbol("StrongCodePlanReceipt");
const PLAN_GENERATION = Symbol("StrongCodePlanGeneration");
const APPROVED_PLAN = Symbol("StrongCodeApprovedPlan");

export type PlanReceipt = Readonly<{ readonly [PLAN_RECEIPT]: true }>;
export type PlanGeneration = Readonly<{ readonly [PLAN_GENERATION]: true }>;
export type ApprovedPlan = Readonly<{ readonly [APPROVED_PLAN]: true }>;

type IssuedSnapshot = {
  readonly operationKey: string;
  readonly items: readonly ConversationItem[];
};

type ReceiptCleanup = {
  readonly operationKey: string;
  readonly reference: WeakRef<PlanReceipt>;
};

type ApprovedSnapshot = {
  readonly operationKey: string;
  readonly items: readonly ConversationItem[];
};

const generations = new Map<string, PlanGeneration>();
const receipts = new WeakMap<PlanReceipt, IssuedSnapshot>();
const currentReceipts = new Map<string, WeakRef<PlanReceipt>>();
const approved = new WeakMap<ApprovedPlan, ApprovedSnapshot>();
const receiptFinalizer = new FinalizationRegistry<ReceiptCleanup>(cleanup => {
  if (currentReceipts.get(cleanup.operationKey) === cleanup.reference) {
    currentReceipts.delete(cleanup.operationKey);
  }
});

const PROCESS_HANDOFF_STATE = {
  generations,
  receipts,
  currentReceipts,
  approved,
  receiptFinalizer
};

export class PlanHandoffStore {
  private readonly generations = PROCESS_HANDOFF_STATE.generations;
  private readonly receipts = PROCESS_HANDOFF_STATE.receipts;
  private readonly currentReceipts = PROCESS_HANDOFF_STATE.currentReceipts;
  private readonly approved = PROCESS_HANDOFF_STATE.approved;
  private readonly receiptFinalizer = PROCESS_HANDOFF_STATE.receiptFinalizer;

  begin(operationKey: string): PlanGeneration {
    const currentReference = this.currentReceipts.get(operationKey);
    const currentReceipt = currentReference?.deref();
    if (currentReceipt !== undefined) {
      this.receipts.delete(currentReceipt);
      this.receiptFinalizer.unregister(currentReceipt);
    }
    this.currentReceipts.delete(operationKey);
    const generation = Object.freeze({ [PLAN_GENERATION]: true as const });
    this.generations.set(operationKey, generation);
    return generation;
  }

  issue(operationKey: string, generation: PlanGeneration, items: readonly ConversationItem[]): PlanReceipt | undefined {
    if (this.generations.get(operationKey) !== generation) return undefined;
    this.generations.delete(operationKey);
    const receipt = Object.freeze({ [PLAN_RECEIPT]: true as const });
    const reference = new WeakRef(receipt);
    this.receipts.set(receipt, { operationKey, items: immutableConversationItems(items) });
    this.currentReceipts.set(operationKey, reference);
    this.receiptFinalizer.register(receipt, { operationKey, reference }, receipt);
    return receipt;
  }

  retire(operationKey: string, generation: PlanGeneration): void {
    if (this.generations.get(operationKey) === generation) this.generations.delete(operationKey);
  }

  consume(operationKey: string, receipt: PlanReceipt): ApprovedPlan | undefined {
    const snapshot = this.receipts.get(receipt);
    if (snapshot?.operationKey !== operationKey) return undefined;
    this.receipts.delete(receipt);
    this.receiptFinalizer.unregister(receipt);
    if (this.currentReceipts.get(operationKey)?.deref() === receipt) {
      this.currentReceipts.delete(operationKey);
    }
    const approved = Object.freeze({ [APPROVED_PLAN]: true as const });
    this.approved.set(approved, { operationKey, items: snapshot.items });
    return approved;
  }

  take(operationKey: string, approved: ApprovedPlan): readonly ConversationItem[] | undefined {
    const snapshot = this.approved.get(approved);
    if (!snapshot || snapshot.operationKey !== operationKey) return undefined;
    this.approved.delete(approved);
    return snapshot.items;
  }

  discard(approved: ApprovedPlan): void {
    this.approved.delete(approved);
  }
}
