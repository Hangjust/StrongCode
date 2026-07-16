import type {
  PreflightClock,
  PreflightStage,
  PreflightTraceCode,
  PreflightTraceEvent
} from "./scheduler-types";

export type PreflightTraceDraft = Readonly<{
  kind: PreflightTraceEvent["kind"];
  stage: PreflightStage;
  code: PreflightTraceCode;
  attemptId?: string;
  sourceIndex?: number;
  decision?: "allow" | "deny";
}>;

export type PreflightTraceWriterOptions = Readonly<{
  runId: string;
  generation: number;
  clock: PreflightClock;
  callback?: (event: PreflightTraceEvent) => void;
}>;

export function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export class PreflightTraceWriter {
  private sequence = 0;

  constructor(private readonly options: PreflightTraceWriterOptions) {}

  emit(draft: PreflightTraceDraft): PreflightTraceEvent {
    const event = deepFreeze({
      kind: draft.kind,
      runId: this.options.runId,
      generation: this.options.generation,
      sequence: ++this.sequence,
      timestamp: this.options.clock.now(),
      stage: draft.stage,
      code: draft.code,
      ...(draft.attemptId === undefined ? {} : { attemptId: draft.attemptId }),
      ...(draft.sourceIndex === undefined ? {} : { sourceIndex: draft.sourceIndex }),
      ...(draft.decision === undefined ? {} : { decision: draft.decision })
    });
    const callback = this.options.callback;
    if (callback === undefined) return event;
    try {
      callback(event);
    } catch {
      // no-excuse-ok: catch -- trace observers are untrusted and cannot affect scheduler work.
      return event;
    }
    return event;
  }
}
