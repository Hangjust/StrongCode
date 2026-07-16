import { SessionOperationCoordinator } from "../src/agents/session-operation-coordinator";

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>(resolve => {
    resolvePromise = resolve;
  });
  if (resolvePromise === undefined) throw new Error("Deferred resolver was not initialized");
  return { promise, resolve: resolvePromise };
}

describe("session operation coordinator", () => {
  it("executes operations for one key exclusively in admission order", async () => {
    const coordinator = new SessionOperationCoordinator();
    const releaseFirst = deferred<void>();
    const firstStarted = deferred<void>();
    const order: string[] = [];

    const first = coordinator.enqueue("fifo", async () => {
      order.push("first:start");
      firstStarted.resolve(undefined);
      await releaseFirst.promise;
      order.push("first:end");
    });
    const second = coordinator.enqueue("fifo", async () => {
      order.push("second");
    });
    const third = coordinator.enqueue("fifo", async () => {
      order.push("third");
    });
    await firstStarted.promise;

    expect(order).toEqual(["first:start"]);
    releaseFirst.resolve(undefined);
    await Promise.all([first, second, third]);
    expect(order).toEqual(["first:start", "first:end", "second", "third"]);
  });

  it("continues the FIFO after a rejected operation", async () => {
    const coordinator = new SessionOperationCoordinator();
    const releaseFirst = deferred<void>();
    const firstStarted = deferred<void>();
    const order: string[] = [];

    const first = coordinator.enqueue("recovery", async () => {
      order.push("first");
      firstStarted.resolve(undefined);
      await releaseFirst.promise;
      throw new Error("expected rejection");
    });
    const second = coordinator.enqueue("recovery", async () => {
      order.push("second");
    });
    const third = coordinator.enqueue("recovery", async () => {
      order.push("third");
    });
    await firstStarted.promise;

    releaseFirst.resolve(undefined);
    await expect(first).rejects.toThrow("expected rejection");
    await Promise.all([second, third]);
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("serializes the same key across coordinator instances", async () => {
    const firstCoordinator = new SessionOperationCoordinator();
    const secondCoordinator = new SessionOperationCoordinator();
    const releaseFirst = deferred<void>();
    const firstStarted = deferred<void>();
    const order: string[] = [];

    const first = firstCoordinator.enqueue("shared-instance-key", async () => {
      order.push("first:start");
      firstStarted.resolve(undefined);
      await releaseFirst.promise;
      order.push("first:end");
    });
    const second = secondCoordinator.enqueue("shared-instance-key", async () => {
      order.push("second");
    });
    await firstStarted.promise;

    expect(order).toEqual(["first:start"]);
    releaseFirst.resolve(undefined);
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("allows different keys to overlap", async () => {
    const coordinator = new SessionOperationCoordinator();
    const release = deferred<void>();
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();

    const first = coordinator.enqueue("key-a", async () => {
      firstStarted.resolve(undefined);
      await release.promise;
    });
    const second = coordinator.enqueue("key-b", async () => {
      secondStarted.resolve(undefined);
      await release.promise;
    });

    await Promise.all([firstStarted.promise, secondStarted.promise]);
    release.resolve(undefined);
    await Promise.all([first, second]);
  });

  it("snapshots running and queued operations until they settle", async () => {
    const coordinator = new SessionOperationCoordinator();
    const releaseFirst = deferred<void>();
    const firstStarted = deferred<void>();

    const first = coordinator.enqueue("pending", async () => {
      firstStarted.resolve(undefined);
      await releaseFirst.promise;
    });
    const second = coordinator.enqueue("pending", async () => undefined);
    await firstStarted.promise;

    expect(coordinator.snapshotPendingOperations()).toEqual([first, second]);
    releaseFirst.resolve(undefined);
    await Promise.all([first, second]);
    expect(coordinator.snapshotPendingOperations()).toEqual([]);
  });
});
