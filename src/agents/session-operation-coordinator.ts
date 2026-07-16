export class SessionOperationCoordinator {
  private static readonly tails = new Map<string, Promise<void>>();
  private readonly pending = new Set<Promise<unknown>>();

  enqueue<T>(operationKey: string, operation: () => Promise<T>): Promise<T> {
    const previous = SessionOperationCoordinator.tails.get(operationKey) ?? Promise.resolve();
    const operationPromise = previous.then(operation);
    this.pending.add(operationPromise);
    const tracked = operationPromise.finally(() => {
      this.pending.delete(operationPromise);
    });
    const settlingGate = tracked.then(() => undefined, () => undefined);
    SessionOperationCoordinator.tails.set(operationKey, settlingGate);
    void settlingGate.then(() => {
      if (SessionOperationCoordinator.tails.get(operationKey) === settlingGate) {
        SessionOperationCoordinator.tails.delete(operationKey);
      }
    });
    return tracked;
  }

  snapshotPendingOperations(): readonly Promise<unknown>[] {
    return [...this.pending];
  }
}
