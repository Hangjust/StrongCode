export type ArchiveErrorReason =
  | "malformed"
  | "unsupported"
  | "unsafe-path"
  | "collision"
  | "limit"
  | "integrity"
  | "ambiguous-root"
  | "filesystem";

export class ArchiveValidationError extends Error {
  readonly name = "ArchiveValidationError";

  constructor(readonly reason: ArchiveErrorReason, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export function invalidArchive(reason: ArchiveErrorReason, message: string): never {
  throw new ArchiveValidationError(reason, message);
}
