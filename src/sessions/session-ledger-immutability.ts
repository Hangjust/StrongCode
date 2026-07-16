export type ImmutableLookup<K, V> = Readonly<{
  size: number;
  get(key: K): V | undefined;
  has(key: K): boolean;
  keys(): IterableIterator<K>;
  values(): IterableIterator<V>;
  entries(): IterableIterator<readonly [K, V]>;
  [Symbol.iterator](): IterableIterator<readonly [K, V]>;
}>;

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const nested of Object.values(value)) deepFreeze(nested);
  Object.freeze(value);
}

export function immutableClone<T>(value: T): T {
  const clone = structuredClone(value);
  deepFreeze(clone);
  return clone;
}

class ImmutableLookupView<K, V> implements ImmutableLookup<K, V> {
  readonly #entries: Map<K, V>;

  constructor(entries: Iterable<readonly [K, V]>) {
    this.#entries = new Map(entries);
    Object.freeze(this);
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: K): V | undefined {
    return this.#entries.get(key);
  }

  has(key: K): boolean {
    return this.#entries.has(key);
  }

  *keys(): IterableIterator<K> {
    yield* this.#entries.keys();
  }

  *values(): IterableIterator<V> {
    yield* this.#entries.values();
  }

  *entries(): IterableIterator<readonly [K, V]> {
    for (const [key, value] of this.#entries) yield Object.freeze([key, value] as const);
  }

  [Symbol.iterator](): IterableIterator<readonly [K, V]> {
    return this.entries();
  }
}

export function immutableLookup<K, V>(entries: Iterable<readonly [K, V]>): ImmutableLookup<K, V> {
  return new ImmutableLookupView(entries);
}
