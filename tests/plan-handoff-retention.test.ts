import type { ConversationItem } from "../src/core/types";
import type { PlanReceipt } from "../src/agents/plan-handoff";

const PLAN_ITEMS = [
  { type: "text", role: "assistant", content: "Approved plan" }
] satisfies readonly ConversationItem[];

const CURRENT_INDEX_FIELDS = ["currentReceipts", "current"] as const;

type CleanupCallback = (heldValue: unknown) => void;
type FinalizerRegistration = {
  readonly target: object;
  readonly heldValue: unknown;
  readonly unregisterToken: object | undefined;
};

let capturedCleanup: CleanupCallback | undefined;
const finalizerRegistrations: FinalizerRegistration[] = [];

class CapturingFinalizationRegistry {
  constructor(cleanup: CleanupCallback) {
    capturedCleanup = cleanup;
  }

  register(target: object, heldValue: unknown, unregisterToken?: object): void {
    finalizerRegistrations.push({ target, heldValue, unregisterToken });
  }

  unregister(): boolean {
    return true;
  }
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Expected ${label}`);
  return value;
}

function privateMap(owner: object, field: string): Map<unknown, unknown> {
  const value: unknown = Reflect.get(owner, field);
  if (!(value instanceof Map)) throw new Error(`Expected ${field} to be a Map`);
  return value;
}

function privateWeakMap(owner: object, field: string): WeakMap<object, unknown> {
  const value: unknown = Reflect.get(owner, field);
  if (!(value instanceof WeakMap)) throw new Error(`Expected ${field} to be a WeakMap`);
  return value;
}

function currentIndexes(owner: object): Map<unknown, unknown> {
  for (const field of CURRENT_INDEX_FIELDS) {
    const value: unknown = Reflect.get(owner, field);
    if (value instanceof Map) return value;
  }
  throw new Error("Expected a current receipt index Map");
}

function weakTarget(value: unknown): object | undefined {
  if (!(value instanceof WeakRef)) throw new Error("Expected current receipt index value to be a WeakRef");
  return value.deref();
}

async function freshStore() {
  const { PlanHandoffStore } = await import("../src/agents/plan-handoff");
  return new PlanHandoffStore();
}

afterEach(() => {
  capturedCleanup = undefined;
  finalizerRegistrations.length = 0;
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("plan handoff weak receipt retention", () => {
  it("keys issued snapshots by receipt in a WeakMap", async () => {
    // Given
    const store = await freshStore();
    const generation = store.begin("receipt-owned");

    // When
    const receipt = required(store.issue("receipt-owned", generation, PLAN_ITEMS), "issued receipt");

    // Then
    const snapshots = privateWeakMap(store, "receipts");
    const snapshot = snapshots.get(receipt);
    if (typeof snapshot !== "object" || snapshot === null) throw new Error("Expected receipt snapshot");
    expect(Reflect.get(snapshot, "operationKey")).toBe("receipt-owned");
    expect(Reflect.get(snapshot, "items")).toEqual(PLAN_ITEMS);
  });

  it("indexes the current operation receipt through a WeakRef", async () => {
    // Given
    const store = await freshStore();
    const generation = store.begin("weak-current");

    // When
    const receipt = required(store.issue("weak-current", generation, PLAN_ITEMS), "issued receipt");

    // Then
    const current = currentIndexes(store);
    expect(current.size).toBe(1);
    expect(weakTarget(current.get("weak-current"))).toBe(receipt);
  });

  it("leaves no generations or current indexes after 10,000 issue and consume cycles", async () => {
    // Given
    const store = await freshStore();

    // When
    for (let index = 0; index < 10_000; index += 1) {
      const key = `consumed-${index}`;
      const receipt = required(store.issue(key, store.begin(key), PLAN_ITEMS), "issued receipt");
      required(store.consume(key, receipt), "approved plan");
    }

    // Then
    expect(privateMap(store, "generations").size).toBe(0);
    expect(currentIndexes(store).size).toBe(0);
  });

  it("keeps one weak current entry and revokes every prior same-key receipt", async () => {
    // Given
    const store = await freshStore();
    const key = "replaced";
    const priorReceipts: PlanReceipt[] = [];
    let currentReceipt = required(store.issue(key, store.begin(key), PLAN_ITEMS), "initial receipt");

    // When
    for (let index = 1; index < 10_000; index += 1) {
      priorReceipts.push(currentReceipt);
      currentReceipt = required(store.issue(key, store.begin(key), PLAN_ITEMS), "replacement receipt");
    }

    // Then
    const current = currentIndexes(store);
    expect(current.size).toBe(1);
    expect(weakTarget(current.get(key))).toBe(currentReceipt);
    expect(priorReceipts.every(receipt => store.consume(key, receipt) === undefined)).toBe(true);
    expect(store.consume(key, currentReceipt)).toBeDefined();
  });

  it("creates no strong receipt or transcript collection for 10,000 unique abandoned receipts", async () => {
    // Given
    const store = await freshStore();

    // When
    for (let index = 0; index < 10_000; index += 1) {
      const key = `abandoned-${index}`;
      required(store.issue(key, store.begin(key), PLAN_ITEMS), "issued receipt");
    }

    // Then
    expect(privateMap(store, "generations").size).toBe(0);
    expect(privateWeakMap(store, "receipts")).toBeInstanceOf(WeakMap);
    const current = currentIndexes(store);
    expect(current.size).toBe(10_000);
    expect([...current.values()].every(value => value instanceof WeakRef)).toBe(true);
  });

  it("does not let a stale finalizer callback delete a newer same-key replacement", async () => {
    // Given
    vi.stubGlobal("FinalizationRegistry", CapturingFinalizationRegistry);
    const store = await freshStore();
    const key = "finalizer-race";
    const oldReceipt = required(store.issue(key, store.begin(key), PLAN_ITEMS), "old receipt");
    const oldRegistration = required(
      finalizerRegistrations.find(registration => registration.target === oldReceipt),
      "old receipt finalizer registration"
    );
    const cleanup = required(capturedCleanup, "receipt finalizer cleanup callback");
    const currentReceipt = required(store.issue(key, store.begin(key), PLAN_ITEMS), "current receipt");

    // When
    cleanup(oldRegistration.heldValue);

    // Then
    expect(weakTarget(currentIndexes(store).get(key))).toBe(currentReceipt);
    expect(store.consume(key, oldReceipt)).toBeUndefined();
    expect(store.consume(key, currentReceipt)).toBeDefined();
  });
});
