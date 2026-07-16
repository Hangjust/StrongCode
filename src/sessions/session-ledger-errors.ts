export type LedgerRejectionReason = "stale" | "semantic-conflict" | "invalid-transition" | "invalid-lineage";

export class LedgerProjectionError extends Error {
  readonly name = "LedgerProjectionError";

  constructor(readonly reason: LedgerRejectionReason, message: string) {
    super(message);
  }
}
