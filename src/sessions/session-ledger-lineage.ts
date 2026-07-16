import type { AttemptProjection, SessionLedgerProjection } from "./session-ledger-projection";
import type { ImmutableLookup } from "./session-ledger-immutability";

type AttemptLookup = Pick<ImmutableLookup<string, AttemptProjection>, "get" | "has" | "keys" | "values">;

export function validateAttemptLineage(attempts: AttemptLookup): void {
  for (const attempt of attempts.values()) {
    for (const linkedId of [attempt.created.parentAttemptId, attempt.created.forkedFromAttemptId]) {
      if (linkedId === undefined) continue;
      const linked = attempts.get(linkedId);
      if (linkedId === attempt.attemptId || linked === undefined) {
        throw new Error(`Invalid lineage link from '${attempt.attemptId}' to '${linkedId}'`);
      }
      if (linked.created.logicalOperationId !== attempt.created.logicalOperationId) {
        throw new Error(`Attempt lineage crosses logical operations at '${attempt.attemptId}'`);
      }
    }
  }

  const completed = new Set<string>();
  const visit = (attemptId: string, active: ReadonlySet<string>): void => {
    if (completed.has(attemptId)) return;
    if (active.has(attemptId)) throw new Error(`Attempt lineage contains a cycle at '${attemptId}'`);
    const attempt = attempts.get(attemptId);
    if (attempt === undefined) throw new Error(`Attempt '${attemptId}' is missing`);
    const next = new Set(active).add(attemptId);
    for (const linkedId of [attempt.created.parentAttemptId, attempt.created.forkedFromAttemptId]) {
      if (linkedId !== undefined) visit(linkedId, next);
    }
    completed.add(attemptId);
  };
  for (const attemptId of attempts.keys()) visit(attemptId, new Set());
}

function compareAttemptIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function ledgerBreadthFirst(
  projection: SessionLedgerProjection,
  rootAttemptId: string
): readonly AttemptProjection[] {
  if (!projection.attempts.has(rootAttemptId)) throw new Error(`Unknown root attempt '${rootAttemptId}'`);
  const children = new Map<string, string[]>();
  for (const attempt of projection.attempts.values()) {
    const parentId = attempt.created.parentAttemptId;
    if (parentId === undefined) continue;
    const current = children.get(parentId) ?? [];
    current.push(attempt.attemptId);
    children.set(parentId, current);
  }
  for (const childIds of children.values()) childIds.sort(compareAttemptIds);

  const ordered: AttemptProjection[] = [];
  const queue = [rootAttemptId];
  const visited = new Set<string>();
  for (let index = 0; index < queue.length; index += 1) {
    const attemptId = queue[index];
    if (attemptId === undefined || visited.has(attemptId)) continue;
    visited.add(attemptId);
    const attempt = projection.attempts.get(attemptId);
    if (attempt === undefined) throw new Error(`Attempt '${attemptId}' is missing`);
    ordered.push(attempt);
    queue.push(...(children.get(attemptId) ?? []));
  }
  return Object.freeze(ordered);
}
