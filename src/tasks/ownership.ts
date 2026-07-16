import path from "node:path";
import { StrongCodeError } from "../core/errors";
import { err, ok, type Result } from "../core/result";
import type { RuntimeContext, ToolInvocationContext } from "../runtime/context";
import { resolveWorkspaceMutationPath } from "../tools/builtin/list-files";

export type WriteOwnershipRequest = {
  readonly context: RuntimeContext;
  readonly ownerId: string;
  readonly writePaths: readonly string[];
};

export type WriteOwnershipReservation = {
  readonly ownerId: string;
  readonly paths: readonly string[];
  release(): void;
};

type ActiveReservation = {
  readonly token: symbol;
  readonly paths: readonly string[];
};

function comparable(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function contains(ancestor: string, target: string): boolean {
  const relative = path.relative(comparable(ancestor), comparable(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function overlaps(left: string, right: string): boolean {
  return contains(left, right) || contains(right, left);
}

export function assertMutationOwnership(context: ToolInvocationContext, canonicalTarget: string): Result<void> {
  if (!context.taskId) return ok(undefined);
  if (context.ownership?.some(ownedPath => contains(ownedPath, canonicalTarget))) return ok(undefined);
  return err(new StrongCodeError("PERMISSION_DENIED", `Child task '${context.taskId}' does not own mutation path '${canonicalTarget}'`));
}

export function assertWorkspaceOwnership(context: ToolInvocationContext, canonicalWorkspaceRoot: string): Result<void> {
  if (!context.taskId) return ok(undefined);
  if (context.ownership?.some(ownedPath => comparable(ownedPath) === comparable(canonicalWorkspaceRoot))) return ok(undefined);
  return err(new StrongCodeError("PERMISSION_DENIED", `Child task '${context.taskId}' requires exclusive ownership of '.' to run a process`));
}

export class WriteOwnershipRegistry {
  private readonly active = new Map<string, ActiveReservation>();

  async withReservation<T>(
    request: WriteOwnershipRequest,
    operation: (reservation: WriteOwnershipReservation) => Promise<T>
  ): Promise<Result<T>> {
    const reserved = await this.reserve(request);
    if (!reserved.ok) return reserved;
    try {
      return ok(await operation(reserved.value));
    } finally {
      reserved.value.release();
    }
  }

  async reserve(request: WriteOwnershipRequest): Promise<Result<WriteOwnershipReservation>> {
    if (!request.ownerId.trim() || request.writePaths.length === 0) {
      return err(new StrongCodeError("VALIDATION_ERROR", "Write ownership requires an owner id and at least one path"));
    }
    const resolved = await Promise.all(request.writePaths.map(writePath => resolveWorkspaceMutationPath(request.context, writePath)));
    const failed = resolved.find(result => !result.ok);
    if (failed && !failed.ok) return failed;
    const paths = resolved.flatMap(result => result.ok ? [result.value] : []);
    for (let index = 0; index < paths.length; index += 1) {
      for (let other = index + 1; other < paths.length; other += 1) {
        const left = paths[index];
        const right = paths[other];
        if (left && right && overlaps(left, right)) {
          return err(new StrongCodeError("PERMISSION_DENIED", `Write ownership paths overlap: '${left}' and '${right}'`));
        }
      }
    }
    if (this.active.has(request.ownerId)) {
      return err(new StrongCodeError("PERMISSION_DENIED", `Writer '${request.ownerId}' already has an active reservation`));
    }
    for (const active of this.active.values()) {
      const conflict = paths.find(candidate => active.paths.some(ownedPath => overlaps(candidate, ownedPath)));
      if (conflict) {
        return err(new StrongCodeError("PERMISSION_DENIED", `Write path '${conflict}' overlaps an active writer`));
      }
    }

    const frozenPaths = Object.freeze([...paths]);
    const token = Symbol(request.ownerId);
    this.active.set(request.ownerId, { token, paths: frozenPaths });
    let released = false;
    return ok(Object.freeze({
      ownerId: request.ownerId,
      paths: frozenPaths,
      release: () => {
        if (released) return;
        released = true;
        if (this.active.get(request.ownerId)?.token === token) this.active.delete(request.ownerId);
      }
    }));
  }
}
