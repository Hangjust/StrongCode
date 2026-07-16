import type { StrongCodeError } from "../core/errors";

export type AdmissionCancellation = {
  readonly error: StrongCodeError;
  readonly status: "cancelled" | "timed_out";
};

type AdmissionAttemptOptions = {
  readonly timeoutMs: number;
  readonly timeoutError: StrongCodeError;
  readonly signal?: AbortSignal;
  readonly cancellationError: (reason: unknown) => StrongCodeError;
};

export class AdmissionAttempt {
  readonly deadlineAt: number;
  private readonly timeoutCancellation: AdmissionCancellation;
  private readonly signal: AbortSignal | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private abort: (() => void) | undefined;
  private cancellation: AdmissionCancellation | undefined;
  private cancellationListener: ((cancellation: AdmissionCancellation) => void) | undefined;

  constructor(options: AdmissionAttemptOptions) {
    this.deadlineAt = Date.now() + options.timeoutMs;
    this.timeoutCancellation = { error: options.timeoutError, status: "timed_out" };
    this.signal = options.signal;
    if (options.signal) {
      this.abort = () => this.claim({
        error: options.cancellationError(options.signal?.reason),
        status: "cancelled"
      });
      options.signal.addEventListener("abort", this.abort, { once: true });
      if (options.signal.aborted) this.abort();
    }
    if (!this.cancellation) {
      const remainingMs = Math.max(0, this.deadlineAt - Date.now());
      if (remainingMs === 0) this.claim(this.timeoutCancellation);
      else this.timer = setTimeout(() => this.claim(this.timeoutCancellation), remainingMs);
    }
  }

  currentCancellation(): AdmissionCancellation | undefined {
    if (!this.cancellation && Date.now() >= this.deadlineAt) this.claim(this.timeoutCancellation);
    return this.cancellation;
  }

  onCancellation(listener: (cancellation: AdmissionCancellation) => void): void {
    this.cancellationListener = listener;
    if (this.cancellation) listener(this.cancellation);
  }

  cleanup(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.abort && this.signal) this.signal.removeEventListener("abort", this.abort);
  }

  private claim(cancellation: AdmissionCancellation): void {
    if (this.cancellation) return;
    this.cancellation = cancellation;
    this.cancellationListener?.(cancellation);
  }
}
